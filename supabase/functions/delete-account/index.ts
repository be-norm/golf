// Account deletion.
//
// Why a proxy at all: deleting an auth user requires the service-role key,
// which must never ship in the client bundle. The client can delete its own
// ROWS under RLS, but not the auth user itself — and leaving the user behind
// would let them sign back in to an empty account, which is not deletion.
// App Store guideline 5.1.1(v) requires real deletion, not deactivation.
//
// What this deletes: only `auth.users`. Every owned table cascades from there —
// round_archives, players and scan_usage are all `on delete cascade`. Courses
// the user published are deliberately NOT deleted: `courses.created_by` is
// `on delete set null`, so the shared library survives with authorship cleared.
//
// The 30-day grace period: because the delete is hard (which is what frees the
// email for an immediate re-signup), the data is copied into
// `deleted_account_archives` BEFORE the user is removed — that table has no FK
// to auth.users, so it survives the cascade. An admin can reinstate from it by
// re-keying onto the person's new uid. A nightly cron purges it at 30 days.
// Supabase's own soft-delete is deliberately not used: it SHA256-hashes the
// email and is documented as "not reversible", so it would block re-signup
// while destroying exactly the data reinstatement needs.
//
// Archiving is best-effort by design: a failure there must not stop the
// deletion. The user asked to be deleted, and honouring that outranks our
// ability to undo it.
//
// Deno runtime (Supabase Edge Functions). Not part of the Vite app build.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

// --- caller auth: signed-in Supabase users only ----------------------------
// The gateway (verify_jwt=true) validates the token signature; here we decode
// the payload to reject the public anon key and anonymous users, and to read
// the uid to delete. Same shape as ghin-search / extract-scorecard.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    return JSON.parse(atob(b64 + pad))
  } catch {
    return null
  }
}

/**
 * Copy the user's rows into `deleted_account_archives` so an admin can reinstate
 * an accidental deletion inside the retention window.
 *
 * Never throws: the caller asked to be deleted, and a snapshot we keep for OUR
 * convenience must not be the reason that doesn't happen. A failed archive costs
 * the undo, not the deletion.
 *
 * But it must never fail QUIETLY. If the migration hasn't been applied, this is
 * the only thing standing between "we can restore your rounds" (what the app
 * tells the user) and a table that doesn't exist. Every failure path logs at
 * error level so it shows up in the function logs instead of being inferred
 * later from an empty table.
 */
async function archive(
  url: string,
  serviceKey: string,
  uid: string,
  email: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    'Content-Type': 'application/json',
  }

  const read = async (path: string): Promise<unknown[]> => {
    try {
      const res = await fetch(`${url}/rest/v1/${path}`, { headers })
      if (!res.ok) {
        console.error(`[delete-account] archive read failed (${res.status}): ${path}`)
        return []
      }
      return await res.json()
    } catch (e) {
      console.error(`[delete-account] archive read threw: ${path}`, e)
      return []
    }
  }

  try {
    const [rounds, players, savedCourses] = await Promise.all([
      // `deleted_at=is.null` — tombstoned rounds are ones the user deliberately
      // deleted before closing the account. Archiving them would resurrect them
      // on reinstatement.
      read(`round_archives?user_id=eq.${uid}&deleted_at=is.null&select=round_id,data`),
      read(`players?user_id=eq.${uid}&deleted_at=is.null&select=*`),
      // The saved library is owned data too, and cascades away with the user —
      // so reinstatement without it would hand someone back their rounds and an
      // empty course list (MAI-76).
      read(`saved_courses?user_id=eq.${uid}&deleted_at=is.null&select=course_id,data`),
    ])

    // Nothing worth keeping — skip the row rather than bank an empty archive
    // that still holds the email for 30 days.
    if (!rounds.length && !players.length && !savedCourses.length) {
      console.info(`[delete-account] nothing to archive for ${uid}`)
      return
    }

    const res = await fetch(`${url}/rest/v1/deleted_account_archives`, {
      method: 'POST',
      // The same person deleting twice (a retry, or delete → re-signup →
      // delete) must not 409 on the uid primary key.
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        original_user_id: uid,
        email,
        payload: { rounds, players, savedCourses },
      }),
    })

    if (!res.ok) {
      // Most likely cause: migration 20260803000001 not applied. Deletion still
      // proceeds — but the grace period the UI promises does not exist.
      console.error(
        `[delete-account] ARCHIVE WRITE FAILED (${res.status}) for ${uid} — ` +
          `deletion proceeds with NO recovery snapshot. Check the migration is applied. ` +
          (await res.text().catch(() => '')),
      )
    }
  } catch (e) {
    console.error(`[delete-account] archive threw for ${uid} — no recovery snapshot`, e)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const payload = token ? decodeJwtPayload(token) : null
  const role = payload?.role
  const uid = typeof payload?.sub === 'string' ? payload.sub : ''

  // The anon key is a valid JWT with role 'anon' — reject it, and reject
  // anonymous sign-ins, so this can never be called without a real account.
  if (role !== 'authenticated' || !uid || payload?.is_anonymous === true) {
    return json({ error: 'sign-in required' }, 401)
  }

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey) return json({ error: 'server misconfigured' }, 500)

  const email = typeof payload?.email === 'string' ? payload.email : ''
  await archive(url, serviceKey, uid, email)

  // The uid comes from the caller's own verified token, never from the request
  // body — a user can only ever delete themselves.
  const res = await fetch(`${url}/auth/v1/admin/users/${uid}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) {
    // 404 means the user is already gone — treat as success so a retry after a
    // partial failure (deleted remotely, client never got the response) settles.
    if (res.status === 404) return json({ ok: true })
    return json({ error: `delete failed (${res.status})` }, 502)
  }

  return json({ ok: true })
})

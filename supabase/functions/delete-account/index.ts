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

// GHIN golfer-search proxy.
//
// Why a proxy at all: the app is offline-first and otherwise talks only to
// PostgREST, but the (unofficial) GHIN mobile API at api2.ghin.com (a) requires
// a member login to mint a bearer token and (b) isn't CORS-open, so a browser
// PWA can't call it directly — and we must never ship GHIN credentials in the
// client bundle. This Edge Function holds one GHIN login (GHIN_EMAIL /
// GHIN_PASSWORD secrets), caches its token across warm invocations, and exposes
// a single narrow operation: search golfers by name, return name + Handicap
// Index. It is gated to signed-in users (verify_jwt on + a role check) so the
// public anon key can't turn it into an open door to that GHIN account.
//
// Deno runtime (Supabase Edge Functions). Not part of the Vite app build.

const GHIN_BASE = 'https://api2.ghin.com/api/v1'
const CLIENT_SOURCE = 'GHINcom'
// A browser-like UA — the GHIN API rejects some non-browser agents.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

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

interface SearchRequest {
  lastName?: string
  firstName?: string
  state?: string
  /** GHIN requires last_name paired with a state or country; defaults to USA */
  country?: string
  /** exact lookup by GHIN number (used by "refresh handicap") — bypasses name */
  ghinNumber?: string
  page?: number
  perPage?: number
}

export interface GhinPlayerHit {
  ghinNumber: string
  firstName: string
  lastName: string
  fullName: string
  /** numeric Handicap Index, or null for "NH" (no established handicap) */
  handicapIndex: number | null
  /** as GHIN displays it, e.g. "12.5", "+1.2", "NH" */
  handicapDisplay: string
  clubName: string | null
  associationName: string | null
  state: string | null
  status: string | null
}

// --- caller auth: signed-in Supabase users only ----------------------------
// The gateway (verify_jwt=true) already validates the token signature; here we
// only decode the payload to reject the public anon key and anonymous users.
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
 * `ok` — a signed-in, allowlisted user.
 * `unauthenticated` — no/invalid token, the anon key, or an anonymous user.
 * `forbidden` — a real signed-in user who isn't on the GHIN allowlist.
 *
 * GHIN_ALLOWED_UIDS is a comma-separated list of auth uids; when set, only
 * those users may search (keeps random signups off the shared GHIN login).
 * When unset, any authenticated user is allowed (safe default so a missing
 * secret can't lock everyone out).
 */
function callerStatus(req: Request): 'ok' | 'unauthenticated' | 'forbidden' {
  const auth = req.headers.get('Authorization')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return 'unauthenticated'
  const payload = decodeJwtPayload(token)
  if (!payload || payload.role !== 'authenticated' || payload.is_anonymous === true) {
    return 'unauthenticated'
  }
  const allow = (Deno.env.get('GHIN_ALLOWED_UIDS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (allow.length === 0) return 'ok'
  return typeof payload.sub === 'string' && allow.includes(payload.sub) ? 'ok' : 'forbidden'
}

// --- GHIN session -----------------------------------------------------------
// Cached in module scope: warm invocations reuse the token; we re-login on
// expiry or a 401/403 (the token can be invalidated before its JWT `exp`).
let cachedToken: string | null = null
let cachedExp = 0 // unix seconds

async function login(): Promise<string> {
  const email = Deno.env.get('GHIN_EMAIL')
  const password = Deno.env.get('GHIN_PASSWORD')
  if (!email || !password) throw new Error('GHIN credentials not configured')

  const res = await fetch(`${GHIN_BASE}/golfer_login.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    // The top-level `token` only needs to be a non-blank string for this flow.
    body: JSON.stringify({
      token: 'golf-app',
      user: { email_or_ghin: email, password, remember_me: 'true' },
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`GHIN login failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json()) as { golfer_user?: { golfer_user_token?: string } }
  const token = body.golfer_user?.golfer_user_token
  if (!token) throw new Error('GHIN login returned no token')

  cachedToken = token
  cachedExp = (decodeJwtPayload(token)?.exp as number | undefined) ?? 0
  return token
}

async function ensureToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedExp > now + 60) return cachedToken
  return login()
}

/** Exact lookup by GHIN number — no name/state needed; returns 0 or 1 golfer. */
function ghinLookupUrl(ghinNumber: string): string {
  const qs = new URLSearchParams({
    golfer_id: ghinNumber,
    page: '1',
    per_page: '1',
    source: CLIENT_SOURCE,
  })
  return `${GHIN_BASE}/golfers/search.json?${qs.toString()}`
}

function ghinSearchUrl(params: SearchRequest): string {
  const perPage = Math.min(Math.max(params.perPage ?? 25, 1), 100)
  const qs = new URLSearchParams({
    status: 'Active',
    sorting_criteria: 'last_name_first_name',
    order: 'asc',
    page: String(params.page ?? 1),
    per_page: String(perPage),
    source: CLIENT_SOURCE,
  })
  if (params.lastName) qs.set('last_name', params.lastName)
  if (params.firstName) qs.set('first_name', params.firstName)
  // GHIN rejects a bare last_name — it must be paired with a state or country.
  // A state (when given) narrows results; otherwise fall back to a country.
  if (params.state) qs.set('state', params.state)
  else qs.set('country', params.country ?? 'USA')
  // GHIN's upstream parser doesn't decode '+' to space — encode spaces as %20.
  return `${GHIN_BASE}/golfers/search.json?${qs.toString().replace(/\+/g, '%20')}`
}

async function callSearch(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      source: CLIENT_SOURCE,
      'User-Agent': USER_AGENT,
    },
  })
}

interface RawGolfer {
  ghin?: number | string
  first_name?: string
  last_name?: string
  hi_value?: number | null
  handicap_index?: number | string | null
  hi_display?: string | null
  club_name?: string | null
  association_name?: string | null
  state?: string | null
  status?: string | null
}

function normalize(g: RawGolfer): GhinPlayerHit {
  const first = g.first_name ?? ''
  const last = g.last_name ?? ''
  // Prefer the canonical numeric field; fall back to handicap_index (which can
  // be the string "NH" for a golfer with no established index).
  let index: number | null = typeof g.hi_value === 'number' ? g.hi_value : null
  if (index === null && typeof g.handicap_index === 'number') index = g.handicap_index
  const display =
    g.hi_display ?? (index === null ? 'NH' : index < 0 ? `+${Math.abs(index)}` : String(index))
  return {
    ghinNumber: g.ghin == null ? '' : String(g.ghin),
    firstName: first,
    lastName: last,
    fullName: `${first} ${last}`.trim(),
    handicapIndex: index,
    handicapDisplay: display,
    clubName: g.club_name ?? null,
    associationName: g.association_name ?? null,
    state: g.state ?? null,
    status: g.status ?? null,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const caller = callerStatus(req)
  if (caller === 'unauthenticated') return json({ error: 'sign in to search GHIN' }, 401)
  if (caller === 'forbidden') {
    return json({ error: 'this account is not authorized for GHIN lookup' }, 403)
  }

  let params: SearchRequest
  try {
    params = (await req.json()) as SearchRequest
  } catch {
    return json({ error: 'invalid request body' }, 400)
  }
  const ghin = typeof params.ghinNumber === 'string' ? params.ghinNumber.trim() : ''
  if (!ghin && (!params.lastName || params.lastName.trim().length < 2)) {
    return json({ error: 'a last name (2+ letters) or a GHIN number is required' }, 400)
  }

  const url = ghin ? ghinLookupUrl(ghin) : ghinSearchUrl(params)
  try {
    let token = await ensureToken()
    let res = await callSearch(url, token)
    // Token can die before its exp — force exactly one re-login + retry.
    if (res.status === 401 || res.status === 403) {
      cachedToken = null
      token = await login()
      res = await callSearch(url, token)
    }
    if (res.status === 429) {
      const retry = res.headers.get('Retry-After')
      return json({ error: 'GHIN rate limit — try again shortly', retryAfter: retry }, 429)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return json({ error: `GHIN search failed (${res.status})`, detail: detail.slice(0, 400) }, 502)
    }

    const body = (await res.json()) as { golfers?: RawGolfer[] }
    const golfers = (body.golfers ?? []).map(normalize).filter((g) => g.ghinNumber)
    return json({ golfers })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'GHIN lookup failed' }, 500)
  }
})

// Scorecard-scan proxy.
//
// Why a proxy at all: extracting course data from a scorecard photo needs the
// Anthropic vision API, whose key must never ship in the client bundle. This
// Edge Function holds ANTHROPIC_API_KEY, takes 1–2 scorecard images, and returns
// a structured course draft the app pre-fills into the course editor for the
// user to verify.
//
// Cost control: every call spends money, and the public anon key can reach the
// function, so it (a) gates to real signed-in users — the anon key and anonymous
// users are rejected, same as ghin-search — and (b) enforces a per-user daily
// cap via the scan_usage table before making the paid call.
//
// Deno runtime (Supabase Edge Functions). Not part of the Vite app build.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-4-8'
const DAILY_CAP = 25

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
// the uid the daily cap is keyed on.
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

function callerUid(req: Request): string | null {
  const auth = req.headers.get('Authorization')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return null
  const payload = decodeJwtPayload(token)
  if (!payload || payload.role !== 'authenticated' || payload.is_anonymous === true) return null
  return typeof payload.sub === 'string' ? payload.sub : null
}

/** Increment (and read) the caller's scan count for today, via the service role. */
async function bumpDailyCount(uid: string): Promise<number> {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('supabase env missing')
  const res = await fetch(`${url}/rest/v1/rpc/increment_scan_usage`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uid }),
  })
  if (!res.ok) throw new Error(`usage rpc failed (${res.status})`)
  return (await res.json()) as number
}

// --- extraction prompt ------------------------------------------------------
// We ask for raw JSON rather than using structured-output schema enforcement:
// buildRemoteCourse on the client does all the real normalization (dense
// stroke-index permutation, par clamp, hole renumber, neutral-tee fallback),
// so a strict schema buys little and adds a failure surface. Opus follows an
// explicit shape + "JSON only" reliably; the parser below is tolerant anyway.
const PROMPT = `You are reading photo(s) of a golf scorecard — a dense grid. Extract the course data and respond with ONLY a single JSON object — no prose, no markdown, no code fences.

CRITICAL — column alignment. The card has one column per hole, labelled 1, 2, 3 … across the top. Every per-hole value belongs under its own hole's column. The leftmost data cell of a row is HOLE 1; the rightmost (before any OUT/IN/TOT totals) is the last hole. Do NOT shift a row by a column — this is the most common mistake. After reading each row, re-check that its first value sits under the "1" column and its last value under the final hole column, and that totals columns (OUT, IN, TOT, HCP) are NOT mistaken for a hole.

Shape:
{
  "name": string,                 // course/club name printed on the card
  "location": string | null,      // "City, ST" if shown, else null
  "holeCount": 9 | 18,            // number of holes the card scores
  "holes": [                      // one entry per hole, in order 1..holeCount
    { "number": integer, "par": integer, "handicapIndex": integer | null }
  ],
  "teeSets": [                    // one entry per tee/color row
    { "name": string, "color": string | null, "rating": number | null, "slope": integer | null,
      "yardages": (integer | null)[], "strokeIndexes": (integer | null)[], "pars": (integer | null)[] }
  ]
}

Rules:
- Top-level "holes": par is the hole's primary par; handicapIndex is a representative stroke index (use the back/men's Handicap row; null if none).
- A tee set is each named tee/color row (Black, Blue, White, Gold, Red, and named combos like "Blue/White"). name = its label; color = a CSS color name/hex if the label implies one, else null; rating = Course Rating (e.g. 71.2); slope = Slope Rating (e.g. 128).
- Each tee has up to three per-hole rows, ALL aligned to the same hole columns:
  • yardages — the tee's yardage row.
  • strokeIndexes — the "Handicap" row printed directly UNDER that tee's yardage row (read each tee's OWN row; they differ between tees). A stroke-index row RANKS the holes, so every integer from 1 to holeCount appears EXACTLY ONCE. If your read has a duplicate or a missing number, you misread or mis-shifted it — re-read that row cell by cell.
  • pars — the tee's par per hole. Usually the same across tees, but a hole printed like "4/3" plays as a different par by tee based on length; give THIS tee the value matching its yardage (a short forward-tee hole can be par 3 where the back tees are par 4).
- Every per-hole array must have exactly holeCount values, in hole order. Use null only for a single cell you genuinely cannot read — never guess or shift neighbouring values to fill a gap. Do not invent tees or holes that aren't printed.`

interface ImageInput {
  media_type?: string
  data?: string
}

const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const uid = callerUid(req)
  if (!uid) return json({ error: 'sign in to scan scorecards' }, 401)

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) return json({ error: 'scanning is not configured' }, 500)

  let body: { images?: ImageInput[] }
  try {
    body = (await req.json()) as { images?: ImageInput[] }
  } catch {
    return json({ error: 'invalid request body' }, 400)
  }
  const images = (body.images ?? []).filter(
    (im): im is Required<ImageInput> =>
      typeof im?.data === 'string' &&
      im.data.length > 0 &&
      typeof im.media_type === 'string' &&
      ALLOWED_MEDIA.has(im.media_type),
  )
  if (images.length === 0 || images.length > 2) {
    return json({ error: 'send 1–2 scorecard images (jpeg/png/webp)' }, 400)
  }

  // Cap BEFORE spending money. increment returns the running count for today.
  try {
    const count = await bumpDailyCount(uid)
    if (count > DAILY_CAP) {
      return json({ error: `daily scan limit (${DAILY_CAP}) reached — try again tomorrow` }, 429)
    }
  } catch {
    return json({ error: 'could not check scan usage' }, 500)
  }

  const content = [
    ...images.map((im) => ({
      type: 'image',
      source: { type: 'base64', media_type: im.media_type, data: im.data },
    })),
    { type: 'text', text: PROMPT },
  ]

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12000,
        // Reasoning helps a lot on a dense grid — let the model deliberate about
        // which cell belongs to which hole instead of one-pass reading. Thinking
        // blocks come back separately; we read the final text block below.
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content }],
      }),
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'vision request failed' }, 502)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('anthropic error', res.status, detail)
    // Surface the real Anthropic message so failures are diagnosable from the app.
    return json({ error: `vision request failed (${res.status}): ${detail.slice(0, 300)}` }, 502)
  }

  const data = (await res.json()) as {
    stop_reason?: string
    content?: { type: string; text?: string }[]
  }
  if (data.stop_reason === 'refusal') {
    return json({ error: 'could not read this scorecard' }, 422)
  }
  const text = data.content?.find((b) => b.type === 'text')?.text
  if (!text) return json({ error: 'no scorecard data found' }, 422)

  let draft: unknown
  try {
    draft = JSON.parse(text)
  } catch {
    // Tolerate stray prose / code fences around the JSON object.
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return json({ error: 'scan returned unreadable data' }, 422)
    try {
      draft = JSON.parse(match[0])
    } catch {
      return json({ error: 'scan returned unreadable data' }, 422)
    }
  }

  return json({ draft })
})

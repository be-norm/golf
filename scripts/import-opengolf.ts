/**
 * One-shot bulk import of the OpenGolfAPI US dataset into the Supabase
 * course library. Only courses with a complete declared-9-or-18-hole
 * scorecard are imported; everything else is reachable via live search.
 *
 * Usage: pnpm dlx tsx scripts/import-opengolf.ts <path-to-opengolfapi-us.ndjson>
 * Requires SUPABASE_SERVICE_ROLE_KEY in the environment (see .env.local).
 *
 * Data © OpenGolfAPI (opengolfapi.org), ODbL 1.0. The source snapshot is
 * archived at data/opengolfapi-us.ndjson.gz; this script is the transform.
 */
import { readFileSync } from 'node:fs'
import { buildRemoteCourse, usableHoleRows } from '../src/remote/transform'

const SUPABASE_URL = 'https://xbdsssnjphbxequhlazu.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')

const path = process.argv[2]
if (!path) throw new Error('usage: tsx scripts/import-opengolf.ts <ndjson path>')

interface DumpFeature {
  properties: {
    id: string
    name: string
    city?: string
    state?: string
    holes?: number
    scorecard?: { hole: number; par: number; handicap_index?: number }[]
  }
}

const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
const rows: object[] = []
for (const line of lines) {
  const p = (JSON.parse(line) as DumpFeature).properties
  // Tolerate junk/duplicate rows (keep the real 9 or 18 using the declared count).
  const sc = usableHoleRows(
    (p.scorecard ?? []).map((h) => ({ number: h.hole, par: h.par, handicap_index: h.handicap_index })),
    p.holes,
  )
  if (sc.length !== 9 && sc.length !== 18) continue
  const course = buildRemoteCourse({
    id: p.id,
    name: p.name,
    city: p.city,
    state: p.state,
    holes: sc.map((h) => ({ number: h.number, par: h.par, handicapIndex: h.handicap_index })),
  })
  rows.push({
    id: course.id,
    name: course.name,
    location: course.location ?? null,
    hole_count: course.holeCount,
    data: course,
    status: 'published',
    source: 'opengolfapi',
    source_id: p.id,
    fetched_at: new Date().toISOString(),
  })
}

console.log(`importing ${rows.length} of ${lines.length} courses…`)

for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500)
  const res = await fetch(`${SUPABASE_URL}/rest/v1/courses?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(batch),
  })
  if (!res.ok) throw new Error(`batch ${i}: ${res.status} ${await res.text()}`)
  console.log(`  ${Math.min(i + 500, rows.length)}/${rows.length}`)
}
console.log('done')

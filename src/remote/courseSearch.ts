import type { Course } from '../engine/core/types'
import { courseRepo } from '../db/repos'
import { LOCAL_USER, ORPHANED_AUTHOR } from '../db/ids'
import { supabase } from './supabase'
import { buildRemoteCourse, normalizeTeeRatings, usableHoleRows, type RawTee } from './transform'

export interface CourseSearchHit {
  id: string
  name: string
  location: string
  origin: 'library' | 'opengolfapi' | 'golfcourseapi'
  /** For library hits only: the stored provenance, so the UI can badge
   *  user-contributed courses. Undefined for live API hits. */
  source?: Course['source']
  /** Library hits only: `courses.created_by` — who authored this version, so
   *  the viewer's own copy can rank first. Undefined for API hits AND for a row
   *  whose author deleted their account (`on delete set null`), which is why
   *  "mine" tests for a non-empty value rather than plain equality. */
  createdBy?: string
  /** Library hits only: `courses.updated_at`, which `pushCourse` writes from
   *  `course.updatedAt` — the CARD's clock (when this version was last
   *  corrected), never a membership clock. Ranks and dates community versions. */
  updatedAt?: string
}

/** A hit, classified for display. Structurally still a `CourseSearchHit`, so it
 *  passes straight to `importCourseHit` with nothing to unwrap. */
export interface CourseVersion extends CourseSearchHit {
  /** 'api' = a directory's card (or our cached/seeded copy of one);
   *  'community' = one a golfer entered or corrected (`source === 'user'`). */
  kind: 'api' | 'community'
  /** the viewer authored this version */
  mine: boolean
  /** ids of the other hits folded into this one — the same directory card off a
   *  different shelf. Only the winner's id is offered for import, but a caller
   *  asking "is this already in my library?" has to check these too: a course
   *  imported from OpenGolfAPI is stored under its OpenGolf id, and if
   *  GolfCourseAPI wins the fold, the row would otherwise read "+ add" and
   *  cheerfully save a second copy of a course you already have. */
  aliasIds: string[]
}

/** The three (or four) result lists grouping consumes, in precedence order. */
export interface CourseHitSources {
  /** The viewer's own published versions, fetched as their OWN query. The main
   *  library query returns rows alphabetically under a LIMIT, so "Broadmoor CC"
   *  and "Broadmoor Country Club" sort far apart and a busy search could drop
   *  YOUR corrected card — the one thing this feature exists to surface. */
  owned?: CourseSearchHit[]
  library: CourseSearchHit[]
  golfcourseapi: CourseSearchHit[]
  opengolfapi: CourseSearchHit[]
}

/** One place, and every version of it search found — best first (MAI-79). */
export interface CourseGroup {
  /** the normalized name+location key, or `id:<hit id>` for a location-less hit
   *  (which never groups). React key and expanded-state key. */
  key: string
  /** the top-ranked version's name/location — what the collapsed row reads */
  name: string
  location: string
  /** ranked mine → newest community → api. Never empty. */
  versions: CourseVersion[]
}

const OPENGOLF_BASE = 'https://api.opengolfapi.org'
const GOLFCOURSEAPI_BASE = 'https://api.golfcourseapi.com'
const GOLFCOURSEAPI_KEY = import.meta.env.VITE_GOLFCOURSEAPI_KEY as string | undefined

/**
 * Search the shared Supabase library, GolfCourseAPI, and OpenGolfAPI in
 * parallel; all best-effort (offline → empty results, never an error), then
 * collapse the lot into ONE result per place, each carrying its versions.
 *
 * Takes the viewer explicitly for the same reason `importCourseHit` takes the
 * owner: ranking needs to know whose version is whose, and the caller is the
 * only one who knows who is signed in. Guests pass LOCAL_USER.
 */
export async function searchCourses(query: string, viewerId: string): Promise<CourseGroup[]> {
  const q = query.trim()
  if (q.length < 3) return []

  const [owned, library, golf, open] = await Promise.all([
    ownedSearch(q, viewerId),
    librarySearch(q),
    golfCourseApiSearch(q),
    openGolfSearch(q),
  ])

  return groupCourseHits({ owned, library, golfcourseapi: golf, opengolfapi: open }, viewerId)
}

const MAX_GROUPS = 20
/**
 * Library-seeded groups are capped BELOW the total so the live directories
 * always have room. The old code got this by accident — the library query took
 * 12 and the merged list was sliced to 20, leaving 8 — and losing it silently
 * would be worse than the bug this ticket fixes: search "club" with 20+ cached
 * library courses and every GolfCourseAPI and OpenGolfAPI result disappears,
 * under a header that says "Results (20)" as though nothing was cut.
 */
const MAX_LIBRARY_GROUPS = 12

/**
 * One result per place, versions on demand (MAI-79).
 *
 * The same course can exist several times over: the row a directory published,
 * plus a version each golfer entered or corrected (MAI-78 makes forks the only
 * way to fix an API card, so this is by design, not an accident). Listing them
 * as separate near-identical rows makes picking a course a comparison instead
 * of a decision — so they collapse into one group, and the versions are the
 * second, explicit choice.
 *
 * Takes the sources rather than a flat list so precedence and the per-source
 * budget are both visible here, and pure so all of it is unit-testable without
 * a network or a Supabase stub.
 */
export function groupCourseHits(sources: CourseHitSources, viewerId: string): CourseGroup[] {
  // precedence: your own versions, then the shared library, then the live
  // directories (GolfCourseAPI's richer tee data ahead of OpenGolfAPI).
  const ordered = [
    { hits: sources.owned ?? [], budgeted: false },
    { hits: sources.library, budgeted: true },
    { hits: sources.golfcourseapi, budgeted: false },
    { hits: sources.opengolfapi, budgeted: false },
  ]

  // a Map preserves insertion order, so buckets come out in precedence order
  const buckets = new Map<string, { hits: CourseSearchHit[]; budgeted: boolean }>()
  const seenIds = new Set<string>()
  for (const { hits, budgeted } of ordered) {
    for (const h of hits) {
      if (seenIds.has(h.id)) continue // the owned query re-returns library rows
      seenIds.add(h.id)
      const key = groupKeyFor(h)
      const bucket = buckets.get(key)
      if (bucket) bucket.hits.push(h)
      else buckets.set(key, { hits: [h], budgeted })
    }
  }

  const out: CourseGroup[] = []
  let libraryGroups = 0
  for (const [key, bucket] of buckets) {
    if (out.length === MAX_GROUPS) break
    if (bucket.budgeted) {
      if (libraryGroups === MAX_LIBRARY_GROUPS) continue
      libraryGroups++
    }
    const versions = versionsOf(bucket.hits, viewerId)
    const top = versions[0]
    if (!top) continue // unreachable — a bucket exists because a hit made it
    out.push({ key, name: top.name, location: top.location, versions })
  }
  return out
}

/**
 * A hit with no location never groups — it is keyed by its own id.
 *
 * Merging two genuinely different courses is the worst outcome here, and a bare
 * name is exactly where name+location stops being evidence: every "Municipal"
 * on earth would fuse into one row. The test is on the NORMALIZED location, not
 * the raw one: `-`, `.` and `,` all survive `.trim()` but normalize away, and
 * would slip past a raw check straight into the fusion it exists to prevent.
 * (`id:` can't collide with a normKey, which is always `[a-z0-9]*|[a-z0-9]*`.)
 */
function groupKeyFor(h: CourseSearchHit): string {
  const key = normKey(h.name, h.location)
  return key.endsWith('|') ? `id:${h.id}` : key
}

function versionsOf(bucket: CourseSearchHit[], viewerId: string): CourseVersion[] {
  const versions: CourseVersion[] = []
  let api: CourseVersion | undefined
  for (const h of bucket) {
    if (h.source === 'user') {
      // createdBy must be non-empty before comparing: an API hit and a row
      // whose author deleted their account both carry undefined, and neither
      // is anybody's.
      versions.push({
        ...h,
        kind: 'community',
        mine: !!h.createdBy && h.createdBy === viewerId,
        aliasIds: [],
      })
    } else if (!api) {
      // every non-user hit is the same directory card off a different shelf —
      // three rows all reading "API" is the noise this ticket removes. First
      // wins, i.e. library → golfcourseapi → opengolfapi.
      api = { ...h, kind: 'api', mine: false, aliasIds: [] }
    } else {
      // dropped from the offer, but NOT forgotten — see `aliasIds`
      api.aliasIds.push(h.id)
    }
  }
  if (api) versions.push(api)
  return versions.sort(compareVersions)
}

/** Every id under which this version might already sit in the local library. */
export function versionIds(v: CourseVersion): string[] {
  return [v.id, ...v.aliasIds]
}

/**
 * Mine → other golfers' (newest first) → the directory's. A TOTAL order: the id
 * tie-break is what makes "the same search twice offers the same version" true.
 */
function compareVersions(a: CourseVersion, b: CourseVersion): number {
  const ra = rankOf(a)
  const rb = rankOf(b)
  if (ra !== rb) return ra - rb
  const ta = stamp(a.updatedAt)
  const tb = stamp(b.updatedAt)
  if (ta !== tb) return tb - ta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const rankOf = (v: CourseVersion) => (v.mine ? 0 : v.kind === 'community' ? 1 : 2)

/** Instants, never strings — local stamps end `Z`, Postgres returns `+00:00`.
 *  Undated or unparseable sorts last rather than putting NaN in a comparator. */
function stamp(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? -Infinity : t
}

const normKey = (name: string, location: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}|${location.toLowerCase().replace(/[^a-z0-9]/g, '')}`

/** GolfCourseAPI stores some 9-hole courses as the nine played twice (front nine
 *  == back nine). Detect it so we import 9 holes, not a mislabeled 18. */
export function isDoubledNine(rows: { par?: number; yardage?: number | null }[]): boolean {
  if (rows.length !== 18) return false
  return Array.from({ length: 9 }).every(
    (_, i) => rows[i]?.par === rows[i + 9]?.par && rows[i]?.yardage === rows[i + 9]?.yardage,
  )
}

/** GolfCourseAPI display name — join club + course only when they differ, so an
 *  identical pair doesn't become "Penmar Municipal … — Penmar Municipal …". */
export function golfApiName(club?: string, course?: string): string {
  const cl = club?.trim()
  const co = course?.trim()
  if (cl && co && cl !== co) return `${cl} — ${co}`
  return co || cl || ''
}

// --- per-source searches (each best-effort → []) ----------------------------

const LIBRARY_COLUMNS = 'id, name, location, source, created_by, updated_at'

/**
 * Match name OR city/state — "broadmoor", "westfield", "carmel in" all work.
 * PostgREST parses the .or() argument as a logic tree, so a bare comma or
 * parenthesis in the query corrupts it — typing "Carmel, IN" (the app's own
 * City, ST display format) silently emptied the library results. Double-quoting
 * the value (PostgREST's string escape, backslash for embedded
 * quotes/backslashes) keeps any punctuation inert.
 */
function libraryFilter(q: string): string {
  const raw = q.replace(/[%_]/g, '').replace(/[\\"]/g, '\\$&')
  const pattern = `"%${raw}%"`
  return `name.ilike.${pattern},location.ilike.${pattern}`
}

function toLibraryHit(c: Record<string, unknown>): CourseSearchHit {
  return {
    id: c.id as string,
    name: c.name as string,
    location: (c.location as string | null) ?? '',
    origin: 'library' as const,
    source: (c.source as Course['source'] | null) ?? undefined,
    createdBy: (c.created_by as string | null) ?? undefined,
    updatedAt: (c.updated_at as string | null) ?? undefined,
  }
}

async function librarySearch(q: string): Promise<CourseSearchHit[]> {
  try {
    // Ordered, with id as the tie-break: without an ORDER BY, which of two
    // same-name rows (an API card and a golfer's fork of it, MAI-78) came back
    // first changed between searches. Both now survive as versions of one
    // result (MAI-79), but the order still decides where the LIMIT falls.
    //
    // 12 → 30 because duplicates now consume slots instead of being dropped.
    // The alphabetical order still means a busy query truncates arbitrarily —
    // your OWN version is the one that must never be lost that way, and
    // `ownedSearch` below guarantees it rather than trusting the limit.
    const { data } = await supabase
      .from('courses')
      .select(LIBRARY_COLUMNS)
      .or(libraryFilter(q))
      .order('name')
      .order('id')
      .limit(30)
    return (data ?? []).map(toLibraryHit)
  } catch {
    return []
  }
}

/**
 * The viewer's own published versions, as their own small query.
 *
 * "Given I have my own version → mine is the one offered" can't be satisfied by
 * a limit: `librarySearch` sorts by name, so "Broadmoor CC" and "Broadmoor
 * Country Club" land far apart and a common query can cut your corrected card
 * before grouping ever sees it. Grouping would then present "2 versions" as the
 * complete set with yours silently missing. Scoping a second query to
 * `created_by` removes that failure instead of making it rarer.
 */
async function ownedSearch(q: string, viewerId: string): Promise<CourseSearchHit[]> {
  if (viewerId === LOCAL_USER) return [] // a guest authors nothing on the server
  try {
    const { data } = await supabase
      .from('courses')
      .select(LIBRARY_COLUMNS)
      .eq('created_by', viewerId)
      .or(libraryFilter(q))
      .order('name')
      .order('id')
      .limit(10)
    return (data ?? []).map(toLibraryHit)
  } catch {
    return []
  }
}

async function openGolfSearch(q: string): Promise<CourseSearchHit[]> {
  try {
    const res = await fetch(`${OPENGOLF_BASE}/v1/courses/search?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      courses?: { id: string; name: string; city?: string; state?: string }[]
    }
    return (data.courses ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      location: [c.city, c.state].filter(Boolean).join(', '),
      origin: 'opengolfapi' as const,
    }))
  } catch {
    return []
  }
}

// GolfCourseAPI (api.golfcourseapi.com). Free, email-issued key. Shape confirmed
// against live responses: search → courses[].{id,club_name,course_name,
// location.{city,state}}; detail → course.tees.{male,female}[].{tee_name,
// course_rating,slope_rating,holes[].{par,yardage,handicap}}. Note some 9-hole
// courses come back as the nine doubled (18 rows) — handled by isDoubledNine.
interface GolfApiSearchCourse {
  id: number | string
  club_name?: string
  course_name?: string
  location?: { city?: string; state?: string }
}

async function golfCourseApiSearch(q: string): Promise<CourseSearchHit[]> {
  if (!GOLFCOURSEAPI_KEY) return []
  try {
    const res = await fetch(`${GOLFCOURSEAPI_BASE}/v1/search?search_query=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Key ${GOLFCOURSEAPI_KEY}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { courses?: GolfApiSearchCourse[] }
    return (data.courses ?? []).map((c) => ({
      id: `gca:${c.id}`, // namespace so it never collides with a UUID library/opengolf id
      name: golfApiName(c.club_name, c.course_name),
      location: [c.location?.city, c.location?.state].filter(Boolean).join(', '),
      origin: 'golfcourseapi' as const,
    }))
  } catch {
    return []
  }
}

// --- import a chosen hit into the local library -----------------------------

/**
 * Pull a search hit's full scorecard and save it to `userId`'s library.
 *
 * Takes the owner explicitly: saving is an owned act (MAI-76), and the caller
 * is the only one who knows who is signed in. Guests pass LOCAL_USER, like
 * every other owned write. All three paths end in `courseRepo.save`, which
 * records membership and queues its push atomically — these imports are the
 * main way courses enter the library, and they were exactly the paths the
 * previous attempt left out of sync.
 */
export async function importCourseHit(userId: string, hit: CourseSearchHit): Promise<Course> {
  if (hit.origin === 'library') return importFromLibrary(userId, hit)
  if (hit.origin === 'golfcourseapi') return importFromGolfCourseApi(userId, hit)
  return importFromOpenGolf(userId, hit)
}

async function importFromLibrary(userId: string, hit: CourseSearchHit): Promise<Course> {
  const { data, error } = await supabase
    .from('courses')
    .select('data, created_by')
    .eq('id', hit.id)
    .single()
  if (error || !data) throw new Error('course fetch failed')
  // The library is the one import path that skips buildRemoteCourse — a doc
  // published before the 9-hole rating guard existed would otherwise keep an
  // 18-hole rating forever, on every device that imports it.
  // Return the NORMALIZED course (not the raw library doc), matching what we
  // cached — bar courseRepo.save's own revision bump / updatedAt stamp, same
  // as the other import paths below.
  const published = data.data as Course
  const authored = published.source === 'user'
  const course: Course = {
    ...normalizeTeeRatings(published),
    // A golfer-contributed course must still read as one after import (MAI-77)
    // — but ownership travels in created_by, NOT source: the editor's fork
    // decision keys on who authored it, and keying it on source was how the
    // last attempt tried to push edits onto rows RLS refuses (MAI-78).
    source: authored ? ('user' as const) : ('remote' as const),
    // A golfer-authored row whose created_by is NULL lost its author (account
    // deleted → set null). Mark it explicitly rather than importing
    // `undefined`, which must keep meaning "legacy card authored on THIS
    // device" — otherwise editing an orphan masquerades as editing your own
    // and pushes updates RLS refuses for everyone.
    createdBy: authored ? ((data.created_by as string | null) ?? ORPHANED_AUTHOR) : undefined,
    revision: 0,
  }
  return courseRepo.save(userId, course)
}

async function importFromOpenGolf(userId: string, hit: CourseSearchHit): Promise<Course> {
  const res = await fetch(`${OPENGOLF_BASE}/api/v1/courses/${hit.id}`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`opengolfapi ${res.status}`)
  const detail = (await res.json()) as {
    id: string
    course_name: string
    city?: string
    state?: string
    holes?: number
    tees?: {
      tee_name: string
      tee_color?: string | null
      course_rating?: number | null
      slope?: number | null
    }[]
    holes_data?: { number: number; par: number; handicap_index?: number | null }[]
  }
  // Some records carry junk trailing rows (Penmar: holes:9 but an 11-row array);
  // keep the real holes using the provider's own count instead of hard-rejecting.
  const holesData = usableHoleRows(detail.holes_data ?? [], detail.holes)
  if (holesData.length !== 9 && holesData.length !== 18) {
    throw new Error('course has no usable scorecard — add it manually instead')
  }
  const course = buildRemoteCourse({
    id: detail.id,
    name: detail.course_name,
    city: detail.city,
    state: detail.state,
    holes: holesData.map((h) => ({
      number: h.number,
      par: h.par,
      handicapIndex: h.handicap_index,
    })),
    tees: detail.tees?.map((t) => ({
      name: t.tee_name,
      color: t.tee_color,
      rating: t.course_rating,
      slope: t.slope,
    })),
  })
  return courseRepo.save(userId, { ...course, revision: 0 })
}

interface GolfApiTee {
  tee_name?: string
  course_rating?: number | null
  slope_rating?: number | null
  holes?: { par?: number; yardage?: number | null; handicap?: number | null }[]
}

async function importFromGolfCourseApi(userId: string, hit: CourseSearchHit): Promise<Course> {
  const id = hit.id.startsWith('gca:') ? hit.id.slice(4) : hit.id
  const res = await fetch(`${GOLFCOURSEAPI_BASE}/v1/courses/${id}`, {
    headers: GOLFCOURSEAPI_KEY ? { Authorization: `Key ${GOLFCOURSEAPI_KEY}` } : undefined,
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`golfcourseapi ${res.status}`)
  const body = (await res.json()) as {
    course?: {
      id: number | string
      club_name?: string
      course_name?: string
      location?: { city?: string; state?: string }
      tees?: { male?: GolfApiTee[]; female?: GolfApiTee[] }
    }
  }
  const course = body.course
  const tees = course?.tees?.male?.length ? course.tees.male : (course?.tees?.female ?? [])
  // holes come from a tee's per-hole array (par + stroke index are the same
  // across tees); take the longest tee so a short/partial tee doesn't truncate.
  const holesTee = [...tees].sort((a, b) => (b.holes?.length ?? 0) - (a.holes?.length ?? 0))[0]
  const holeRows = holesTee?.holes ?? []
  // A 9-hole course stored as the nine played twice → collapse to 9, so it isn't
  // mislabeled 18 holes. `keep` also trims every tee's per-hole arrays to match.
  const keep = isDoubledNine(holeRows) ? 9 : holeRows.length
  const holes = holeRows.slice(0, keep).map((h, i) => ({
    number: i + 1,
    par: h.par ?? 4,
    handicapIndex: h.handicap ?? null,
  }))
  if (holes.length !== 9 && holes.length !== 18) {
    throw new Error('course has no usable scorecard — add it manually instead')
  }
  const rawTees: RawTee[] = tees.map((t) => ({
    name: t.tee_name ?? 'Tee',
    rating: t.course_rating,
    slope: t.slope_rating,
    yardages: t.holes?.slice(0, keep).map((h) => h.yardage ?? undefined),
    // GolfCourseAPI rates each tee separately, so per-hole handicap/par are per tee.
    strokeIndexes: t.holes?.slice(0, keep).map((h) => h.handicap ?? undefined),
    pars: t.holes?.slice(0, keep).map((h) => h.par ?? undefined),
  }))
  const built = buildRemoteCourse({
    id: hit.id, // keep the namespaced id so re-imports dedupe locally
    name: golfApiName(course?.club_name, course?.course_name) || hit.name,
    city: course?.location?.city,
    state: course?.location?.state,
    holes,
    tees: rawTees,
  })
  return courseRepo.save(userId, { ...built, revision: 0 })
}

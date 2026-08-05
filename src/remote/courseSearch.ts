import type { Course } from '../engine/core/types'
import { courseRepo } from '../db/repos'
import { ORPHANED_AUTHOR } from '../db/ids'
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
}

const OPENGOLF_BASE = 'https://api.opengolfapi.org'
const GOLFCOURSEAPI_BASE = 'https://api.golfcourseapi.com'
const GOLFCOURSEAPI_KEY = import.meta.env.VITE_GOLFCOURSEAPI_KEY as string | undefined

/**
 * Search the shared Supabase library, GolfCourseAPI, and OpenGolfAPI in
 * parallel; all best-effort (offline → empty results, never an error). Results
 * are de-duplicated across sources with the library winning (it's our
 * curated/community copy), then GolfCourseAPI (richer tee data), then
 * OpenGolfAPI.
 */
export async function searchCourses(query: string): Promise<CourseSearchHit[]> {
  const q = query.trim()
  if (q.length < 3) return []

  const [library, golf, open] = await Promise.all([
    librarySearch(q),
    golfCourseApiSearch(q),
    openGolfSearch(q),
  ])

  return mergeCourseHits({ library, golfcourseapi: golf, opengolfapi: open })
}

/**
 * De-dup + precedence, pulled out as a pure function so it's unit-testable.
 * Order is precedence: library beats GolfCourseAPI beats OpenGolfAPI. A hit is
 * dropped if its id OR its normalized name+location was already taken by a
 * higher-precedence source. Best-effort — the name+location key can miss
 * ("Penmar GC" vs "Penmar Golf Course") or over-merge; it only affects the
 * list shown, never imported data.
 */
export function mergeCourseHits(groups: {
  library: CourseSearchHit[]
  golfcourseapi: CourseSearchHit[]
  opengolfapi: CourseSearchHit[]
}): CourseSearchHit[] {
  const seenIds = new Set<string>()
  const seenKeys = new Set<string>()
  const out: CourseSearchHit[] = []
  for (const group of [groups.library, groups.golfcourseapi, groups.opengolfapi]) {
    for (const h of group) {
      const key = normKey(h.name, h.location)
      if (seenIds.has(h.id) || seenKeys.has(key)) continue
      seenIds.add(h.id)
      seenKeys.add(key)
      out.push(h)
    }
  }
  return out.slice(0, 20)
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

async function librarySearch(q: string): Promise<CourseSearchHit[]> {
  try {
    // match name OR city/state — "broadmoor", "westfield", "carmel in" all work
    const pattern = `%${q.replace(/[%_]/g, '')}%`
    // Ordered, with id as the tie-break: without an ORDER BY, which of two
    // same-name rows (an API card and a golfer's fork of it, MAI-78) comes
    // back first — and therefore which one survives mergeCourseHits' first-
    // wins dedupe — changed between searches. Collapsing the pair into one
    // result is MAI-79; this only makes the pick deterministic.
    const { data } = await supabase
      .from('courses')
      .select('id, name, location, source')
      .or(`name.ilike.${pattern},location.ilike.${pattern}`)
      .order('name')
      .order('id')
      .limit(12)
    return (data ?? []).map((c) => ({
      id: c.id as string,
      name: c.name as string,
      location: (c.location as string | null) ?? '',
      origin: 'library' as const,
      source: (c.source as Course['source'] | null) ?? undefined,
    }))
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

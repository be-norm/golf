import type { Course } from '../engine/core/types'
import { courseRepo } from '../db/repos'
import { supabase } from './supabase'
import { buildRemoteCourse, usableHoleRows, type RawTee } from './transform'

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
    const { data } = await supabase
      .from('courses')
      .select('id, name, location, source')
      .or(`name.ilike.${pattern},location.ilike.${pattern}`)
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

/** Pull a search hit's full scorecard and cache it in the local library. */
export async function importCourseHit(hit: CourseSearchHit): Promise<Course> {
  if (hit.origin === 'library') return importFromLibrary(hit)
  if (hit.origin === 'golfcourseapi') return importFromGolfCourseApi(hit)
  return importFromOpenGolf(hit)
}

async function importFromLibrary(hit: CourseSearchHit): Promise<Course> {
  const { data, error } = await supabase.from('courses').select('data').eq('id', hit.id).single()
  if (error || !data) throw new Error('course fetch failed')
  const course = data.data as Course
  await courseRepo.put({ ...course, source: 'remote', revision: 0 })
  return course
}

async function importFromOpenGolf(hit: CourseSearchHit): Promise<Course> {
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
  await courseRepo.put({ ...course, revision: 0 })
  return course
}

interface GolfApiTee {
  tee_name?: string
  course_rating?: number | null
  slope_rating?: number | null
  holes?: { par?: number; yardage?: number | null; handicap?: number | null }[]
}

async function importFromGolfCourseApi(hit: CourseSearchHit): Promise<Course> {
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
  await courseRepo.put({ ...built, revision: 0 })
  return built
}

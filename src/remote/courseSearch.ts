import type { Course } from '../engine/core/types'
import { courseRepo } from '../db/repos'
import { supabase } from './supabase'
import { buildRemoteCourse } from './transform'

export interface CourseSearchHit {
  id: string
  name: string
  location: string
  origin: 'library' | 'opengolfapi'
}

const OPENGOLF_BASE = 'https://api.opengolfapi.org'

/**
 * Search the shared Supabase library and the OpenGolfAPI live index in
 * parallel; both are best-effort (offline → empty results, never an error).
 */
export async function searchCourses(query: string): Promise<CourseSearchHit[]> {
  const q = query.trim()
  if (q.length < 3) return []

  const librarySearch = async (): Promise<{ id: string; name: string; location: string | null }[]> => {
    try {
      const { data } = await supabase
        .from('courses')
        .select('id, name, location')
        .ilike('name', `%${q}%`)
        .limit(12)
      return data ?? []
    } catch {
      return []
    }
  }

  const [library, live] = await Promise.all([
    librarySearch(),
    fetch(`${OPENGOLF_BASE}/v1/courses/search?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(8000),
    })
      .then((r) => (r.ok ? r.json() : { courses: [] }))
      .then(
        (data: { courses?: { id: string; name: string; city?: string; state?: string }[] }) =>
          data.courses ?? [],
      )
      .catch(() => []),
  ])

  const hits: CourseSearchHit[] = library.map((c) => ({
    id: c.id,
    name: c.name,
    location: c.location ?? '',
    origin: 'library' as const,
  }))
  const seen = new Set(hits.map((h) => h.id))
  for (const c of live) {
    if (seen.has(c.id)) continue
    hits.push({
      id: c.id,
      name: c.name,
      location: [c.city, c.state].filter(Boolean).join(', '),
      origin: 'opengolfapi',
    })
  }
  return hits.slice(0, 20)
}

/** Pull a search hit's full scorecard and cache it in the local library. */
export async function importCourseHit(hit: CourseSearchHit): Promise<Course> {
  if (hit.origin === 'library') {
    const { data, error } = await supabase.from('courses').select('data').eq('id', hit.id).single()
    if (error || !data) throw new Error('course fetch failed')
    const course = data.data as Course
    await courseRepo.put({ ...course, source: 'remote', revision: 0 })
    return course
  }

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
  const holesData = detail.holes_data ?? []
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

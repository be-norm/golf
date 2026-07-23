import { rankStrokeIndexes } from '../engine/core/handicap'
import { looksLikeEighteenHoleRating } from '../engine/core/tees'
import type { Course, HoleCore, TeeSet } from '../engine/core/types'

/**
 * Halve any tee rating that reads as the course's 18-hole rating on a 9-hole
 * card (`looksLikeEighteenHoleRating`) — a doubled nine from GolfCourseAPI (18
 * rows collapsed to 9, rating untouched), a scan that read the 18-hole row, or a
 * library doc published before this guard existed.
 *
 * Applied on every path a course enters the library from OUTSIDE (both API
 * imports and the shared-library import). Deliberately not in courseRepo.put:
 * the course editor writes through that, and there a bad rating is flagged for
 * the user to fix rather than silently rewritten. So a hand-typed 18-hole rating
 * can still be saved (and published) — the warning is the only guard there.
 */
export function normalizeTeeRatings(course: Course): Course {
  if (course.holeCount !== 9) return course
  return {
    ...course,
    teeSets: course.teeSets.map((t) =>
      looksLikeEighteenHoleRating(course, t) ? { ...t, rating: t.rating / 2 } : t,
    ),
  }
}

export interface RawHole {
  number: number
  par: number
  handicapIndex: number | null | undefined
}

export interface RawTee {
  name: string
  color?: string | null
  rating?: number | null
  slope?: number | null
  yardages?: (number | undefined)[]
  /** This tee's own per-hole stroke-index row, when rated per tee. */
  strokeIndexes?: (number | undefined)[]
  /** This tee's own per-hole par, when it varies by tee. */
  pars?: (number | undefined)[]
}

/**
 * Drop spurious hole rows some providers include — junk trailing entries or
 * duplicate hole numbers — using the provider's own hole count, so a clean 9 or
 * 18 survives instead of the whole course being rejected. (OpenGolfAPI's Penmar,
 * for example, is a 9-hole course whose scorecard array carries two junk extra
 * rows, which the old exact-length check rejected outright.)
 */
export function usableHoleRows<T extends { number: number }>(rows: T[], holeCount?: number): T[] {
  const target = holeCount === 9 || holeCount === 18 ? holeCount : null
  const seen = new Set<number>()
  return rows.filter((h) => {
    if (target !== null && (h.number < 1 || h.number > target)) return false
    if (seen.has(h.number)) return false
    seen.add(h.number)
    return true
  })
}

/**
 * Normalize messy source scorecards into our invariant-holding shape:
 * holes renumbered 1..N in source order, stroke indexes repaired into a
 * dense permutation (rank by claimed index, stable by position).
 */
export function normalizeHoles(raw: RawHole[]): HoleCore[] {
  const ordered = [...raw].sort((a, b) => a.number - b.number)
  const claimed = ordered.map((h, i) => h.handicapIndex ?? 100 + i)
  const ranks = rankStrokeIndexes(claimed)
  return ordered.map((h, i) => ({
    number: i + 1,
    par: h.par >= 3 && h.par <= 6 ? h.par : 4,
    strokeIndex: ranks[i]!,
  }))
}

/**
 * Build a Course document from external data. Missing ratings fall back to
 * neutral values (rating = par, slope = 113 → course handicap ≈ index),
 * clearly editable in the course editor.
 */
export function buildRemoteCourse(input: {
  id: string
  name: string
  city?: string | null
  state?: string | null
  holes: RawHole[]
  tees?: RawTee[]
}): Course {
  const holes = normalizeHoles(input.holes)
  const par = holes.reduce((a, h) => a + h.par, 0)
  const n = holes.length
  // All-or-nothing per-tee arrays, aligned to the (renumbered) hole order:
  // stroke indexes are re-ranked into a clean 1..n permutation; pars clamped 3–6.
  const complete = (xs: (number | undefined)[] | undefined): xs is number[] =>
    !!xs && xs.length === n && xs.every((x) => typeof x === 'number')
  const teeSets: TeeSet[] =
    input.tees && input.tees.length > 0
      ? input.tees.map((t, i) => ({
          id: `tee-${i}-${t.name.toLowerCase().replace(/\W+/g, '-')}`,
          name: t.name,
          color: t.color ?? undefined,
          rating: t.rating ?? par,
          slope: t.slope ?? 113,
          yardages: complete(t.yardages) ? t.yardages : undefined,
          strokeIndexes: complete(t.strokeIndexes)
            ? rankStrokeIndexes(t.strokeIndexes)
            : undefined,
          pars: complete(t.pars)
            ? t.pars.map((p) => (p >= 3 && p <= 6 ? p : 4))
            : undefined,
        }))
      : [{ id: 'tee-standard', name: 'Standard', rating: par, slope: 113 }]

  return normalizeTeeRatings({
    id: input.id,
    name: input.name,
    location: [input.city, input.state].filter(Boolean).join(', ') || undefined,
    holeCount: holes.length as 9 | 18,
    holes,
    teeSets,
    source: 'remote',
    updatedAt: new Date().toISOString(),
    revision: 1,
  })
}

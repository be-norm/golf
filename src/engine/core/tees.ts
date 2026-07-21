import type { Course, TeeSet } from './types'

/** True when `xs` is a permutation of 1..n (a valid stroke-index allocation). */
export function isStrokeIndexPermutation(xs: readonly number[]): boolean {
  const n = xs.length
  const seen = new Array<boolean>(n).fill(false)
  for (const x of xs) {
    if (!Number.isInteger(x) || x < 1 || x > n || seen[x - 1]) return false
    seen[x - 1] = true
  }
  return true
}

/**
 * Freeze a played tee's card into the course: overlay the tee's per-hole stroke
 * indexes / pars onto the holes, falling back to the course-wide HoleCore values
 * where the tee has none. Used at tee-off to build `Round.courseSnapshot` so the
 * whole (single-tee) round scores off the tee actually being played — the engine
 * keeps reading `courseSnapshot.holes` unchanged.
 *
 * Overlays are applied only when they line up with the holes (length match, and
 * for stroke index a valid 1..n permutation); otherwise that dimension is left
 * as the course-wide value. Never invents values — pure fallback.
 */
export function applyTee(course: Course, tee: TeeSet | undefined): Course {
  if (!tee) return course
  const n = course.holes.length
  const si =
    tee.strokeIndexes?.length === n && isStrokeIndexPermutation(tee.strokeIndexes)
      ? tee.strokeIndexes
      : undefined
  const pars = tee.pars?.length === n ? tee.pars : undefined
  if (!si && !pars) return course
  return {
    ...course,
    holes: course.holes.map((h, i) => ({
      ...h,
      strokeIndex: si?.[i] ?? h.strokeIndex,
      par: pars?.[i] ?? h.par,
    })),
  }
}

/** Total par for a tee (its per-hole pars where present, else course-wide). */
export function teePar(course: Course, tee: TeeSet | undefined): number {
  return course.holes.reduce((sum, h, i) => sum + (tee?.pars?.[i] ?? h.par), 0)
}

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

/**
 * A nine played twice around, as an 18-hole course: holes 1–9 mirrored to 10–18,
 * with each hole's 9-hole stroke index s becoming 2s−1 on the first loop and 2s
 * on the second (the odd-front/even-back convention every real 18-hole card
 * uses, and a clean 1..18 permutation). Tee ratings double — an 18-hole rating
 * for a doubled nine is twice the 9-hole rating — while slope is loop-independent
 * and per-tee par/SI/yardage rows are doubled to stay aligned with the holes.
 *
 * Used at tee-off only, to build `Round.courseSnapshot`: the library course stays
 * the 9-hole record it is, while the round scores as a normal 18 (so the full
 * handicap index applies via `courseHandicapForTee`, and every game engine —
 * Nassau's front/back, Wolf's rotation — works unchanged).
 */
export function doubleNine(course: Course): Course {
  if (course.holeCount !== 9 || course.holes.length !== 9) return course
  const twice = <T>(xs: readonly T[] | undefined): T[] | undefined => (xs ? [...xs, ...xs] : undefined)
  const loopSi = (si: number, secondLoop: boolean) => si * 2 - (secondLoop ? 0 : 1)
  return {
    ...course,
    holeCount: 18,
    holes: [...course.holes, ...course.holes].map((h, i) => ({
      ...h,
      number: i + 1,
      strokeIndex: loopSi(h.strokeIndex, i >= 9),
      // remember what each card number physically is, so the scoring screen can
      // say "hole 5, second time round" instead of an imaginary hole 14
      loop: { hole: h.number, nth: i < 9 ? 1 : 2 },
    })),
    teeSets: course.teeSets.map((t) => ({
      ...t,
      rating: t.rating * 2,
      yardages: twice(t.yardages),
      pars: twice(t.pars),
      strokeIndexes: t.strokeIndexes && [
        ...t.strokeIndexes.map((si) => loopSi(si, false)),
        ...t.strokeIndexes.map((si) => loopSi(si, true)),
      ],
    })),
  }
}

/** Total par for a tee (its per-hole pars where present, else course-wide). */
export function teePar(course: Course, tee: TeeSet | undefined): number {
  return course.holes.reduce((sum, h, i) => sum + (tee?.pars?.[i] ?? h.par), 0)
}

/**
 * Does this tee's rating look like the course's 18-HOLE rating on a 9-hole card?
 * A genuine 9-hole rating sits within a few strokes of 9-hole par, so anything
 * ~10+ over is an 18-hole number — and it inflates the (rating − par) term of
 * every course handicap on that course by ~30 strokes.
 *
 * The single definition of the heuristic, kept here beside `teePar` and
 * `courseHandicapForTee` because it is the same rating-dimension rule they
 * follow (CLAUDE.md invariant 6). Imports repair it (`normalizeTeeRatings`,
 * remote/transform.ts); the course editor only warns, since silently rewriting
 * a number the user typed is worse than flagging it.
 */
export function looksLikeEighteenHoleRating(course: Course, tee: TeeSet): boolean {
  return course.holeCount === 9 && tee.rating > teePar(course, tee) + 10
}

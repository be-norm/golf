import { teePar } from './tees'
import type { Course, TeeSet } from './types'

/** WHS course handicap: HI × (slope ÷ 113) + (rating − par), rounded to nearest integer. */
export function courseHandicap(
  handicapIndex: number,
  slope: number,
  rating: number,
  par: number,
): number {
  return Math.round(handicapIndex * (slope / 113) + (rating - par))
}

/**
 * Course handicap for a course as it is RATED — the one place a Handicap Index
 * becomes the number a round freezes into `RoundPlayer.courseHandicap`.
 *
 * An 18-hole course's rating/slope take the 18-hole index. A 9-hole course
 * carries 9-hole rating/slope, so WHS halves the index first (the 9-hole
 * Handicap Index) — without that, a nine hands out roughly double the strokes.
 *
 * Playing 9 of an 18-hole course is a DIFFERENT adjustment: there the course
 * handicap is halved, not the index, because (rating − par) is an 18-hole term.
 * That one belongs to the engine — see `nineOfEighteen` in context.ts.
 */
export function courseHandicapForTee(
  handicapIndex: number,
  course: Course,
  tee: TeeSet | undefined,
): number {
  // The dimension is a property of the COURSE, so it applies even on the
  // fallback path — a nine with no resolvable tee still plays off half the
  // index, never the full one.
  const effectiveIndex = course.holeCount === 9 ? handicapIndex / 2 : handicapIndex
  // no tee to rate against → the (scaled) index itself is the best answer
  if (!tee) return Math.round(effectiveIndex)
  return courseHandicap(effectiveIndex, tee.slope, tee.rating, teePar(course, tee))
}

/** Playing handicap after a percentage allowance, rounded to nearest integer. */
export function applyAllowance(courseHandicap: number, allowancePct: number): number {
  return Math.round((courseHandicap * allowancePct) / 100)
}

/**
 * Re-rank a subset of 18-hole stroke indexes into dense ranks 1..n.
 * Ties (invalid courses) break stably by position.
 */
export function rankStrokeIndexes(strokeIndexes: readonly number[]): number[] {
  const order = strokeIndexes
    .map((si, i) => ({ si, i }))
    .sort((a, b) => a.si - b.si || a.i - b.i)
  const ranks = new Array<number>(strokeIndexes.length)
  order.forEach(({ i }, pos) => {
    ranks[i] = pos + 1
  })
  return ranks
}

/**
 * Allocate a playing handicap across holes by stroke-index rank.
 * Positive handicaps receive strokes on the hardest (lowest-rank) holes first;
 * plus handicaps (negative) give strokes back on the easiest (highest-rank) holes first.
 * Invariant: sum(result) === playingHandicap.
 */
export function allocateStrokes(
  playingHandicap: number,
  strokeIndexes: readonly number[],
): number[] {
  const n = strokeIndexes.length
  if (n === 0) return []
  const ranks = rankStrokeIndexes(strokeIndexes)
  const base = Math.trunc(playingHandicap / n)
  const extra = playingHandicap - base * n
  return ranks.map((rank) => {
    if (extra > 0 && rank <= extra) return base + 1
    if (extra < 0 && rank > n + extra) return base - 1
    return base
  })
}

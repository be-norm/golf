/** WHS course handicap: HI × (slope ÷ 113) + (rating − par), rounded to nearest integer. */
export function courseHandicap(
  handicapIndex: number,
  slope: number,
  rating: number,
  par: number,
): number {
  return Math.round(handicapIndex * (slope / 113) + (rating - par))
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

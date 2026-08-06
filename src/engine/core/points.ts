import type { Uuid } from './types'

/**
 * The points kit: hand out a hole's prizes by rank, then turn a round's points
 * into money. Six Point and Wolf each had one half of this privately; Nines,
 * Aces & Deuces, Defender, Quota and Stableford need them both (MAI-49).
 */

/**
 * Rank slots — the field sorted by score, ties sharing the AVERAGE of the slots
 * they span. Every tie rule a rank-points game needs falls out of that one
 * sentence rather than being enumerated per game. With Six Point's `[4, 2, 0]`:
 *
 *   distinct scores      → 4 · 2 · 0
 *   two tie for low      → (4+2)/2 each → 3 · 3 · 0
 *   two tie for worst    → 4 · (2+0)/2 each → 4 · 1 · 1
 *   all three tie        → (4+2+0)/3 each → 2 · 2 · 2
 *
 * CHOOSE SLOTS SO EVERY TIE AVERAGE IS WHOLE, or points stop being integers and
 * the money that rides on them stops being cents. `[4,2,0]` and Nines' `[5,3,1]`
 * both satisfy it for every tie shape; `points.test.ts` pins that for the sets
 * we ship.
 *
 * NULL when the field doesn't match the slots — the hole has no distribution,
 * which is Six Point's existing "void". Deliberately not a throw: `deriveRound`
 * has no try/catch and reducers stay total (catalog.ts), so throwing here is a
 * live round crashing over a missing score. Returning null puts the constraint
 * IN the choke point, where a game that forgets to pre-check still cannot
 * compute a bogus distribution.
 */
export function rankPoints(
  scored: readonly { id: Uuid; score: number }[],
  slots: readonly number[],
): Record<Uuid, number> | null {
  if (scored.length !== slots.length) return null
  const sorted = [...scored].sort((a, b) => a.score - b.score)
  const points: Record<Uuid, number> = {}
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && sorted[j]!.score === sorted[i]!.score) j++
    const span = slots.slice(i, j)
    const avg = span.reduce((a, b) => a + b, 0) / span.length
    for (let k = i; k < j; k++) points[sorted[k]!.id] = avg
    i = j
  }
  return points
}

/**
 * Points → money, pairwise: `moneyᵢ = perPointCents × (n · pointsᵢ − Σpoints)`.
 *
 * Read it as "the gap between you and each other player, at the stake" — which
 * is why it is zero-sum by construction for any number of players: summing
 * `n·pᵢ − Σp` over the field gives `n·Σp − n·Σp`.
 *
 * Σ is taken over `playerIds`, NOT over the map's own values. The guarantee is
 * zero-sum across the ROUND'S ROSTER; sourcing the total from the map would let
 * one stray key silently break the one helper sold as unbreakable.
 *
 * Six Point's `(points − 2) × stake` is this formula divided by n (n=3, Σ=6),
 * and is deliberately NOT folded in: its stake means "per point above the
 * average" where this one means "per point of gap against each opponent". Same
 * shape, different unit — folding them would silently triple Six Point's money.
 */
export function pointsToMoney(
  playerIds: readonly Uuid[],
  points: ReadonlyMap<Uuid, number>,
  perPointCents: number,
): Record<Uuid, number> {
  const n = playerIds.length
  const total = playerIds.reduce((sum, id) => sum + (points.get(id) ?? 0), 0)
  return Object.fromEntries(
    playerIds.map((id) => [id, perPointCents * (n * (points.get(id) ?? 0) - total)]),
  )
}

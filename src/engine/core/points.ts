import type { Uuid } from './types'

/**
 * The points kit: hand out a hole's prizes by rank, then turn a round's points
 * into money. Six Point and Wolf each had one half of this privately.
 *
 * `rankPoints` is for games that rank a field and split fixed prizes — Nines,
 * Aces & Deuces, Defender. `pointsToMoney` settles any game that keeps a
 * running point total, which is those plus Stableford and Quota (they award
 * points off a table, with no ranking step) (MAI-49).
 *
 * `pointsToMoney` currently has NO production caller. Wolf was the one, and it
 * moved off: its "points" turned out to be per-hole stakes rather than a score
 * to be differenced, so settling them through a gap formula multiplied them
 * (MAI-83). The helper is right for the games named above — they genuinely
 * accumulate non-negative scores and settle on the spread — and is kept, tested,
 * waiting for the first of them. Before reaching for it, check that the game's
 * points are a SCORE and not already the money.
 */

/**
 * Rank slots — the field sorted by score ASCENDING (golf: lowest wins, so slot
 * 0 goes to the lowest `score`), ties sharing the AVERAGE of the slots they
 * span. Every tie rule a rank-points game needs falls out of that one sentence
 * rather than being enumerated per game. With Six Point's `[4, 2, 0]`:
 *
 *   distinct scores      → 4 · 2 · 0
 *   two tie for low      → (4+2)/2 each → 3 · 3 · 0
 *   two tie for worst    → 4 · (2+0)/2 each → 4 · 1 · 1
 *   all three tie        → (4+2+0)/3 each → 2 · 2 · 2
 *
 * A HIGHER-IS-BETTER game must negate before calling: pass Stableford points as
 * `-points` or the top slot goes to the worst player, which is a settlement that
 * is exactly inverted and still perfectly zero-sum — no property test can see it.
 *
 * NULL in two cases, both of which mean "this hole has no distribution" — which
 * is Six Point's existing "void":
 *
 *  1. The field doesn't match the slots (a missing score). A runtime condition.
 *  2. A tie average isn't a whole number. That is a CHOICE OF SLOTS being wrong,
 *     and it is refused rather than described, because CLAUDE.md invariant #3 is
 *     that money is integer cents: `[4,3,0]` ties two low players at 3.5, and
 *     `pointsToMoney` would happily settle that as half a cent. `[4,2,0]` and
 *     Nines' `[5,3,1]` satisfy it for every tie shape. A game wired to slots
 *     that don't will void its first tied hole and its golden test will say so
 *     immediately — far better than money that doesn't reconcile.
 *
 * Deliberately not a throw for either: `deriveRound` has no try/catch and
 * reducers stay total (catalog.ts), so throwing here is a live round crashing
 * over a missing score.
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
    // the slot-choice constraint, enforced rather than described
    if (!Number.isInteger(avg)) return null
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

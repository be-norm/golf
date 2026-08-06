import type { Settlement } from './money'
import type { RoundPlayer, StandingLine, Uuid } from './types'

/**
 * The standings every game shows: one row per player, richest first, each
 * carrying whatever that game counts in ("3 skins", "6 pts", "F9 ✓3&2").
 *
 * All five shipped engines built this by hand, identically, differing only in
 * the `detail` string — five copies of a sort and a lookup, one of which would
 * eventually order its rows differently from the rest for no reason a player
 * could see. It lives in its own module rather than beside the points helpers
 * because Skins and Nassau are not points games and their imports should not
 * imply they are.
 */
export function standingsFromSettlement(
  players: readonly RoundPlayer[],
  settlement: Settlement,
  /** what this game counts in, for the row's subtitle */
  detail?: (player: RoundPlayer) => string | undefined,
): StandingLine[] {
  return players
    .map((p) => ({
      id: p.playerId as Uuid,
      label: p.name,
      detail: detail?.(p),
      amountCents: settlement.perPlayerCents[p.playerId] ?? 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents)
}

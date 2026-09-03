import type { GameDerivation } from '../engine/catalog'
import { combineSettlements } from '../engine/core/money'
import type { Round, Uuid } from '../engine/core/types'

export interface StandingRow {
  playerId: Uuid
  name: string
  cents: number
  /** exactly one player, and only when they're actually up */
  leader: boolean
}

/**
 * WHERE EVERYONE STANDS ACROSS EVERY BET — one rule, because two surfaces ask.
 *
 * The settle screen (and the share card painted from the same model) has always
 * shown this. The scoring screen's standings sheet now leads with it too: it
 * used to open straight into a per-bet breakdown, so "am I up or down?" — the
 * first question anyone opening it has — could only be answered by adding the
 * games up in your head.
 *
 * Living here rather than in either feature is the `gameRoles.ts` reason: a
 * number the group reads mid-round and a number they settle up on MUST be the
 * same number, and the way that stops being true is two files computing it.
 *
 * EVERY PLAYER, including the ones sitting on zero — being square is a real
 * position mid-round, and a roster that grows and shrinks as money moves is
 * harder to read than one that doesn't. (The settle screen's `settle` list is
 * the opposite and rightly so: a payout of nothing is not a payment.)
 *
 * Zero-sum (invariant #3) means these always add to nothing, which is what
 * makes "richest first" a total order over the whole group rather than a
 * ranking of winners with the losers appended.
 */
export function roundStandings(
  players: Round['players'],
  derivations: Iterable<GameDerivation>,
): StandingRow[] {
  const combined = combineSettlements(
    players.map((p) => p.playerId),
    [...derivations].map((d) => d.settlement),
  )
  return [...players]
    .sort((a, b) => (combined[b.playerId] ?? 0) - (combined[a.playerId] ?? 0))
    .map((p, i) => ({
      playerId: p.playerId,
      name: p.name,
      cents: combined[p.playerId] ?? 0,
      leader: i === 0 && (combined[p.playerId] ?? 0) > 0,
    }))
}

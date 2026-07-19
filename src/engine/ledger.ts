import { deriveRound, type GameDerivation } from './catalog'
import type { RoundEvent } from './core/events'
import { deriveGross, effectiveEvents } from './core/replay'
import type { Round, Uuid } from './core/types'

export interface HoleImpact {
  hole: number
  /** the game's own explanation of the hole (from holeSummary) */
  summary: string[]
  /** money that moved ON this hole, per player (non-zero entries only) */
  deltas: { playerId: Uuid; cents: number }[]
  /** running settlement AFTER this hole, per player */
  runningCents: Record<Uuid, number>
}

function eventHole(e: RoundEvent): number | null {
  if (e.type === 'score/set' || e.type === 'score/clear') return e.hole
  if (e.type === 'game/event') {
    const h = (e.data as { hole?: unknown } | null)?.hole
    return typeof h === 'number' ? h : null
  }
  return null
}

/**
 * Where the money moved, hole by hole, for every game — derived by replaying
 * the event log prefix-by-prefix, so it is exactly the engine's math.
 * A hole's delta is the settlement swing caused by knowing that hole
 * (a 3-skin carry banked on 4 shows as one +3-skin move on 4; a nassau bet
 * flipping from all-square pays out on the hole that flipped it).
 */
export function buildHoleLedger(
  round: Round,
  events: readonly RoundEvent[],
  holesPlayed: readonly number[],
  full: ReadonlyMap<Uuid, GameDerivation>,
): Map<Uuid, HoleImpact[]> {
  const ledger = new Map<Uuid, HoleImpact[]>(round.games.map((g) => [g.gameId, []]))
  let prev = new Map<Uuid, Record<Uuid, number>>(round.games.map((g) => [g.gameId, {}]))

  // A hole earns a ledger row only once it exists in play: money moved, or the
  // game has something to say about a hole somebody actually scored. Keeps
  // chatty engines (wolf announces its wolf pre-round) out of the ledger.
  const gross = deriveGross(effectiveEvents(events))
  const hasScore = (hole: number) =>
    round.players.some((p) => gross.get(p.playerId)?.get(hole) !== undefined)

  // Round completion finalizes everything at once — attribute the money it
  // locks to the last hole anyone actually played (an early-finished round
  // must not show money moving on an unplayed hole 18).
  const scoredHoles = events
    .filter((e): e is Extract<RoundEvent, { type: 'score/set' }> => e.type === 'score/set')
    .map((e) => e.hole)
    .filter((h) => holesPlayed.includes(h))
  const completionHole = scoredHoles.length
    ? Math.max(...scoredHoles)
    : holesPlayed[holesPlayed.length - 1]
  for (const hole of holesPlayed) {
    const prefix = events.filter((e) => {
      if (e.type === 'round/completed' || e.type === 'round/reopened') return hole >= completionHole!
      const eh = eventHole(e)
      return eh === null || eh <= hole
    })
    const { derivations } = deriveRound(round, prefix)
    const next = new Map<Uuid, Record<Uuid, number>>()
    for (const game of round.games) {
      const cents = derivations.get(game.gameId)?.settlement.perPlayerCents ?? {}
      const before = prev.get(game.gameId) ?? {}
      const deltas = round.players
        .map((p) => ({
          playerId: p.playerId,
          cents: (cents[p.playerId] ?? 0) - (before[p.playerId] ?? 0),
        }))
        .filter((d) => d.cents !== 0)
      const summary = full.get(game.gameId)?.holeSummary(hole) ?? []
      if (deltas.length > 0 || (summary.length > 0 && hasScore(hole))) {
        ledger.get(game.gameId)!.push({ hole, summary, deltas, runningCents: cents })
      }
      next.set(game.gameId, cents)
    }
    prev = next
  }
  return ledger
}

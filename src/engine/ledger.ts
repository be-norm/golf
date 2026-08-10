import { deriveRound, type GameDerivation } from './catalog'
import type { RoundContext } from './core/context'
import type { RoundEvent } from './core/events'
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

/**
 * Which hole an event belongs to, or null for one that belongs to the round as
 * a whole (completion, and anything unrecognised).
 *
 * NULL MEANS "EVERY PREFIX" — the filter below keeps such events in all of
 * them — so an event that IS about a hole and answers null here silently leaks
 * backwards: hole 18's fact would be visible while replaying hole 1. Nothing
 * reads putts yet, so `score/putts` costs nothing today and would have cost
 * Snake its ledger, where it would have looked like Snake's bug rather than
 * this function's. A new hole-scoped event kind belongs here the moment it is
 * added, not when its first consumer arrives.
 */
export function eventHole(e: RoundEvent): number | null {
  if (
    e.type === 'score/set' ||
    e.type === 'score/clear' ||
    e.type === 'score/putts' ||
    e.type === 'score/puttsClear'
  ) {
    return e.hole
  }
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
  ctx: RoundContext,
  full: ReadonlyMap<Uuid, GameDerivation>,
): Map<Uuid, HoleImpact[]> {
  const holesPlayed = ctx.holesPlayed
  const ledger = new Map<Uuid, HoleImpact[]>(round.games.map((g) => [g.gameId, []]))
  let prev = new Map<Uuid, Record<Uuid, number>>(round.games.map((g) => [g.gameId, {}]))

  // A hole earns a ledger row only once it exists in play: money moved, or the
  // game has something to say about a hole somebody actually scored. Keeps
  // chatty engines (wolf announces its wolf pre-round) out of the ledger.
  //
  // Takes the round context rather than re-deriving gross, so this predicate is
  // the SAME one the engines narrate by (`ctx.anyScored`). It gates whether a
  // row exists at all, so a private copy here means one rule deciding where a
  // close is explained and another deciding whether that row survives.
  const hasScore = (hole: number) => ctx.anyScored(hole)

  // "EARLIER" IS A POSITION, NOT A LOWER NUMBER. A round can tee off on any
  // hole and wrap (MAI-41), so on an 18 from 10 the prefix "as of hole 12" must
  // exclude holes 1–9 — which are played LAST — and include 13–18, which are
  // played before it. Comparing hole numbers put every delta on the wrong row.
  const positionOf = new Map(holesPlayed.map((h, i) => [h, i]))

  // Round completion finalizes everything at once — attribute the money it
  // locks to the last hole anyone actually played (an early-finished round
  // must not show money moving on an unplayed hole 18).
  const scored = new Set(
    events
      .filter((e): e is Extract<RoundEvent, { type: 'score/set' }> => e.type === 'score/set')
      .map((e) => e.hole),
  )
  const completionHole =
    [...holesPlayed].reverse().find((h) => scored.has(h)) ?? holesPlayed[holesPlayed.length - 1]
  const completionIdx = completionHole === undefined ? -1 : positionOf.get(completionHole)!
  holesPlayed.forEach((hole, idx) => {
    const prefix = events.filter((e) => {
      if (e.type === 'round/completed' || e.type === 'round/reopened') return idx >= completionIdx
      const eh = eventHole(e)
      // An event naming a hole this round doesn't play stays in EVERY prefix
      // (`?? -1`), because that is what the FULL derivation does — it filters
      // nothing — and the last ledger row has to agree with the settle screen.
      return eh === null || (positionOf.get(eh) ?? -1) <= idx
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
  })
  return ledger
}

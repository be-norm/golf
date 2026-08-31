import { amendRound, deriveRound } from '../engine/catalog'
import { canonicalJson } from '../engine/core/setup'
import { effectiveEvents } from '../engine/core/replay'
import { combineSettlements } from '../engine/core/money'
import type { EventDraft, RoundEvent } from '../engine/core/events'
import type { GameConfig, Round, Uuid } from '../engine/core/types'

/**
 * WHAT A SETTINGS CHANGE WOULD DO TO THE MONEY, before it is written (MAI-100).
 *
 * An amendment re-prices the whole round, including holes that are already
 * settled and already read out. That is the correct behaviour and it is also
 * the alarming one, so the editor states it in numbers rather than leaving the
 * group to notice the bar move afterwards.
 */
export interface SettlementSwing {
  playerId: Uuid
  name: string
  /** what this change is worth to them, signed */
  cents: number
}

/**
 * WHAT THIS AMENDMENT WOULD DO, in the two ways a bet can be affected.
 *
 * `swing` is money that would MOVE. `riding` is the other half, and it is not
 * decoration: a bet that settles only at the end — the snake, a live carry —
 * has a real position and zero settlement, so an amendment to it changes what
 * somebody is carrying while moving no money at all. Reporting only the swing
 * told the group "No change to the money" about the very edit they had just
 * made, which reads as "that did nothing".
 *
 * `openBet` is the field for exactly this ("a live bet the money cannot show
 * yet", catalog.ts), so the preview asks the same channel the pinned bar does
 * rather than inventing a second idea of an unsettled position.
 */
export interface AmendmentImpact {
  swing: SettlementSwing[]
  /**
   * WHERE THIS LEAVES THE LIVE BETS — every open position after the change, in
   * the game's own words, marked when the change doesn't move it.
   *
   * DELIBERATELY NOT "the positions that CHANGED", which is what it was first.
   * Filtering to changes made the panel fall through to its empty state on a
   * real edit whenever the numbers happened to land in the same place — turn
   * doubling on and drop a $1 snake to 25c after three bites and the holder owes
   * 25c×2×2 = exactly the $1 they already owed, so nothing "changed" and the
   * screen said "no money moves" about an edit that had just switched doubling
   * on. True about what has happened, and wrong about what the group asked.
   *
   * Answering "what does this leave me with" instead is both harder to make
   * misleading and the more useful question: the next bite goes to $2.
   */
  riding: { position: string; changed: boolean }[]
}

/**
 * Derive the round twice — as it stands, and with `pending` appended — and
 * report every difference the two channels can express.
 *
 * IT DERIVES THE PENDING EVENT, not a hypothetical round, and that is what makes
 * the answer exact rather than a good guess: the preview runs the identical fold
 * the append will run, through the identical engines. A hand-built "round with
 * the new config" would instead be a second implementation of `amendRound`,
 * free to disagree with it — and the one thing this screen must not do is
 * promise a swing the save doesn't deliver.
 *
 * The synthetic envelope is local and never stored. `seq` continues the log so
 * `effectiveEvents` orders it last; the id cannot collide with anything, since
 * only a `meta/retract` looks ids up and none targets this.
 */
export function amendmentImpact(
  round: Round,
  events: readonly RoundEvent[],
  pending: readonly EventDraft[],
): AmendmentImpact {
  if (pending.length === 0) return { swing: [], riding: [] }
  const lastSeq = events.reduce((max, e) => Math.max(max, e.seq), 0)
  const proposed: RoundEvent[] = [
    ...events,
    ...pending.map(
      (draft, i) =>
        ({
          ...draft,
          id: `preview-${i}`,
          roundId: round.id,
          seq: lastSeq + 1 + i,
          at: new Date().toISOString(),
          deviceId: '',
        }) as RoundEvent,
    ),
  ]

  const read = (source: readonly RoundEvent[]) => {
    const { round: amended, derivations } = deriveRound(round, source)
    return {
      totals: combineSettlements(
        amended.players.map((p) => p.playerId),
        [...derivations.values()].map((d) => d.settlement),
      ),
      open: new Map([...derivations].map(([gameId, d]) => [gameId, d.openBet])),
    }
  }
  const before = read(events)
  const after = read(proposed)

  const swing = round.players
    .map((p) => ({
      playerId: p.playerId,
      name: p.name,
      cents: (after.totals[p.playerId] ?? 0) - (before.totals[p.playerId] ?? 0),
    }))
    .filter((s) => s.cents !== 0)

  const riding = [...after.open].flatMap(([gameId, open]) =>
    open === undefined ? [] : [{ position: open, changed: open !== before.open.get(gameId) }],
  )

  return { swing, riding }
}

/**
 * Has anything actually changed? The editor asks before writing, because an
 * amendment that says nothing is still permanent in an append-only log that
 * syncs and exports — the same rule the scoring screen's input channel follows
 * ("re-picking what is already in effect must write nothing").
 *
 * Compared through `canonicalJson`, the one definition of "same setting" this
 * app has — so the editor cannot judge it differently from `amendRound`'s locked
 * check or `duplicateInstanceProblems`.
 */
export function settingsChanged(before: GameConfig, after: GameConfig): boolean {
  const key = (g: GameConfig) =>
    canonicalJson({ config: g.config, handicap: g.handicap, role: g.role })
  return key(before) !== key(after)
}

/**
 * Games this round used to hold — what a `game/removed` took out, with the
 * settings it had at the moment it went (MAI-103).
 *
 * RECOVERED BY RE-FOLDING THE PREFIX before each removal, rather than carried
 * on the removal event. A payload holding its own copy of the game would be a
 * second source of those settings, free to disagree with the fold about what
 * was actually in the round — and the fold is the authority everywhere else.
 *
 * Only games still absent at the end are returned, so a bet removed and put
 * back doesn't linger in the "removed" list.
 */
export function removedGames(round: Round, events: readonly RoundEvent[]): GameConfig[] {
  const effective = effectiveEvents(events)
  const out = new Map<Uuid, GameConfig>()
  effective.forEach((e, i) => {
    if (e.type !== 'game/removed') return
    const before = amendRound(round, effective.slice(0, i))
    const game = before.games.find((g) => g.gameId === e.gameId)
    if (game) out.set(e.gameId, game)
  })
  // …minus anything that came back. `amendRound` over the whole log is the one
  // answer to "what is in this round now".
  for (const game of amendRound(round, effective).games) out.delete(game.gameId)
  return [...out.values()]
}

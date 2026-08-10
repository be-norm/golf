import { z } from 'zod'
import type { GameEngine, GameDerivation } from '../../catalog'
import { deriveAwardPot, type AwardHoleResult } from '../../core/awardPot'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { formatCents } from '../../core/money'
import { duplicateInstanceProblems } from '../../core/setup'
import { standingsFromSettlement } from '../../core/standings'
import { latestHoleSummary, summaryString } from '../../core/summary'
import type { GameConfig, HandicapSettings, RoundPlayer } from '../../core/types'

export const ctpConfigSchema = z.object({
  /** what the closest tee shot is worth; the winner collects this from each other player */
  stakeCents: z.number().int().positive(),
})

export type CtpConfig = z.infer<typeof ctpConfigSchema>

/** The award kit's classification, under the name this game's tests know it by. */
export type CtpHoleResult = AwardHoleResult

export interface CtpDerivation extends GameDerivation {
  holeResults: CtpHoleResult[]
}

/** The one group label — the award grid's row, and every sentence about it. */
const GROUP = 'Closest to the pin'

function derive(
  game: GameConfig<CtpConfig>,
  events: readonly GameScopedEvent[],
  ctx: RoundContext,
): CtpDerivation {
  const { stakeCents } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  // Par 3s only, and the engine answers that off the frozen course snapshot —
  // which is what lets the award grid stay generic and offer nothing elsewhere.
  // Everything else — last-write-wins, when a hole is decided, when an unawarded
  // one is dead, what an undo retracts — is the shared kit's (core/awardPot.ts).
  const { holeResults, settlement, wonByPlayer, awards } = deriveAwardPot(ctx, events, {
    gameId: game.gameId,
    stakeCents,
    eligible: (hole) => ctx.par(hole) === 3,
    group: GROUP,
    eventKind: 'ctp/award',
    // JUST THE HOLE AND THE NAME. Every surface that renders a settlement
    // line puts the game's own label directly above it — the settle panel and
    // the share card both head the block with `gameLabel` — so spelling the
    // game out again gave three lines reading "closest to the pin" under a
    // heading reading CLOSEST TO THE PIN.
    lineLabel: (hole, winner) => `Hole ${hole} — ${winner}`,
  })

  const unclaimed = holeResults.filter((r) => r.kind === 'unclaimed').map((r) => r.hole)
  // Money nobody collected is something to SAY, not a $0 settlement line —
  // that would make `lines.length === 0`, the settle panel's "No money moved."
  // signal, false on exactly the round it was written for (MAI-40).
  const notes =
    unclaimed.length > 0
      ? [
          // NOT PREFIXED WITH THE GAME. Every surface renders a note inside
          // the game's own block, and the grouped side-bets panel prefixes it
          // with the name itself — so naming it here produced "Closest to the
          // Pin: Closest to the pin went unclaimed on hole 7".
          `Unclaimed on ${unclaimed.length === 1 ? 'hole' : 'holes'} ` +
            `${unclaimed.join(', ')} — nobody was given ` +
            `${unclaimed.length === 1 ? 'it' : 'them'}, so nothing was paid`,
        ]
      : undefined
  // No count-instead-of-list branch here, unlike Long Drive: a card holds about
  // four par 3s, so the list is always short enough to read.

  const ctpLabel = (n: number) => `${n} CTP${n === 1 ? '' : 's'}`
  const standings = standingsFromSettlement(players, settlement, (p) =>
    ctpLabel(wonByPlayer.get(p.playerId) ?? 0),
  )

  // Bar recaps the latest decided hole — "H7 · Rob closest".
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const r = holeResults.find((h) => h.hole === hole)
      if (r?.kind === 'won') return `${nameOf.get(r.winnerId)} closest`
      if (r?.kind === 'unclaimed') return 'nobody inside'
      return null
    },
    'no CTP yet',
  )

  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r || r.kind === 'pending') return []
    if (r.kind === 'unclaimed') {
      return [
        'Unclaimed',
        '↳ nobody was given it by the end of the round, so the hole paid nothing',
      ]
    }
    // The non-obvious part of a CTP is never who won it — it is what a small
    // stake actually swings once every other player pays it. With nobody to
    // pay it (a one-player round, which `importRound` accepts) there is no
    // swing to explain, and the settlement has no line either.
    const others = playerIds.length - 1
    // The hole ledger heads its list with the game, and the standings sheet
    // heads the block with it — so this says who, not what game it was.
    if (others === 0) return [`${nameOf.get(r.winnerId)} closest`]
    return [
      `${nameOf.get(r.winnerId)} closest`,
      `↳ ${formatCents(stakeCents)} from each of ${others} other player${others === 1 ? '' : 's'}` +
        ` — ${formatCents(stakeCents * others)}`,
    ]
  }

  return {
    standings,
    summary: summaryString(summaryParts),
    summaryParts,
    holeSummary,
    requiredInputs: () => [],
    awards,
    settlement,
    notes,
    holeResults,
  }
}

/** The one name for this game — `meta.name` and every message that has to
 *  say it. label.ts is the single source of a game's name (MAI-42), so a
 *  second literal in `validateSetup` would drift the moment this is renamed. */
const CTP_NAME = 'Closest to the Pin'

export const ctpEngine: GameEngine<CtpConfig> = {
  type: 'ctp',
  meta: {
    name: CTP_NAME,
    blurb: 'Closest tee shot on every par 3 collects from the rest.',
    minPlayers: 2,
    maxPlayers: 8,
    // The first true side bet in the catalog. Nobody plays a round OF closest
    // to the pin — it rides alongside whatever the group is actually playing.
    category: 'side',
    family: 'award',
    shapes: ['solo'],
    // Handicaps have nothing to say here, so setup does not offer them.
    grossOnly: true,
    rules: {
      tagline: 'Every par 3 is worth money to whoever stiffs it.',
      howToPlay: [
        'On every par 3, whoever hits the closest tee shot that stays on the green wins the hole’s CTP.',
        'Tap their name in the award grid under the scores. You can record it whenever you like — on the tee, at the turn, or on the 18th green.',
        'Tap the lit name again to clear the hole; tap a different name to correct it.',
        'Nobody given it by the end of the round? That hole pays nothing — it is reported, not settled.',
      ],
      scoring: [
        'The winner of a par 3 collects the stake from every other player. At $2 in a foursome that is $6 to them and $2 from each of the others.',
        'Handicaps do not apply — it is a contest of one tee shot, not of scores.',
        'Every par 3 in the holes you are playing stands on its own. Nothing carries.',
      ],
      terms: [
        { term: 'CTP', def: 'Closest to the pin — the shortest putt left after the tee shot on a par 3.' },
        {
          term: 'On the green',
          def: 'The usual house rule: the ball has to finish on the putting surface to count.',
        },
        { term: 'Unclaimed', def: 'A par 3 nobody was given — the hole simply pays nothing.' },
      ],
    },
  },
  configSchema: ctpConfigSchema,
  configFields: [
    {
      key: 'stakeCents',
      kind: 'money',
      label: 'Per par 3',
      min: 25,
      step: 25,
      hint: 'The winner collects this from every other player',
    },
  ],
  defaultConfig: () => ({ stakeCents: 200 }),
  // GROSS, and not a default anyone should flip: a tee shot is measured with a
  // tape, not against a handicap. It also keeps CTP out of `strokeGame`, so a
  // cheap side bet can never capture the scoring screen's stroke dots.
  defaultHandicap: (): HandicapSettings => ({
    mode: 'gross',
    allowancePct: 100,
    reference: 'absolute',
  }),
  validateSetup: (
    config: GameConfig<CtpConfig>,
    players: readonly RoundPlayer[],
    siblings: readonly GameConfig[],
  ) => {
    const problems: string[] = []
    if (players.length < 2) problems.push(`${CTP_NAME} needs at least 2 players`)
    if (!ctpConfigSchema.safeParse(config.config).success) {
      problems.push('Invalid closest to the pin configuration')
    }
    // "There is no par 3 in these holes" would be the useful check and cannot
    // live here: validateSetup sees the config, the roster and its siblings —
    // never the course. The award grid simply offers nothing, which is the
    // honest degradation.
    problems.push(...duplicateInstanceProblems(config, siblings, CTP_NAME))
    return problems
  },
  eventKinds: {
    'ctp/award': z.object({
      hole: z.number().int().min(1).max(18),
      playerId: z.string(),
    }),
  },
  derive,
}

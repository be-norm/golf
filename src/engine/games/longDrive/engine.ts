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

export const longDriveConfigSchema = z.object({
  /** what one hole's long drive is worth; the winner collects it from each other player */
  stakeCents: z.number().int().positive(),
  /**
   * Which holes carry the bet.
   *
   * A RULE or a LIST, in one field, because the group decides it either way:
   * "the par 5s" is how most rounds are played and "13 and 15" is how the rest
   * are. `.min(1)` rather than `.nonempty()` — zod 4 types the latter as
   * `[number, ...number[]]`, which buys nothing here and complicates every
   * caller. An empty list is refused in `validateSetup`, where the user can
   * read why.
   */
  holes: z.union([
    z.literal('par5s'),
    z.literal('all'),
    z.array(z.number().int().min(1).max(18)).min(1),
  ]),
})

export type LongDriveConfig = z.infer<typeof longDriveConfigSchema>

/** The award kit's classification — a designated hole is won, pending or, once
 *  the round is over and nobody was given it, unclaimed. */
export type LongDriveHoleResult = AwardHoleResult

export interface LongDriveDerivation extends GameDerivation {
  holeResults: LongDriveHoleResult[]
  /** designated holes this round actually plays — empty means the bet is inert */
  designated: number[]
}

/** The one group label — the award grid's row, and every sentence about it. */
const GROUP = 'Long drive'

/** "3 long drives" — the counted form of `GROUP`, so a rename reaches both. */
const driveLabel = (n: number) => `${n} ${GROUP.toLowerCase()}${n === 1 ? '' : 's'}`

function derive(
  game: GameConfig<LongDriveConfig>,
  events: readonly GameScopedEvent[],
  ctx: RoundContext,
): LongDriveDerivation {
  const { stakeCents, holes } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  /**
   * Which holes carry the bet.
   *
   * `>= 5` rather than `=== 5`: a par 6 is a longer hole than a par 5, and a
   * long-drive bet that skipped the longest hole on the card would be absurd.
   * Rare enough that `meta.rules` says so rather than the option's label.
   *
   * A custom list is intersected with the round by construction — the kit only
   * asks about holes in `ctx.holesPlayed` — so a list left over from a longer
   * range narrows rather than breaking. Nothing prunes it in setup: rewriting
   * somebody's config behind their back is worse than narrowing it here, and
   * `validateSetup` cannot see the course to do it honestly anyway.
   */
  const eligible = (hole: number): boolean =>
    holes === 'all' ? true : holes === 'par5s' ? ctx.par(hole) >= 5 : holes.includes(hole)

  const designated = ctx.holesPlayed.filter(eligible)

  const { holeResults, settlement, wonByPlayer, awards } = deriveAwardPot(ctx, events, {
    gameId: game.gameId,
    stakeCents,
    eligible,
    group: GROUP,
    eventKind: 'longDrive/award',
    lineLabel: (hole, winner) => `Hole ${hole} — ${winner} longest drive`,
  })

  const unclaimed = holeResults.filter((r) => r.kind === 'unclaimed').map((r) => r.hole)
  /**
   * TWO THINGS TO SAY, and only one of them is dead money.
   *
   * INERT is structural and true from the first tee: there is no par 5 in the
   * holes being played, so this bet can never pay anything. It is deliberately
   * NOT gated on `ctx.completed` the way every other note in the catalog is.
   * That gate exists because a thing is missing exactly when it can no longer
   * be supplied — right for an unclaimed hole, wrong here, where waiting until
   * the settle screen to mention it hides the one fact the group could have
   * acted on. `validateSetup` cannot catch it (it sees config, players and
   * siblings — never the course), so the round-start screen is where it lands.
   *
   * UNCLAIMED is the ordinary dead money, and follows CTP exactly.
   *
   * Both ride `notes` rather than a $0 settlement line: `lines.length === 0` is
   * the settle panel's "No money moved." signal, and a zero-cent row makes it
   * false on precisely the round it was written for (MAI-40).
   */
  const notes: string[] = []
  if (designated.length === 0) {
    notes.push(
      // Plain ASCII apart from the em dash every other note already paints:
      // `notes` reaches the share card's CANVAS, drawn in a pixel font with
      // sparse coverage, and a curly apostrophe there is a glyph gamble taken
      // inside a PNG people send each other. `meta.rules` below is HTML and
      // spends them freely.
      holes === 'par5s'
        ? 'No par 5s in the holes you are playing — long drive has nothing to play for'
        : 'None of the holes you are playing carry the long drive — nothing to play for',
    )
  }
  if (unclaimed.length > 0) {
    // NAME THEM WHILE NAMING THEM HELPS, then count them. CTP can enumerate
    // freely because a card holds about four par 3s; "every hole" here means up
    // to eighteen, and a group that tapped three of them would get a
    // fifteen-number sentence wrapped over four lines of the PAINTED share
    // card. Past a handful the list stops being something anybody reads.
    const them = unclaimed.length === 1 ? 'it' : 'them'
    notes.push(
      unclaimed.length > 4
        ? `${driveLabel(unclaimed.length)} went unclaimed — nobody was given ${them}, so nothing was paid`
        : `${GROUP} went unclaimed on ${unclaimed.length === 1 ? 'hole' : 'holes'} ` +
          `${unclaimed.join(', ')} — nobody was given ${them}, so nothing was paid`,
    )
  }

  const standings = standingsFromSettlement(players, settlement, (p) =>
    driveLabel(wonByPlayer.get(p.playerId) ?? 0),
  )

  // Bar recaps the latest decided hole — "H8 · Rob longest".
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const r = holeResults.find((h) => h.hole === hole)
      if (r?.kind === 'won') return `${nameOf.get(r.winnerId)} longest`
      if (r?.kind === 'unclaimed') return 'nobody kept it'
      return null
    },
    designated.length === 0 ? 'no holes to play for' : 'no long drive yet',
  )

  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r || r.kind === 'pending') return []
    if (r.kind === 'unclaimed') {
      return [
        `${GROUP} — unclaimed`,
        '↳ nobody was given it by the end of the round, so the hole paid nothing',
      ]
    }
    // The non-obvious part is never who won it — it is what a small stake
    // actually swings once every other player pays it. With nobody to pay it
    // (a one-player round, which `importRound` accepts) there is no swing to
    // explain, and the settlement has no line either.
    const others = playerIds.length - 1
    if (others === 0) return [`${nameOf.get(r.winnerId)} longest drive`]
    return [
      `${nameOf.get(r.winnerId)} longest drive`,
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
    ...(notes.length > 0 && { notes }),
    holeResults,
    designated,
  }
}

/** The one name for this game — `meta.name` and every message that has to say
 *  it. label.ts is the single source of a game's name (MAI-42). */
const LONG_DRIVE_NAME = 'Long Drive'

export const longDriveEngine: GameEngine<LongDriveConfig> = {
  type: 'longDrive',
  meta: {
    name: LONG_DRIVE_NAME,
    blurb: 'Longest drive on the holes you nominate collects from the rest.',
    minPlayers: 2,
    maxPlayers: 8,
    category: 'side',
    family: 'award',
    shapes: ['solo'],
    // Handicaps have nothing to say here, so setup does not offer them.
    grossOnly: true,
    rules: {
      tagline: 'One swing on the big holes, and the money follows it.',
      howToPlay: [
        'Before you play, choose the holes it runs on — every par 5, every hole, or the ones you nominate.',
        'On a designated hole, whoever hits the longest drive that stays in play wins it. In the fairway is the usual house rule, and the group calls it — the app records who won, not where the ball finished.',
        'Tap their name in the award grid under the scores. Record it whenever you like — on the tee, at the turn, or on the 18th green.',
        'Tap the lit name again to clear the hole; tap a different name to correct it.',
        'Nobody given it by the end of the round? That hole pays nothing — it is reported, not settled.',
      ],
      scoring: [
        'The winner of a designated hole collects the stake from every other player. At $2 in a foursome that is $6 to them and $2 from each of the others.',
        'Handicaps do not apply — it is a contest of one swing, not of scores.',
        'Every designated hole stands on its own. Nothing carries.',
        '“Par 5s” means par 5 or longer, so a par 6 counts. If the holes you are playing hold none, the bet is inert and says so at the first tee.',
      ],
      terms: [
        { term: 'Long drive', def: 'The longest tee shot on a designated hole — usually only counted if it finishes in the fairway.' },
        { term: 'Designated hole', def: 'A hole this bet runs on: every par 5, every hole, or the ones you picked.' },
        { term: 'Unclaimed', def: 'A designated hole nobody was given — the hole simply pays nothing.' },
      ],
    },
  },
  configSchema: longDriveConfigSchema,
  configFields: [
    {
      key: 'stakeCents',
      kind: 'money',
      label: 'Per hole',
      min: 25,
      step: 25,
      hint: 'The winner collects this from every other player',
    },
    {
      key: 'holes',
      kind: 'holes',
      label: 'Holes',
      presets: [
        { value: 'par5s', label: 'Par 5s' },
        { value: 'all', label: 'Every hole' },
      ],
      customLabel: 'Pick them',
      hint: 'Which holes carry the bet',
    },
  ],
  defaultConfig: () => ({ stakeCents: 200, holes: 'par5s' }),
  // GROSS, and not a default anyone should flip: a drive is measured against
  // the other drives, not against a handicap. It also keeps Long Drive out of
  // `strokeGame`, so a cheap side bet can never capture the scoring screen's
  // stroke dots.
  defaultHandicap: (): HandicapSettings => ({
    mode: 'gross',
    allowancePct: 100,
    reference: 'absolute',
  }),
  validateSetup: (
    config: GameConfig<LongDriveConfig>,
    players: readonly RoundPlayer[],
    siblings: readonly GameConfig[],
  ) => {
    const problems: string[] = []
    if (players.length < 2) problems.push(`${LONG_DRIVE_NAME} needs at least 2 players`)
    // The empty custom list gets its own sentence. It is the one config mistake
    // this screen can actually catch — and the schema alone would reduce it to
    // "Invalid long drive configuration", which says nothing about what to tap.
    const picked = (config.config as LongDriveConfig | undefined)?.holes
    if (Array.isArray(picked) && picked.length === 0) {
      problems.push(`${LONG_DRIVE_NAME} needs at least one hole`)
    } else if (!longDriveConfigSchema.safeParse(config.config).success) {
      problems.push('Invalid long drive configuration')
    }
    // "None of these holes is a par 5" would be the other useful check and
    // cannot live here: validateSetup sees the config, the roster and its
    // siblings — never the course. The engine says it on `notes` instead, from
    // the first tee, which is the honest degradation.
    problems.push(...duplicateInstanceProblems(config, siblings, LONG_DRIVE_NAME))
    return problems
  },
  eventKinds: {
    'longDrive/award': z.object({
      hole: z.number().int().min(1).max(18),
      playerId: z.string(),
    }),
  },
  derive,
}

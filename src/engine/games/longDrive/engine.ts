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
  /**
   * A designated hole nobody was given rolls its stake onto the NEXT DESIGNATED
   * hole — never onto an undesignated one, which is no part of this bet. The
   * mechanics live in `core/awardPot.ts`; every word about them lives here.
   *
   * OPTIONAL FOR DATA COMPATIBILITY, not indecision — see CTP's identical note.
   * `deriveRound` makes a game whose config its own engine rejects inert, so a
   * required key would silently empty every Long Drive round already stored.
   */
  carryover: z.boolean().optional(),
})

export type LongDriveConfig = z.infer<typeof longDriveConfigSchema>

/** The award kit's classification — a designated hole is won, pending or, once
 *  the round is over and nobody was given it, unclaimed. */
export type LongDriveHoleResult = AwardHoleResult

export interface LongDriveDerivation extends GameDerivation {
  holeResults: LongDriveHoleResult[]
  /** designated holes this round actually plays — empty means the bet is inert */
  designated: number[]
  /** long drives riding on the next designated hole, waiting to be won */
  carrying: number
  /** carried long drives that can never be won now — the round ended with them riding */
  carryDied: number
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
  // `=== true` rather than a truthiness read: the key is genuinely absent on
  // every round written before it existed, and this is the one place that
  // decides what absent means.
  const carryover = game.config.carryover === true
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))
  const others = playerIds.length - 1

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

  const { holeResults, settlement, wonByPlayer, awards, carrying, carryDied, diedAt } =
    deriveAwardPot(ctx, events, {
      gameId: game.gameId,
      stakeCents,
      eligible,
      group: GROUP,
      eventKind: 'longDrive/award',
      carryover,
      // Just the hole and the name — the panel heading already says the game.
      // The multiplier is the exception: without it a doubled hole reads as an
      // ordinary one at twice the money.
      lineLabel: (hole, winner, units) =>
        units > 1 ? `Hole ${hole} — ${winner} (${driveLabel(units)})` : `Hole ${hole} — ${winner}`,
    })

  const unclaimed = holeResults.filter((r) => r.kind === 'unclaimed').map((r) => r.hole)

  /**
   * ONE PHRASING OF THE DEATH, shared by the note and the hole ledger — Skins'
   * rule, and for its reason: a reader who meets the same event twice in two
   * wordings has to work out whether they are the same event.
   */
  const deadReason =
    `${driveLabel(carryDied)} died unwon — no designated hole left to win ` +
    `${carryDied === 1 ? 'it' : 'them'}`

  /**
   * THREE THINGS TO SAY, and only one of them is dead money.
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
   * A DEAD PILE is the carryover-on form of the same thing, and cannot coexist
   * with it: with carryovers on nothing is ever `unclaimed` (an unawarded hole's
   * value moved forward, and only the final pile is dead), and with them off
   * nothing ever carries. Mutually exclusive by construction rather than by an
   * `else`, so neither branch has to know about the other. INERT is orthogonal
   * to both and can accompany either.
   *
   * All of them ride `notes` rather than a $0 settlement line: `lines.length === 0`
   * is the settle panel's "No money moved." signal, and a zero-cent row makes it
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
        ? 'No par 5s in the holes you are playing — nothing to play for'
        : 'None of the holes you are playing carry this bet — nothing to play for',
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
      // Never prefixed with the game — see CTP. The grouped side-bets panel
      // attributes it, and every other surface has the heading right above.
      unclaimed.length > 4
        ? `${unclaimed.length} holes went unclaimed — nobody was given ${them}, so nothing was paid`
        : `Unclaimed on ${unclaimed.length === 1 ? 'hole' : 'holes'} ` +
          `${unclaimed.join(', ')} — nobody was given ${them}, so nothing was paid`,
    )
  }
  if (carryDied > 0) notes.push(deadReason)

  const standings = standingsFromSettlement(players, settlement, (p) =>
    driveLabel(wonByPlayer.get(p.playerId) ?? 0),
  )

  // Bar recaps the latest decided hole — "H8 · Rob longest".
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const r = holeResults.find((h) => h.hole === hole)
      if (r?.kind === 'won') {
        const name = nameOf.get(r.winnerId)
        return r.units > 1 ? `${name} longest · ${driveLabel(r.units)}` : `${name} longest`
      }
      if (r?.kind === 'unclaimed') return 'nobody kept it'
      if (r?.kind === 'carried') {
        // "carried" would promise a roll onto a designated hole that no longer
        // exists
        if (hole === diedAt) return `nobody kept it · ${driveLabel(carryDied)} died unwon`
        return `nobody kept it · ${r.carryAfter} carried`
      }
      return null
    },
    designated.length === 0 ? 'no holes to play for' : 'no long drive yet',
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
    if (r.kind === 'carried') {
      if (hole === diedAt) return ['Nobody kept it', `↳ ${deadReason}`]
      // The ↳ line teaches the rule that is genuinely non-obvious: a carry
      // walks past every hole this bet does not run on, however many there are.
      return [
        `Nobody kept it — ${r.carryAfter} carried`,
        '↳ it rolls onto the next designated hole — the holes in between do not count',
      ]
    }
    // The non-obvious part is never who won it — it is what a small stake
    // actually swings once every other player pays it. With nobody to pay it
    // (a one-player round, which `importRound` accepts) there is no swing to
    // explain, and the settlement has no line either.
    const fromEach = stakeCents * r.units
    const lines = [
      r.units > 1
        ? `${nameOf.get(r.winnerId)} longest — ${driveLabel(r.units)}`
        : `${nameOf.get(r.winnerId)} longest`,
    ]
    // …and WHY it is worth more than one: designated holes nobody kept, earlier.
    if (r.units > 1) lines.push(`↳ this designated hole + ${r.units - 1} carried in`)
    if (others > 0) {
      lines.push(
        `↳ ${formatCents(fromEach)} from each of ${others} other player${others === 1 ? '' : 's'}` +
          ` — ${formatCents(fromEach * others)}`,
      )
    }
    return lines
  }

  return {
    standings,
    summary: summaryString(summaryParts),
    summaryParts,
    /**
     * WHAT THE PINNED BAR'S MONEY AGGREGATE CANNOT SAY — see CTP's identical
     * note. A carry is worth nothing until somebody wins it, so a collapsed
     * side-bets row would read "no money yet" with $24 riding on the next par 5.
     *
     * `carrying + 1`, because that is `units` and `units` is what settles:
     * quoting the carried pile alone understates the hole the group is standing
     * on. `carrying > 0` is the whole guard — the kit zeroes it on a dead pile
     * and refuses to carry off the last designated hole, so a reported pile is
     * one some designated hole still holds, with its cell still tappable.
     */
    ...(carrying > 0 && {
      openBet:
        others > 0
          ? `${driveLabel(carrying + 1)} riding · ${formatCents((carrying + 1) * stakeCents * others)}`
          : `${driveLabel(carrying + 1)} riding`,
    }),
    holeSummary,
    requiredInputs: () => [],
    awards,
    settlement,
    ...(notes.length > 0 && { notes }),
    holeResults,
    designated,
    carrying,
    carryDied,
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
        'With carryovers off, a designated hole nobody was given simply pays nothing — it is reported, not settled.',
        'With carryovers on, that stake rolls onto the next designated hole instead, making it worth double. Only designated holes count: the ones in between are no part of this bet.',
        'If the last designated hole also goes unclaimed, the whole pile dies unwon.',
      ],
      scoring: [
        'The winner of a designated hole collects the stake from every other player. At $2 in a foursome that is $6 to them and $2 from each of the others.',
        'Handicaps do not apply — it is a contest of one swing, not of scores.',
        'Carryovers off: every designated hole stands on its own.',
        'Carryovers on: an unclaimed hole doubles the next designated one, and two in a row treble the one after.',
        '“Par 5s” means par 5 or longer, so a par 6 counts. If the holes you are playing hold none, the bet is inert and says so at the first tee.',
      ],
      terms: [
        { term: 'Long drive', def: 'The longest tee shot on a designated hole — usually only counted if it finishes in the fairway.' },
        { term: 'Designated hole', def: 'A hole this bet runs on: every par 5, every hole, or the ones you picked.' },
        { term: 'Unclaimed', def: 'A designated hole nobody was given — the hole simply pays nothing.' },
        {
          term: 'Carryover',
          def: 'An unclaimed hole’s stake rolling onto the next designated hole — never onto one this bet does not run on.',
        },
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
    {
      key: 'carryover',
      kind: 'boolean',
      label: 'Carryovers',
      hint: 'Unclaimed holes roll to the next designated one',
    },
  ],
  defaultConfig: () => ({ stakeCents: 200, holes: 'par5s', carryover: false }),
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

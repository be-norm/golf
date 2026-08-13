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
  /**
   * A par 3 nobody was given rolls its stake onto the NEXT PAR 3 — never onto a
   * par 4 or 5, which are not part of this bet at all. The mechanics live in
   * `core/awardPot.ts`; every word about them lives here.
   *
   * OPTIONAL, AND THAT IS DATA COMPATIBILITY RATHER THAN INDECISION. Every CTP
   * round already in IndexedDB and in the synced archive was written before this
   * key existed, and `deriveRound` makes a game whose config its own engine
   * rejects INERT — no grid, no money. A required boolean would therefore have
   * silently emptied every CTP round anybody has ever played. Absent reads as
   * off, which is what those rounds were.
   */
  carryover: z.boolean().optional(),
})

export type CtpConfig = z.infer<typeof ctpConfigSchema>

/** The award kit's classification, under the name this game's tests know it by. */
export type CtpHoleResult = AwardHoleResult

export interface CtpDerivation extends GameDerivation {
  holeResults: CtpHoleResult[]
  /** CTPs riding on the next par 3, waiting to be won */
  carrying: number
  /** carried CTPs that can never be won now — the round ended with them riding */
  carryDied: number
}

/** The one group label — the award grid's row, and every sentence about it. */
const GROUP = 'Closest to the pin'

/** "2 CTPs" — the counted form, so a rename or a re-pluralisation reaches every
 *  sentence at once (Long Drive's `driveLabel` is the same idea). */
const ctpLabel = (n: number) => `${n} CTP${n === 1 ? '' : 's'}`

function derive(
  game: GameConfig<CtpConfig>,
  events: readonly GameScopedEvent[],
  ctx: RoundContext,
): CtpDerivation {
  const { stakeCents } = game.config
  // `=== true` rather than a truthiness read: the key is genuinely absent on
  // every round written before it existed, and this is the one place that
  // decides what absent means.
  const carryover = game.config.carryover === true
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))
  const others = playerIds.length - 1

  // Par 3s only, and the engine answers that off the frozen course snapshot —
  // which is what lets the award grid stay generic and offer nothing elsewhere.
  // Everything else — last-write-wins, when a hole is decided, when an unawarded
  // one is dead, where a carry goes and when it dies, what an undo retracts — is
  // the shared kit's (core/awardPot.ts).
  const {
    holeResults,
    settlement,
    wonByPlayer,
    awards,
    carrying,
    carryDied,
    diedAt,
    awardedUnscored,
  } = deriveAwardPot(ctx, events, {
    gameId: game.gameId,
    stakeCents,
    eligible: (hole) => ctx.par(hole) === 3,
    group: GROUP,
    eventKind: 'ctp/award',
    carryover,
    // JUST THE HOLE AND THE NAME. Every surface that renders a settlement
    // line puts the game's own label directly above it — the settle panel and
    // the share card both head the block with `gameLabel` — so spelling the
    // game out again gave three lines reading "closest to the pin" under a
    // heading reading CLOSEST TO THE PIN. The multiplier is the exception:
    // without it a doubled hole reads as an ordinary one at twice the money.
    lineLabel: (hole, winner, units) =>
      units > 1 ? `Hole ${hole} — ${winner} (${ctpLabel(units)})` : `Hole ${hole} — ${winner}`,
  })

  /**
   * ONE PHRASING OF THE DEATH, shared by the note and the hole ledger — Skins'
   * rule, and for its reason: a reader who meets the same event twice in two
   * wordings has to work out whether they are the same event.
   *
   * "no par 3 left to win them" is what actually killed the pile. Not "nobody
   * hit the green", which is why any hole carries and would give the same
   * explanation for the opposite outcome.
   */
  const them = carryDied === 1 ? 'it' : 'them'
  const deadReason =
    `${ctpLabel(carryDied)} died unwon — ` +
    // WITH A SCORE, whenever a par 3 was given out and never scored. The plain
    // form asserts no par 3 was left, and the hole ledger shows THAT sentence
    // and not `notes` (`buildHoleLedger` renders `holeSummary` alone, and skips
    // the unscored hole's row entirely) — so on the scorecard the claim would
    // stand unaccompanied beside a grid still naming a winner on it. Precise
    // only where the precision is load-bearing: with nothing tapped, "no par 3
    // left" is the plainer true sentence and stays.
    (awardedUnscored.length > 0
      ? `no par 3 with a score left to win ${them}`
      : `no par 3 left to win ${them}`)

  /**
   * TWO DEATHS, AND THEY CANNOT BOTH HAPPEN. With carryovers on nothing is ever
   * `unclaimed` — an unawarded par 3's value moved forward, and only the final
   * pile is dead. With them off nothing ever carries. Mutually exclusive by
   * construction rather than by an `else`, so neither branch has to know about
   * the other.
   *
   * Both ride `notes` rather than a $0 settlement line: `lines.length === 0` is
   * the settle panel's "No money moved." signal, and a zero-cent row makes it
   * false on precisely the round it was written for (MAI-40).
   */
  const notes: string[] = []
  if (carryDied > 0) notes.push(deadReason)
  const unclaimed = holeResults.filter((r) => r.kind === 'unclaimed').map((r) => r.hole)
  if (unclaimed.length > 0) {
    notes.push(
      // NOT PREFIXED WITH THE GAME. Every surface renders a note inside
      // the game's own block, and the grouped side-bets panel prefixes it
      // with the name itself — so naming it here produced "Closest to the
      // Pin: Closest to the pin went unclaimed on hole 7".
      `Unclaimed on ${unclaimed.length === 1 ? 'hole' : 'holes'} ` +
        `${unclaimed.join(', ')} — nobody was given ` +
        `${unclaimed.length === 1 ? 'it' : 'them'}, so nothing was paid`,
    )
  }
  // WHY A TAP DID NOT PAY. A par 3 given to somebody that nobody ever scored
  // is skipped by the money on purpose (see the kit's gate), and after the
  // round closes the award grid is gated off — so without this the stake is
  // simply absent and nothing accounts for it, while the dead-pile note above
  // may be saying no par 3 was left to win. Never mid-round: tapping the tee
  // before anybody writes a number down is how this channel is meant to be
  // used, and the kit only reports these once the round is over.
  if (awardedUnscored.length > 0) {
    const one = awardedUnscored.length === 1
    // COUNTED PAST FOUR, unlike the unclaimed note above. That one leans on a
    // card holding about four par 3s; this one cannot, because the case it
    // exists for is a group scoring nothing at all — which fires it for every
    // tapped par 3 at once, and on a par-3 course (cards are user-imported,
    // so par distribution is arbitrary) that is an eighteen-number sentence
    // wrapped over four lines of the PAINTED share card.
    notes.push(
      awardedUnscored.length > 4
        ? `${awardedUnscored.length} par 3s were given out but never scored — nothing was paid for them`
        : `${one ? 'Hole' : 'Holes'} ${awardedUnscored.join(', ')} ` +
            `${one ? 'was' : 'were'} given out but never scored — ` +
            `nothing was paid for ${one ? 'it' : 'them'}`,
    )
  }

  const standings = standingsFromSettlement(players, settlement, (p) =>
    ctpLabel(wonByPlayer.get(p.playerId) ?? 0),
  )

  // Bar recaps the latest decided hole — "H7 · Rob closest".
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const r = holeResults.find((h) => h.hole === hole)
      if (r?.kind === 'won') {
        const name = nameOf.get(r.winnerId)
        return r.units > 1 ? `${name} closest · ${ctpLabel(r.units)}` : `${name} closest`
      }
      if (r?.kind === 'unclaimed') return 'nobody inside'
      if (r?.kind === 'carried') {
        // "carried" would promise a roll onto a par 3 that no longer exists
        if (hole === diedAt) return `nobody inside · ${ctpLabel(carryDied)} died unwon`
        return `nobody inside · ${r.carryAfter} carried`
      }
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
    if (r.kind === 'carried') {
      if (hole === diedAt) return ['Nobody inside', `↳ ${deadReason}`]
      // THE ↳ LINE IS WHERE THE PAR-3-TO-PAR-3 RULE GETS TAUGHT. It is the one
      // genuinely non-obvious thing about this bet — a group watching a carry
      // walk past three par 4s has every reason to wonder whether those holes
      // did something — and the ledger's job is to explain the cause of
      // anything non-obvious rather than only state the outcome.
      return [
        `Nobody inside — ${r.carryAfter} carried`,
        '↳ it rolls onto the next par 3 — the par 4s and 5s in between do not count',
      ]
    }
    // The non-obvious part of a CTP is never who won it — it is what a small
    // stake actually swings once every other player pays it. With nobody to
    // pay it (a one-player round, which `importRound` accepts) there is no
    // swing to explain, and the settlement has no line either.
    //
    // The hole ledger heads its list with the game, and the standings sheet
    // heads the block with it — so this says who, not what game it was.
    const fromEach = stakeCents * r.units
    const lines = [
      r.units > 1
        ? `${nameOf.get(r.winnerId)} closest — ${ctpLabel(r.units)}`
        : `${nameOf.get(r.winnerId)} closest`,
    ]
    // …and WHY it is worth more than one: par 3s nobody was given, earlier.
    if (r.units > 1) lines.push(`↳ this par 3 + ${r.units - 1} carried in`)
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
     * WHAT THE PINNED BAR'S MONEY AGGREGATE CANNOT SAY. With a main game and
     * two or more side bets the bar folds the side bets into one row of MONEY
     * (MAI-50) — and a carry is worth nothing until somebody wins it, so a
     * round with $24 riding on the next par 3 would read "no money yet".
     *
     * IT PRICES THE NEXT PAR 3, NOT THE PILE CARRIED INTO IT — `carrying + 1`,
     * because that is `units`, and `units` is what settles. Quoting the carry
     * alone understates the one number the group is standing on the tee to
     * hear: three carried at $2 in a foursome reads "$18" while the hole
     * actually pays $24. There is no state where the carried figure is the
     * interesting one — a pile is only ever collected by winning the hole it
     * rode onto.
     *
     * Dropped the moment it IS money, and the moment it is dead: the aggregate
     * reports the first itself, and `notes` reports the second. `carrying > 0`
     * is the whole guard — the kit zeroes it on a dead pile, and refuses to
     * carry off the last par 3 at all, so a pile that is reported is a pile
     * some par 3 still holds and whose cell is still tappable. (Not the same
     * claim as "a par 3 is still to be PLAYED": once the card is walked and
     * the round is not yet closed, the money is collected by recording the
     * hole rather than by hitting a shot.)
     */
    ...(carrying > 0 && {
      openBet:
        others > 0
          ? `${ctpLabel(carrying + 1)} riding · ${formatCents((carrying + 1) * stakeCents * others)}`
          : `${ctpLabel(carrying + 1)} riding`,
    }),
    holeSummary,
    requiredInputs: () => [],
    awards,
    settlement,
    ...(notes.length > 0 && { notes }),
    holeResults,
    carrying,
    carryDied,
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
        'With carryovers off, a par 3 nobody was given simply pays nothing — it is reported, not settled.',
        'With carryovers on, that stake rolls onto the next par 3 instead, making it worth double. Only par 3s count: the par 4s and 5s in between are no part of this bet, however many of them you play.',
        'If the last par 3 also goes unclaimed, the whole pile dies unwon.',
      ],
      scoring: [
        'The winner of a par 3 collects the stake from every other player. At $2 in a foursome that is $6 to them and $2 from each of the others.',
        'Handicaps do not apply — it is a contest of one tee shot, not of scores.',
        'Carryovers off: every par 3 in the holes you are playing stands on its own.',
        'Carryovers on: an unclaimed par 3 doubles the next one, and two in a row treble the one after. Winning a 3-CTP hole at $2 in a foursome is $6 from each of the others — an $18 swing.',
      ],
      terms: [
        {
          term: 'CTP',
          def: 'Closest to the pin — the shortest putt left after the tee shot on a par 3.',
        },
        {
          term: 'On the green',
          def: 'The usual house rule: the ball has to finish on the putting surface to count.',
        },
        { term: 'Unclaimed', def: 'A par 3 nobody was given — the hole simply pays nothing.' },
        {
          term: 'Carryover',
          def: 'An unclaimed par 3’s stake rolling onto the next par 3 — never onto a par 4 or 5.',
        },
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
    {
      key: 'carryover',
      kind: 'boolean',
      label: 'Carryovers',
      hint: 'Unclaimed par 3s roll to the next par 3',
    },
  ],
  defaultConfig: () => ({ stakeCents: 200, carryover: false }),
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

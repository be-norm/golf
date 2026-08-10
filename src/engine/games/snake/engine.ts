import { z } from 'zod'
import type { GameEngine, GameDerivation } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { addLine, emptySettlement, formatCents, type Settlement } from '../../core/money'
import { duplicateInstanceProblems } from '../../core/setup'
import { standingsFromSettlement } from '../../core/standings'
import { latestHoleSummary, summaryString } from '../../core/summary'
import type { GameConfig, HandicapSettings, RoundPlayer, Uuid } from '../../core/types'

export const snakeConfigSchema = z.object({
  /** what the snake is worth; whoever is holding it at the end pays this to everyone else */
  potCents: z.number().int().positive(),
  /** house rule: the pot doubles every time the snake bites */
  doubling: z.boolean(),
})

export type SnakeConfig = z.infer<typeof snakeConfigSchema>

/** One hole on which the snake changed hands (or was kept). */
export interface SnakeBite {
  hole: number
  holderId: Uuid
  /** who was holding it before — undefined on the first bite of the round */
  from?: Uuid
  /** how many putts took it */
  putts: number
  /** what the pot is worth from this bite onwards */
  potCents: number
}

export interface SnakeDerivation extends GameDerivation {
  bites: SnakeBite[]
  /** who is holding it now, or undefined if nobody ever three-putted */
  holderId?: Uuid
  /** what it is currently worth */
  potCents: number
}

function derive(
  game: GameConfig<SnakeConfig>,
  _events: readonly GameScopedEvent[],
  ctx: RoundContext,
): SnakeDerivation {
  const { potCents, doubling } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  /**
   * WHO THE SNAKE BITES ON THIS HOLE, or nobody.
   *
   * Traditionally it goes to the LAST player to three-putt in playing order,
   * and playing order is not modelled — so this uses the worst count, and roster
   * order only to break a true tie. A four-putt beating a three-putt is golf
   * anyone at the table would accept; two identical three-putts is a coin toss
   * either way, and the roster is the only stable stand-in for who putted out
   * last. Stable matters: the alternative is a holder that reshuffles between
   * re-derives (`meta.rules` says all of this out loud).
   *
   * ITERATES THE ROSTER, never the putts map. A `score/putts` naming somebody
   * outside the round — a corrupt import — must not become the holder: `addLine`
   * would then refuse the whole settlement line and Snake would quietly pay
   * nobody while looking perfectly settled.
   *
   * `undefined` is NOT RECORDED and `0` is a chip-in. Neither is a three-putt,
   * and folding them together is the one mistake `ctx.puttsFor` exists to
   * prevent.
   */
  const bitten = (hole: number): { playerId: Uuid; putts: number } | undefined => {
    let worst: { playerId: Uuid; putts: number } | undefined
    for (const p of players) {
      const putts = ctx.puttsFor(p.playerId, hole)
      if (putts === undefined || putts < 3) continue
      // `>=`, so the LAST player in roster order wins a tie
      if (worst === undefined || putts >= worst.putts) worst = { playerId: p.playerId, putts }
    }
    return worst
  }

  // IN PLAY ORDER, which on a round teeing off at 10 is not 1, 2, 3 — the snake
  // is passed along the walk, and its pot doubles in the order it was passed
  // (invariant #9).
  const bites: SnakeBite[] = []
  for (const hole of ctx.holesPlayed) {
    // A hole nobody played cannot have been three-putted on. Putts CAN land on
    // one — the log takes them from any hole the round holds — and counting
    // them would move the snake, and its money, onto a hole that never
    // happened: `buildHoleLedger` gives any hole whose deltas move a row,
    // played or not.
    if (!ctx.anyScored(hole)) continue
    const bite = bitten(hole)
    if (!bite) continue
    const previous = bites[bites.length - 1]
    bites.push({
      hole,
      holderId: bite.playerId,
      ...(previous && { from: previous.holderId }),
      putts: bite.putts,
      // EVERY BITE DOUBLES IT, including one that doesn't change hands — the
      // same player three-putting again is the snake biting again, which is how
      // the house rule is played and what makes it frightening.
      potCents: doubling ? potCents * 2 ** bites.length : potCents,
    })
  }

  const held = bites[bites.length - 1]

  /**
   * WHERE THE MONEY LANDS: the last hole anybody actually played.
   *
   * The same expression Skins uses to place its dead carry, and it has to be,
   * because `buildHoleLedger` independently attributes a completed round's
   * money to the last hole carrying a score. Any other choice puts the sentence
   * on one ledger row and the payment on another.
   *
   * It also cannot move: a bite requires `anyScored`, so no hole after this one
   * can bite, so the prefix replay that first sees `round/completed` already
   * knows the final holder.
   */
  const payHole = [...ctx.holesPlayed].reverse().find((h) => ctx.anyScored(h))

  /**
   * NOBODY OWES ANYTHING UNTIL THE ROUND IS OVER, because that is the bet: the
   * holder at the final hole pays. Mid-round the snake is narrated — who has
   * it, what it is worth — and settles nothing, which is the honest reading of
   * a bet that is still moving. Same shape as an award that is unclaimed
   * exactly when it can no longer be claimed.
   */
  const settlement: Settlement = emptySettlement(playerIds)
  if (ctx.completed && held) {
    const others = playerIds.length - 1
    addLine(settlement, {
      label: `${nameOf.get(held.holderId)} holds the snake`,
      perPlayerCents: Object.fromEntries(
        playerIds.map((id) => [
          id,
          id === held.holderId ? -held.potCents * others : held.potCents,
        ]),
      ),
    })
  }

  // A round nobody three-putted is a round where the snake never came out. That
  // is something to SAY, not a $0 settlement line — which would make
  // `lines.length === 0`, the settle panel's "No money moved." signal, false on
  // exactly the round it was written for (MAI-40).
  const notes =
    ctx.completed && !held
      ? ['Nobody three-putted — the snake never came out, so nothing was paid']
      : undefined

  const standings = standingsFromSettlement(players, settlement, (p) =>
    held?.holderId === p.playerId ? 'holds the snake' : undefined,
  )

  const worth = held?.potCents ?? potCents
  const detailLines = [
    {
      label: 'Snake',
      value: held
        ? `${nameOf.get(held.holderId)} · ${formatCents(held.potCents)}`
        : 'nobody has it',
    },
  ]

  // The bar recaps the hole it last changed hands on — "H7 · Ben has it · $4"
  // — which is both what just happened and who is carrying it now.
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const bite = bites.find((b) => b.hole === hole)
      if (!bite) return null
      const name = nameOf.get(bite.holderId)
      return doubling ? `${name} has it · ${formatCents(bite.potCents)}` : `${name} has it`
    },
    'no snake yet',
  )

  const holeSummary = (hole: number): string[] => {
    const lines: string[] = []
    const bite = bites.find((b) => b.hole === hole)
    if (bite) {
      const name = nameOf.get(bite.holderId)
      const kept = bite.from === bite.holderId
      const cause =
        bite.from === undefined
          ? 'the snake is out'
          : kept
            ? 'and it stays with them'
            : `${nameOf.get(bite.from)} is off the hook`
      lines.push(
        kept ? `${name} three-putts again` : `${name} takes the snake`,
        `↳ ${bite.putts} putts — ${cause}` +
          (doubling ? `; the pot is now ${formatCents(bite.potCents)}` : ''),
      )
    }
    if (ctx.completed && held && hole === payHole) {
      const others = playerIds.length - 1
      lines.push(
        `${nameOf.get(held.holderId)} is left holding the snake`,
        `↳ pays ${formatCents(held.potCents)} to each of ${others} other player` +
          `${others === 1 ? '' : 's'} — ${formatCents(held.potCents * others)}`,
      )
    }
    return lines
  }

  return {
    standings,
    summary: summaryString(summaryParts),
    summaryParts,
    detailLines,
    holeSummary,
    requiredInputs: () => [],
    settlement,
    notes,
    bites,
    ...(held && { holderId: held.holderId }),
    potCents: worth,
  }
}

/** The one name for this game — `meta.name` and every message that has to say
 *  it. label.ts is the single source of a game's name (MAI-42). */
const SNAKE_NAME = 'Snake'

export const snakeEngine: GameEngine<SnakeConfig> = {
  type: 'snake',
  meta: {
    name: SNAKE_NAME,
    blurb: 'Three-putt and you are holding the snake. Still holding it at the end? You pay.',
    minPlayers: 2,
    maxPlayers: 8,
    category: 'side',
    family: 'pot',
    shapes: ['solo'],
    /**
     * THE FIRST ENGINE THAT READS A ROUND FACT (MAI-90).
     *
     * Snake is a pure function of its config and `RoundContext` — it has no
     * events of its own at all. Putts are entered once, on the scoring screen,
     * because they are a SCORECARD fact rather than a bet fact; declaring them
     * here is what makes the round collect them and what tells the group which
     * game asked. It is also the only way a game CAN require one: `validateSetup`
     * sees config, players and siblings, never the round.
     */
    reads: ['putts'],
    rules: {
      tagline: 'The last three-putt of the day costs somebody.',
      howToPlay: [
        'Three-putt a green and you are holding the snake.',
        'It passes every time somebody else three-putts. Whoever is holding it when the round ends pays.',
        'Putts are counted beside the score, so nothing extra to tap — the snake moves on its own.',
        'Nobody three-putts all day? The snake never comes out and nothing is paid.',
      ],
      scoring: [
        'The holder pays the pot to every other player. At $1 in a foursome that is $3 from them and $1 to each of the others.',
        'With a doubling pot the value doubles on every three-putt, including one by the player already holding it — three-putting twice running doubles it twice.',
        'Handicaps do not apply. A three-putt is a three-putt.',
        'More than one three-putt on the same hole? The worst count takes it — a four-putt beats a three-putt. If those tie, it goes to whoever is later in the player list, since the app does not track who putted out last.',
        'Money moves only when the round is finished, because until then the snake can still be passed.',
      ],
      terms: [
        { term: 'The snake', def: 'The debt that follows the most recent three-putt around the course.' },
        { term: 'Three-putt', def: 'Three or more putts on one green. A chip-in takes none, and none is not a three-putt.' },
        { term: 'Doubling pot', def: 'A house rule where the snake is worth twice as much after every bite.' },
      ],
    },
  },
  configSchema: snakeConfigSchema,
  configFields: [
    {
      key: 'potCents',
      kind: 'money',
      label: 'Pot',
      min: 25,
      step: 25,
      hint: 'The last three-putter pays this to every other player',
    },
    {
      key: 'doubling',
      kind: 'boolean',
      label: 'Doubling pot',
      hint: 'The pot doubles on every three-putt',
    },
  ],
  // A dollar, and not doubling. The doubling pot is uncapped by design — that
  // is the game — so it is the rule you opt into rather than the one you have
  // to notice.
  defaultConfig: () => ({ potCents: 100, doubling: false }),
  // GROSS, and not a default anyone should flip: a three-putt is a three-putt
  // whatever your index. It also keeps Snake out of `strokeGame`, so a cheap
  // side bet can never capture the scoring screen's stroke dots.
  defaultHandicap: (): HandicapSettings => ({
    mode: 'gross',
    allowancePct: 100,
    reference: 'absolute',
  }),
  validateSetup: (
    config: GameConfig<SnakeConfig>,
    players: readonly RoundPlayer[],
    siblings: readonly GameConfig[],
  ) => {
    const problems: string[] = []
    if (players.length < 2) problems.push(`${SNAKE_NAME} needs at least 2 players`)
    if (!snakeConfigSchema.safeParse(config.config).success) {
      problems.push('Invalid snake configuration')
    }
    problems.push(...duplicateInstanceProblems(config, siblings, SNAKE_NAME))
    return problems
  },
  // NONE. Everything Snake needs is a round-level fact read through
  // `RoundContext`, so there is nothing for it to append and nothing to
  // validate — the seam invariant #7 reserves, with its first real consumer.
  eventKinds: {},
  derive,
}

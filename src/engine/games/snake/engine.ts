import { z } from 'zod'
import type { Award, GameEngine, GameDerivation } from '../../catalog'
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
  /** house rule: the pot doubles on every bite after the first */
  doubling: z.boolean(),
})

export type SnakeConfig = z.infer<typeof snakeConfigSchema>

/** One hole on which the snake changed hands (or was kept). */
export interface SnakeBite {
  hole: number
  holderId: Uuid
  /** who was holding it before — undefined on the first bite of the round */
  from?: Uuid
  /** what the pot is worth from this bite onwards */
  potCents: number
}

export interface SnakeDerivation extends GameDerivation {
  bites: SnakeBite[]
  /** who is holding it now, or undefined if nobody has taken it */
  holderId?: Uuid
  /** what it is currently worth */
  potCents: number
}

/**
 * The award grid's row, and the whole instruction.
 *
 * It has to carry the rule by itself: with Snake as the only award game running
 * the grid shows no game heading (`AwardGrid` adds one only to disambiguate
 * two), so "Snake" alone would leave a scorekeeper guessing whether tapping a
 * name means they three-putted, they hold it, or they are off the hook. The
 * answer is all three at once, and "last 3-putt" is the shortest true form.
 */
const GROUP = 'Snake — last 3-putt'

function derive(
  game: GameConfig<SnakeConfig>,
  events: readonly GameScopedEvent[],
  ctx: RoundContext,
): SnakeDerivation {
  const { potCents, doubling } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  /**
   * WHO TOOK IT ON EACH HOLE — last write wins, the same rule a corrected score
   * follows. Re-tapping a different name is a correction, not a second bite.
   *
   * Every event on the hole is kept so undo can CLEAR the hole rather than
   * reveal whoever was tapped before it: "tap the lit name to take it back" has
   * to mean nobody took it on this hole, or a mistap corrected twice leaves an
   * earlier player holding a snake nobody re-confirmed.
   */
  const takenByHole = new Map<number, Uuid>()
  const eventIdsByHole = new Map<number, Uuid[]>()
  for (const e of events) {
    if (e.kind !== 'snake/bite') continue
    const { hole, playerId } = e.data as { hole: number; playerId: Uuid }
    takenByHole.set(hole, playerId)
    eventIdsByHole.set(hole, [...(eventIdsByHole.get(hole) ?? []), e.id])
  }

  // IN PLAY ORDER, which on a round teeing off at 10 is not 1, 2, 3 — the snake
  // is passed along the walk, and its pot doubles in the order it was passed
  // (invariant #9).
  const bites: SnakeBite[] = []
  for (const hole of ctx.holesPlayed) {
    // A hole nobody played cannot have been three-putted on. The cell is
    // tappable there — the grid has no such gate, by design — and counting it
    // would move the snake, and its money, onto a hole that never happened:
    // `buildHoleLedger` gives a row to any hole whose deltas move, played or
    // not. Costs a moment's lag when the snake is tapped before the scores are
    // in, which is exactly what CTP does on a par 3 recorded from the tee.
    if (!ctx.anyScored(hole)) continue
    const raw = takenByHole.get(hole)
    // A name that isn't in this round can only come from a corrupt or edited
    // log; it must not become the holder, or `addLine` would refuse the whole
    // settlement line and Snake would pay nobody while looking settled.
    if (raw === undefined || !playerIds.includes(raw)) continue
    const previous = bites[bites.length - 1]
    bites.push({
      hole,
      holderId: raw,
      ...(previous && { from: previous.holderId }),
      // The snake comes OUT at the stake and doubles on every bite after that
      // — `bites.length` is the count before this one, so the first is 1×. A
      // bite that does not change hands still doubles it: the same player
      // three-putting again is the snake biting again, which is how the house
      // rule is played and what makes it frightening.
      potCents: doubling ? potCents * 2 ** bites.length : potCents,
    })
  }

  const held = bites[bites.length - 1]

  /**
   * WHERE THE MONEY LANDS: the last hole anybody actually played.
   *
   * `ctx.lastPlayedHole` rather than a private copy, because `buildHoleLedger`
   * places a completed round's money by the same definition — and the one time
   * they differed, the payment sat on one ledger row and the sentence
   * explaining it on another (MAI-58).
   *
   * It also cannot move: a bite requires `anyScored`, so no hole after this one
   * can bite, so the prefix replay that first sees `round/completed` already
   * knows the final holder.
   */
  const payHole = ctx.lastPlayedHole

  /**
   * IS ANYTHING OWED? Asked ONCE, so the money and the sentence explaining it
   * cannot disagree about the answer.
   *
   * NOBODY OWES ANYTHING UNTIL THE ROUND IS OVER, because that is the bet: the
   * holder at the final hole pays. Mid-round the snake is narrated — who has
   * it, what it is worth — and settles nothing, which is the honest reading of
   * a bet that is still moving. Same shape as an award that is unclaimed
   * exactly when it can no longer be claimed.
   *
   * AND THERE HAS TO BE SOMEBODY TO PAY. `validateSetup` refuses a one-player
   * round, but `importRound` validates a roster with `.min(1)`, so one can
   * arrive from an export, and every entry of the line would be zero. `addLine`
   * refuses such a line itself — that belongs at the choke point, since a
   * one-player round zeroes every engine at once — so what this guard is FOR is
   * the other half: the sentence.
   */
  const others = playerIds.length - 1
  const owes = ctx.completed && held !== undefined && others > 0

  const settlement: Settlement = emptySettlement(playerIds)
  if (owes && held) {
    addLine(settlement, {
      // WHAT ACTUALLY HAPPENS TO THE MONEY. "Mike holds the snake" beside a
      // heading reading SNAKE says the game twice and the payment never — a
      // reader seeing "Mike · $32" could not tell whether he won or lost it,
      // and the answer is that he pays that much to each of the others.
      label:
        others === 1
          ? `${nameOf.get(held.holderId)} pays ${formatCents(held.potCents)}`
          : `${nameOf.get(held.holderId)} pays ${formatCents(held.potCents)} to each of ${others} others`,
      perPlayerCents: Object.fromEntries(
        playerIds.map((id) => [
          id,
          id === held.holderId ? -held.potCents * others : held.potCents,
        ]),
      ),
    })
  }

  // A round nobody took it on is a round where the snake never came out. That
  // is something to SAY, not a $0 settlement line — which would make
  // `lines.length === 0`, the settle panel's "No money moved." signal, false on
  // exactly the round it was written for (MAI-40).
  const notes =
    ctx.completed && !held
      ? ['Nobody took the snake — nothing was paid']
      : undefined

  const standings = standingsFromSettlement(players, settlement, (p) =>
    held?.holderId === p.playerId ? 'holds the snake' : undefined,
  )

  /**
   * THE LIVE POSITION, and only while it is live.
   *
   * `detailLines` is what makes a panel render as a LEDGER instead of its money
   * lines (`summaryCard.ts`), so shipping this on a settled round put "Snake ·
   * Mike · $32" on the share card where the payment belonged — a number a
   * reader could not tell the sign of. Once the money moves the settlement line
   * says it properly, so this stands down.
   */
  const detailLines = owes
    ? undefined
    : [
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
        `↳ last to three-putt — ${cause}` +
          (doubling ? `; the pot is now ${formatCents(bite.potCents)}` : ''),
      )
    }
    // `owes`, not `ctx.completed && held` — the same question the settlement
    // asked, so the row cannot state a payment the panel says never happened.
    if (owes && held && hole === payHole) {
      lines.push(
        `${nameOf.get(held.holderId)} is left holding the snake`,
        `↳ pays ${formatCents(held.potCents)} to each of ${others} other player` +
          `${others === 1 ? '' : 's'} — ${formatCents(held.potCents * others)}`,
      )
    }
    return lines
  }

  /**
   * OFFERED ON EVERY HOLE, because any green can be three-putted — there is no
   * eligibility rule to learn, unlike CTP's par 3s or Long Drive's designated
   * holes.
   *
   * And no frontier gate, which is the award channel's whole point: you
   * remember on 12 that Rob three-putted 7, or you fix a mistap on the 18th
   * green. The grid stops accepting taps when the round is completed, and not
   * before (MAI-46).
   */
  const awards = (hole: number): Award[] => {
    const holder = takenByHole.get(hole)
    return players.map((p) => {
      const taken = holder === p.playerId
      return {
        id: `snake-${hole}-${p.playerId}`,
        gameId: game.gameId,
        hole,
        playerId: p.playerId,
        group: GROUP,
        label: p.name,
        taken,
        eventKind: 'snake/bite',
        data: { hole, playerId: p.playerId },
        // Only the lit cell carries an undo, so a screen cannot retract off a
        // name that was never tapped. Every event on the hole, so taking it
        // back CLEARS the hole and the snake reverts to whoever held it before
        // — see the last-write-wins note above.
        ...(taken && { undoEventIds: eventIdsByHole.get(hole) ?? [] }),
      }
    })
  }

  return {
    standings,
    summary: summaryString(summaryParts),
    summaryParts,
    ...(detailLines && { detailLines }),
    // What the pinned bar's money aggregate cannot say: the snake is worth
    // something to somebody right now, and settles nothing until the round
    // ends. Dropped once it IS money — the aggregate reports that itself, and
    // two rows saying it would just disagree about the phrasing.
    ...(held && !owes && { openBet: `${nameOf.get(held.holderId)} · ${formatCents(held.potCents)}` }),
    holeSummary,
    requiredInputs: () => [],
    awards,
    settlement,
    notes,
    bites,
    ...(held && { holderId: held.holderId }),
    potCents: held?.potCents ?? potCents,
  }
}

/** The one name for this game — `meta.name` and every message that has to say
 *  it. label.ts is the single source of a game's name (MAI-42). */
const SNAKE_NAME = 'Snake'

export const snakeEngine: GameEngine<SnakeConfig> = {
  type: 'snake',
  meta: {
    name: SNAKE_NAME,
    blurb: 'Last player to three-putt holds the snake. Still holding it at the end? You pay.',
    minPlayers: 2,
    maxPlayers: 8,
    category: 'side',
    family: 'pot',
    shapes: ['solo'],
    // Handicaps have nothing to say here, so setup does not offer them.
    grossOnly: true,
    /**
     * NO `reads`. Snake was built on round-level putt counts first (MAI-54,
     * MAI-90) and moved to the award channel, because the two are not the same
     * question. Counting putts asks every player for a number on all eighteen
     * greens — seventy-odd entries to capture the four or five that matter —
     * and then still cannot answer the rule, which is "who three-putted LAST on
     * this hole". Playing order is not in the log, so the engine had to guess
     * it (worst count, then roster order); a tap is that answer, given by the
     * person who was standing there.
     *
     * Putts stay in the vocabulary for Dots and Trouble, which want the COUNT
     * (poley, and a 3-putt that dings everyone who made one rather than the
     * last one). Different fact, different channel.
     */
    rules: {
      tagline: 'The last three-putt of the day costs somebody.',
      howToPlay: [
        'Three-putt a green and you are holding the snake.',
        'Under the scores, tap the name of the last player to three-putt that hole. Tap a different name to correct it, or the lit name to clear the hole.',
        'It passes every time somebody else three-putts. Whoever is holding it when the round ends pays.',
        'Record it whenever you like — on the green, at the turn, or on the 18th. Nothing expires until the round is finished.',
        'Nobody three-putts all day? The snake never comes out and nothing is paid.',
      ],
      scoring: [
        'The holder pays the pot to every other player. At $1 in a foursome that is $3 from them and $1 to each of the others.',
        'With a doubling pot the snake comes out worth the stake, then doubles on every three-putt after that — $1, $2, $4, $8. A player who already has it and three-putts again doubles it just the same.',
        'Handicaps do not apply. A three-putt is a three-putt.',
        'One name per hole, because the rule is who three-putted LAST. If two of you three-putt the same green, tap whoever putted out last — the app does not guess.',
        'Money moves only when the round is finished, because until then the snake can still be passed.',
      ],
      terms: [
        { term: 'The snake', def: 'The debt that follows the most recent three-putt around the course.' },
        { term: 'Three-putt', def: 'Three or more putts on one green.' },
        { term: 'Doubling pot', def: 'A house rule where the snake comes out worth the stake and doubles on every bite after that.' },
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
      hint: 'Out at the stake, then doubles on every three-putt after that',
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
  eventKinds: {
    'snake/bite': z.object({
      hole: z.number().int().min(1).max(18),
      playerId: z.string(),
    }),
  },
  derive,
}

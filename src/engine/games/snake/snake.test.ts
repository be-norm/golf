import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { buildHoleLedger } from '../../ledger'
import { assertZeroSum } from '../../core/money'
import { EventLog, makePlayers, makeRound } from '../../test/harness'
import type { SnakeConfig, SnakeDerivation } from './engine'

/**
 * Snake is decided by one tap per hole — the name of the last player to
 * three-putt it — so every fixture here is a card plus `snake/bite` events.
 *
 * It was built on round-level putt COUNTS first (MAI-54, MAI-90) and moved,
 * because counting putts asks for seventy-odd numbers to capture the four that
 * matter and STILL cannot answer "who was last", which is the actual rule.
 * Playing order is not in the log; the person tapping was standing there.
 *
 * The harness front 9 is pars 4 4 5 3 4 4 3 5 4; Snake never reads par, but
 * `anyScored` and `completed` gate the money and those need scores.
 */

const FOUR = () => makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])

function snakeRound(players = FOUR(), config: Partial<SnakeConfig> = {}) {
  return makeRound({
    players,
    holes: 'front9',
    games: [{ type: 'snake', config: { potCents: 100, doubling: false, ...config } }],
  })
}

function snakeOf(round: ReturnType<typeof makeRound>, log: EventLog): SnakeDerivation {
  const { derivations } = deriveRound(round, log.events)
  return derivations.get(round.games[0]!.gameId) as SnakeDerivation
}

function scoreHoles(round: ReturnType<typeof makeRound>, log: EventLog, holes: number[]) {
  const card = Object.fromEntries(round.players.map((p) => [p.name, holes.map(() => 4)]))
  log.scoreByHole(round, card, holes)
}

/** Tap a name under the scores: this player three-putted last on this hole. */
const bite = (log: EventLog, hole: number, playerId: string) =>
  log.append({ type: 'game/event', gameId: 'game-1', kind: 'snake/bite', data: { hole, playerId } })

describe('snake — golden fixtures (hand-verified)', () => {
  /**
   * S1: nobody three-putts all day. The snake never comes out, no money moves,
   * and the app SAYS so rather than leaving the bar reading as if a bet is
   * live. A $0 settlement line would make `lines.length === 0` — the settle
   * panel's "No money moved." signal — false (MAI-40).
   */
  it('S1: a round nobody took it on pays nothing, and says why', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.bites).toEqual([])
    expect(snake.holderId).toBeUndefined()
    expect(snake.settlement.lines).toHaveLength(0)
    assertZeroSum(snake.settlement)
    expect(snake.notes).toEqual(['Nobody took the snake — nothing was paid'])
    expect(snake.summaryParts).toEqual([{ label: '', value: 'no snake yet' }])
    expect(snake.detailLines).toEqual([{ label: 'Snake', value: 'nobody has it' }])
  })

  /**
   * S2: it changes hands late. B takes it on 2 and carries it for four holes;
   * C takes it on 6 and is still holding it at the end.
   *
   * C pays $1 to each of the other three = −$3; A, B and D collect $1 each.
   */
  it('S2: the holder at the end pays, not whoever held it longest', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    bite(log, 2, 'p-b')
    bite(log, 6, 'p-c')
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.bites).toEqual([
      { hole: 2, holderId: 'p-b', potCents: 100 },
      { hole: 6, holderId: 'p-c', from: 'p-b', potCents: 100 },
    ])
    expect(snake.holderId).toBe('p-c')
    expect(snake.settlement.perPlayerCents).toEqual({
      'p-a': 100,
      'p-b': 100,
      'p-c': -300,
      'p-d': 100,
    })
    assertZeroSum(snake.settlement)
    expect(snake.settlement.lines).toHaveLength(1)
    // THE LINE SAYS WHAT HAPPENS TO THE MONEY. "C holds the snake" under a
    // heading reading SNAKE named the game twice and the payment never — and
    // a reader seeing "C · $1" cannot tell whether C won or lost it.
    expect(snake.settlement.lines[0]!.label).toBe('C pays $1 to each of 3 others')
    // …and the live position stands down once the money moves, or the card
    // renders that instead of the payment (`summaryCard`'s ledger/lines split)
    expect(snake.detailLines).toBeUndefined()
    expect(snake.standings[3]).toMatchObject({ label: 'C', detail: 'holds the snake' })

    expect(snake.holeSummary(2)).toEqual([
      'B takes the snake',
      '↳ last to three-putt — the snake is out',
    ])
    expect(snake.holeSummary(6)).toEqual([
      'C takes the snake',
      '↳ last to three-putt — B is off the hook',
    ])
    // the money lands on the last hole played, and says what it is for
    expect(snake.holeSummary(9)).toEqual([
      'C is left holding the snake',
      '↳ pays $1 to each of 3 other players — $3',
    ])
  })

  /**
   * S3: the doubling pot. It comes OUT at the stake and doubles on every bite
   * after that, including one that does not change hands — the same player
   * three-putting again is the snake biting again, which is the whole menace of
   * the house rule. The worked example below is what the rules sheet promises.
   *
   * $1 → $2 (hole 4, D again) → $4 (hole 7). A is left holding $4, paying $12.
   */
  it('S3: a doubling pot doubles after the first bite, including on a repeat', () => {
    const round = snakeRound(FOUR(), { doubling: true })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    bite(log, 2, 'p-d')
    bite(log, 4, 'p-d')
    bite(log, 7, 'p-a')
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.bites.map((b) => [b.hole, b.holderId, b.potCents])).toEqual([
      [2, 'p-d', 100],
      [4, 'p-d', 200],
      [7, 'p-a', 400],
    ])
    expect(snake.potCents).toBe(400)
    expect(snake.settlement.perPlayerCents).toEqual({
      'p-a': -1200,
      'p-b': 400,
      'p-c': 400,
      'p-d': 400,
    })
    assertZeroSum(snake.settlement)

    expect(snake.holeSummary(4)).toEqual([
      'D three-putts again',
      '↳ last to three-putt — and it stays with them; the pot is now $2',
    ])
    // the bar carries the running value, so nobody is surprised at the end
    expect(snake.summaryParts).toEqual([{ label: 'H7', value: 'A has it · $4' }])
  })

  /**
   * S4: TWO PLAYERS THREE-PUTT THE SAME GREEN — the case that used to need a
   * tie rule the app had to invent (worst count, then roster order), because
   * putt counts cannot say who putted out last.
   *
   * One tap per hole, last write wins, so the group answers it: tap B, realise
   * C was in fact last, tap C. One bite, one holder, no guessing — and the
   * money is C's.
   */
  it('S4: a second tap on a hole corrects the first, and pays once', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    bite(log, 3, 'p-b')
    bite(log, 3, 'p-c')
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.bites).toEqual([{ hole: 3, holderId: 'p-c', potCents: 100 }])
    expect(snake.settlement.lines).toHaveLength(1)
    expect(snake.settlement.perPlayerCents['p-c']).toBe(-300)
  })

  /**
   * S5: taking a tap back CLEARS the hole rather than revealing whoever was
   * tapped before it, so the snake reverts to whoever genuinely held it. A
   * mistap corrected twice must not leave an earlier player holding money
   * nobody re-confirmed.
   */
  it('S5: clearing a hole hands the snake back to the previous holder', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    bite(log, 2, 'p-a')
    const first = bite(log, 6, 'p-b')
    const correction = bite(log, 6, 'p-c')
    log.append({ type: 'round/completed' })

    const lit = snakeOf(round, log)
      .awards!(6)
      .find((a) => a.taken)!
    expect(lit.playerId).toBe('p-c')
    // every tap on the hole, so undo clears it rather than exposing B
    expect(lit.undoEventIds).toEqual([first.id, correction.id])

    for (const id of lit.undoEventIds!) log.append({ type: 'meta/retract', targetEventId: id })
    const cleared = snakeOf(round, log)
    expect(cleared.bites.map((b) => b.hole)).toEqual([2])
    expect(cleared.holderId).toBe('p-a')
  })

  /**
   * S6: undoing the deciding tap moves the snake BACK to whoever held it
   * before — free, because the holder is derived from the log every time rather
   * than accumulated. Invariant #2: undo is a compensation event.
   */
  it('S6: retracting the deciding tap hands the snake back', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    bite(log, 2, 'p-b')
    const mistake = bite(log, 6, 'p-c')
    log.append({ type: 'round/completed' })
    expect(snakeOf(round, log).holderId).toBe('p-c')

    log.append({ type: 'meta/retract', targetEventId: mistake.id })
    const back = snakeOf(round, log)
    expect(back.holderId).toBe('p-b')
    expect(back.settlement.perPlayerCents).toEqual({
      'p-a': 100,
      'p-b': -300,
      'p-c': 100,
      'p-d': 100,
    })
  })

  /**
   * S7: mid-round the snake is HELD, not owed. It can still be passed, so
   * nothing settles — the bar says who has it and the standings say $0, which
   * is the honest reading of a bet still moving.
   */
  it('S7: a live round reports a holder and moves no money', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5])
    bite(log, 2, 'p-b')
    const snake = snakeOf(round, log)

    expect(snake.holderId).toBe('p-b')
    expect(snake.settlement.lines).toHaveLength(0)
    expect(Object.values(snake.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
    expect(snake.notes).toBeUndefined()
    expect(snake.summaryParts).toEqual([{ label: 'H2', value: 'B has it' }])
    expect(snake.detailLines).toEqual([{ label: 'Snake', value: 'B · $1' }])
  })

  /**
   * S8: a round finished early pays on the last hole ANYBODY PLAYED — not hole
   * 9, which nobody reached, and not hole 1. `buildHoleLedger` attributes a
   * completed round's money to that hole independently, so the engine has to
   * agree with it or the sentence lands on one row and the payment on another.
   */
  it('S8: finishing early lands the money on the last hole played', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4])
    bite(log, 2, 'p-b')
    log.append({ type: 'round/completed' })

    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!
    const paid = rows.filter((r) => r.deltas.length > 0)
    expect(paid).toHaveLength(1)
    expect(paid[0]!.hole).toBe(4)
    expect(paid[0]!.deltas.find((d) => d.playerId === 'p-b')!.cents).toBe(-300)
    // …and hole 2 still earns a row for the bite, with no money on it
    expect(rows.find((r) => r.hole === 2)!.summary[0]).toBe('B takes the snake')
    expect(rows.find((r) => r.hole === 2)!.deltas).toEqual([])
  })

  /**
   * S9: a tap on a hole nobody scored. The cell is offered there — the grid has
   * no frontier gate, by design — and counting it would move the snake, and its
   * money, onto a hole that never happened: `buildHoleLedger` gives a row to
   * any hole whose deltas move, played or not.
   */
  it('S9: a tap on a hole nobody played does not move the snake', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    bite(log, 2, 'p-b')
    // hole 7 was never played, but carries a stray tap
    bite(log, 7, 'p-d')
    log.append({ type: 'round/completed' })

    const snake = snakeOf(round, log)
    expect(snake.bites.map((b) => b.hole)).toEqual([2])
    expect(snake.holderId).toBe('p-b')

    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!
    expect(rows.some((r) => r.hole === 7)).toBe(false)
  })

  /** A tap naming somebody outside the round can only come from a corrupt or
   *  hand-edited log. It must not become the holder — `addLine` would refuse
   *  the whole line and Snake would pay nobody while looking settled. */
  it('S10: a tap naming a non-player is inert', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    bite(log, 4, 'p-nobody')
    log.append({ type: 'round/completed' })

    const snake = snakeOf(round, log)
    expect(snake.bites).toEqual([])
    expect(snake.notes).toHaveLength(1)
    assertZeroSum(snake.settlement)
  })

  /**
   * S11: a ONE-player round, which `validateSetup` refuses but `importRound`
   * accepts (`.min(1)` on the roster). There is nobody to collect from, so
   * nothing is owed — and the money and the narration have to agree about that.
   * Guarding only the settlement left the panel saying "No money moved." over a
   * ledger row reading "pays $1 to each of 0 other players — $0".
   */
  it('S11: a one-player round owes nothing, and says nothing about paying', () => {
    const round = snakeRound(makePlayers([{ name: 'A' }]))
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    bite(log, 2, 'p-a')
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.settlement.lines).toHaveLength(0)
    assertZeroSum(snake.settlement)
    expect(snake.holderId).toBe('p-a')
    // hole 3 — where a payment WOULD land — claims nothing was paid
    expect(snake.holeSummary(3)).toEqual([])
  })

  /** Two players is the minimum roster, and the pot is one-for-one there. */
  it('S12: heads-up, the holder pays a single pot', () => {
    const round = snakeRound(makePlayers([{ name: 'A' }, { name: 'B' }]), { potCents: 500 })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    bite(log, 3, 'p-a')
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.settlement.perPlayerCents).toEqual({ 'p-a': -500, 'p-b': 500 })
    // heads-up needs no "to each of 1 others"
    expect(snake.settlement.lines[0]!.label).toBe('A pays $5')
    expect(snake.holeSummary(9)).toEqual([
      'A is left holding the snake',
      '↳ pays $5 to each of 1 other player — $5',
    ])
  })
})

describe('snake — the award grid it offers', () => {
  /**
   * EVERY HOLE, because any green can be three-putted — there is no
   * eligibility rule to learn, unlike CTP's par 3s or Long Drive's designated
   * holes. And one row, whose label has to carry the whole instruction: with
   * Snake the only award game running, `AwardGrid` shows no game heading.
   */
  it('offers one cell per player on every hole of the round', () => {
    const round = snakeRound()
    const snake = snakeOf(round, new EventLog())

    for (const hole of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const cells = snake.awards!(hole)
      expect(cells.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D'])
      expect(cells.every((c) => c.group === 'Snake — last 3-putt')).toBe(true)
      // every payload carries its hole — the ledger places a game event in its
      // prefix replay by reading it
      expect(cells.every((c) => (c.data as { hole: number }).hole === hole)).toBe(true)
      expect(cells.some((c) => c.taken)).toBe(false)
    }
  })

  /**
   * THE LIFECYCLE RULE: no frontier gate and no all-scored gate. You remember
   * on 12 that Rob three-putted 7, or you fix a mistap on the 18th green.
   */
  it('keeps offering cells behind the frontier and after every hole is scored', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(snakeOf(round, log).awards!(2)).toHaveLength(4)
  })

  it('lights exactly the tapped name, and only that cell carries an undo', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    const evt = bite(log, 2, 'p-c')
    const cells = snakeOf(round, log).awards!(2)

    expect(cells.filter((c) => c.taken).map((c) => c.playerId)).toEqual(['p-c'])
    expect(cells.find((c) => c.taken)!.undoEventIds).toEqual([evt.id])
    expect(cells.filter((c) => !c.taken).every((c) => c.undoEventIds === undefined)).toBe(true)
  })
})

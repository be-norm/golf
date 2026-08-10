import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { buildHoleLedger } from '../../ledger'
import { assertZeroSum } from '../../core/money'
import { EventLog, makePlayers, makeRound } from '../../test/harness'
import type { SnakeConfig, SnakeDerivation } from './engine'

/**
 * Snake reads NOTHING but putts and the shape of the round — it has no events
 * of its own — so every fixture here is a card plus a putts log.
 *
 * The harness front 9 is pars 4 4 5 3 4 4 3 5 4; Snake never reads par, but
 * `anyScored` and `completed` gate the money and those need scores.
 */

const FOUR = () => makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])

function snakeRound(players = FOUR(), config: Partial<SnakeConfig> = {}) {
  return makeRound({
    players,
    holes: 'front9',
    trackPutts: true,
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

const putt = (log: EventLog, playerId: string, hole: number, putts: number) =>
  log.append({ type: 'score/putts', playerId, hole, putts })

describe('snake — golden fixtures (hand-verified)', () => {
  /**
   * S1: nobody three-putts all day. The snake never comes out, no money moves,
   * and the app SAYS so rather than leaving the bar reading as if a bet is
   * live. A $0 settlement line would make `lines.length === 0` — the settle
   * panel's "No money moved." signal — false (MAI-40).
   */
  it('S1: a round with no three-putt pays nothing, and says why', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    // plenty of putts, none of them three
    for (const hole of [1, 2, 3]) for (const p of round.players) putt(log, p.playerId, hole, 2)
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.bites).toEqual([])
    expect(snake.holderId).toBeUndefined()
    expect(snake.settlement.lines).toHaveLength(0)
    assertZeroSum(snake.settlement)
    expect(snake.notes).toEqual([
      'Nobody three-putted — the snake never came out, so nothing was paid',
    ])
    expect(snake.summaryParts).toEqual([{ label: '', value: 'no snake yet' }])
    expect(snake.detailLines).toEqual([{ label: 'Snake', value: 'nobody has it' }])
  })

  /**
   * S2: it changes hands late. B three-putts on 2 and carries it for four
   * holes; C three-putts on 6 and is still holding it at the end.
   *
   * C pays $1 to each of the other three = −$3; A, B and D collect $1 each.
   */
  it('S2: the holder at the end pays, not whoever held it longest', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    putt(log, 'p-b', 2, 3)
    putt(log, 'p-c', 6, 3)
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.bites).toEqual([
      { hole: 2, holderId: 'p-b', putts: 3, potCents: 100 },
      { hole: 6, holderId: 'p-c', from: 'p-b', putts: 3, potCents: 100 },
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
    expect(snake.settlement.lines[0]!.label).toBe('C holds the snake')
    expect(snake.standings[3]).toMatchObject({ label: 'C', detail: 'holds the snake' })

    expect(snake.holeSummary(2)).toEqual(['B takes the snake', '↳ 3 putts — the snake is out'])
    expect(snake.holeSummary(6)).toEqual([
      'C takes the snake',
      '↳ 3 putts — B is off the hook',
    ])
    // the money lands on the last hole played, and says what it is for
    expect(snake.holeSummary(9)).toEqual([
      'C is left holding the snake',
      '↳ pays $1 to each of 3 other players — $3',
    ])
  })

  /**
   * S3: the doubling pot. Every bite doubles it, INCLUDING one that does not
   * change hands — the same player three-putting again is the snake biting
   * again, which is the whole menace of the house rule.
   *
   * $1 → $2 (hole 4, D again) → $4 (hole 7). A is left holding $4, paying $12.
   */
  it('S3: a doubling pot doubles on every bite, including a repeat', () => {
    const round = snakeRound(FOUR(), { doubling: true })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    putt(log, 'p-d', 2, 3)
    putt(log, 'p-d', 4, 3)
    putt(log, 'p-a', 7, 4)
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
      '↳ 3 putts — and it stays with them; the pot is now $2',
    ])
    // the bar carries the running value, so nobody is surprised at the end
    expect(snake.summaryParts).toEqual([{ label: 'H7', value: 'A has it · $4' }])
  })

  /**
   * S4: more than one three-putt on a hole. Playing order is not modelled, so
   * the WORST count takes it — a four-putt beats a three-putt — and a true tie
   * goes to whoever is later in the roster, the only stable stand-in for who
   * putted out last. Stability is the point: a holder that reshuffles between
   * re-derives would move money at random.
   */
  it('S4: the worst putt count takes it, then roster order', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    // hole 3: B three-putts, C four-putts → C, the worse offence
    putt(log, 'p-b', 3, 3)
    putt(log, 'p-c', 3, 4)
    // hole 5: A and D both three-putt → D, later in the roster
    putt(log, 'p-a', 5, 3)
    putt(log, 'p-d', 5, 3)
    const snake = snakeOf(round, log)

    expect(snake.bites.map((b) => [b.hole, b.holderId, b.putts])).toEqual([
      [3, 'p-c', 4],
      [5, 'p-d', 3],
    ])
  })

  /**
   * S5: zero is a chip-in and undefined is "not recorded". Neither is a
   * three-putt, and folding them together is the one mistake `ctx.puttsFor`
   * exists to prevent.
   */
  it('S5: a chip-in and an unrecorded hole are both not three-putts', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    putt(log, 'p-a', 1, 0)
    putt(log, 'p-b', 2, 2)
    // hole 3 has no putts recorded at all
    log.append({ type: 'round/completed' })

    expect(snakeOf(round, log).bites).toEqual([])
    expect(snakeOf(round, log).notes).toHaveLength(1)
  })

  /**
   * S6: undoing the deciding three-putt moves the snake BACK to whoever held
   * it before — free, because the holder is derived from the log every time
   * rather than accumulated. Invariant #2: undo is a compensation event.
   */
  it('S6: retracting the deciding three-putt hands the snake back', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    putt(log, 'p-b', 2, 3)
    const mistake = putt(log, 'p-c', 6, 3)
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
   * S7: clearing a count is different from correcting it to zero — zero is a
   * chip-in, and a chip-in is not "I never saw this". The snake goes back the
   * same way, and the cleared hole reports no bite at all.
   */
  it('S7: clearing a putt count hands the snake back, and does not read as 0', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    putt(log, 'p-b', 2, 3)
    putt(log, 'p-c', 6, 3)
    log.append({ type: 'score/puttsClear', playerId: 'p-c', hole: 6 })
    log.append({ type: 'round/completed' })

    const snake = snakeOf(round, log)
    expect(snake.bites.map((b) => b.hole)).toEqual([2])
    expect(snake.holderId).toBe('p-b')
  })

  /**
   * S8: mid-round the snake is HELD, not owed. It can still be passed, so
   * nothing settles — the bar says who has it and the standings say $0, which
   * is the honest reading of a bet still moving.
   */
  it('S8: a live round reports a holder and moves no money', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5])
    putt(log, 'p-b', 2, 3)
    const snake = snakeOf(round, log)

    expect(snake.holderId).toBe('p-b')
    expect(snake.settlement.lines).toHaveLength(0)
    expect(Object.values(snake.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
    expect(snake.notes).toBeUndefined()
    expect(snake.summaryParts).toEqual([{ label: 'H2', value: 'B has it' }])
    expect(snake.detailLines).toEqual([{ label: 'Snake', value: 'B · $1' }])
  })

  /**
   * S9: a round finished early pays on the last hole ANYBODY PLAYED — not hole
   * 9, which nobody reached, and not hole 1. `buildHoleLedger` attributes a
   * completed round's money to that hole independently, so the engine has to
   * agree with it or the sentence lands on one row and the payment on another.
   */
  it('S9: finishing early lands the money on the last hole played', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4])
    putt(log, 'p-b', 2, 3)
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
   * S10: putts on a hole nobody scored. The log will take them — the entry is
   * per hole, not per scored hole — and counting them would move the snake,
   * and its money, onto a hole that never happened: `buildHoleLedger` gives a
   * row to any hole whose deltas move, played or not.
   */
  it('S10: putts on a hole nobody played do not move the snake', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    putt(log, 'p-b', 2, 3)
    // hole 7 was never played, but carries a stray count
    putt(log, 'p-d', 7, 4)
    log.append({ type: 'round/completed' })

    const snake = snakeOf(round, log)
    expect(snake.bites.map((b) => b.hole)).toEqual([2])
    expect(snake.holderId).toBe('p-b')

    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!
    expect(rows.some((r) => r.hole === 7)).toBe(false)
  })

  /** A count naming somebody outside the round can only come from a corrupt or
   *  hand-edited log. It must not become the holder — `addLine` would refuse
   *  the whole line and Snake would pay nobody while looking settled. */
  it('S11: a putt count naming a non-player is inert', () => {
    const round = snakeRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    putt(log, 'p-nobody', 4, 5)
    log.append({ type: 'round/completed' })

    const snake = snakeOf(round, log)
    expect(snake.bites).toEqual([])
    expect(snake.notes).toHaveLength(1)
    assertZeroSum(snake.settlement)
  })

  /** Two players is the minimum roster, and the pot is one-for-one there. */
  it('S12: heads-up, the holder pays a single pot', () => {
    const round = snakeRound(makePlayers([{ name: 'A' }, { name: 'B' }]), { potCents: 500 })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    putt(log, 'p-a', 3, 3)
    log.append({ type: 'round/completed' })
    const snake = snakeOf(round, log)

    expect(snake.settlement.perPlayerCents).toEqual({ 'p-a': -500, 'p-b': 500 })
    expect(snake.holeSummary(9)).toEqual([
      'A is left holding the snake',
      '↳ pays $5 to each of 1 other player — $5',
    ])
  })
})

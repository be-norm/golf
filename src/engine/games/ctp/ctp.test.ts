import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { assertZeroSum } from '../../core/money'
import { EventLog, makePlayers, makeRound } from '../../test/harness'
import type { CtpDerivation } from './engine'

/**
 * The harness's default course, front 9: pars 4 4 5 3 4 4 3 5 4.
 * PAR 3s ARE HOLES 4 AND 7 — every fixture below is built on that.
 */
const PAR3 = [4, 7] as const

const FOUR = () => makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])

function ctpRound(players = FOUR(), stakeCents = 200) {
  return makeRound({
    players,
    holes: 'front9',
    games: [{ type: 'ctp', config: { stakeCents } }],
  })
}

function ctpOf(round: ReturnType<typeof makeRound>, log: EventLog): CtpDerivation {
  const { derivations } = deriveRound(round, log.events)
  return derivations.get(round.games[0]!.gameId) as CtpDerivation
}

/** Everyone scores par-ish on the given holes — CTP never reads the numbers,
 *  but `finalized`/`anyScored` do, and those are what gate the money. */
function scoreHoles(round: ReturnType<typeof makeRound>, log: EventLog, holes: number[]) {
  const card = Object.fromEntries(round.players.map((p) => [p.name, holes.map(() => 4)]))
  log.scoreByHole(round, card, holes)
}

const award = (log: EventLog, hole: number, playerId: string) =>
  log.append({ type: 'game/event', gameId: 'game-1', kind: 'ctp/award', data: { hole, playerId } })

describe('ctp — golden fixtures (hand-verified)', () => {
  /**
   * F1: 4 players, $2 a par 3, front 9 fully scored.
   * Hole 4 goes to B; hole 7 is never awarded and the card is played out.
   *
   * B collects $2 from each of the other three = +$6; A, C and D pay $2 each.
   * Hole 7 pays NOTHING and says so on `notes` — a $0 settlement line would
   * make `lines.length === 0` (the settle panel's "No money moved." signal)
   * false for a round where exactly one payment happened (MAI-40).
   */
  it('F1: one par 3 claimed, one unclaimed', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 4, 'p-b')
    const ctp = ctpOf(round, log)

    expect(ctp.settlement.perPlayerCents).toEqual({
      'p-a': -200,
      'p-b': 600,
      'p-c': -200,
      'p-d': -200,
    })
    assertZeroSum(ctp.settlement)
    expect(ctp.settlement.lines).toHaveLength(1)
    expect(ctp.settlement.lines[0]!.label).toBe('Hole 4 — B closest to the pin')

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'won', winnerId: 'p-b' },
      { hole: 7, kind: 'unclaimed' },
    ])
    expect(ctp.notes).toEqual([
      'Closest to the pin went unclaimed on hole 7 — nobody was given it, so nothing was paid',
    ])
    expect(ctp.standings[0]).toMatchObject({ label: 'B', amountCents: 600, detail: '1 CTP' })
    expect(ctp.standings[1]).toMatchObject({ detail: '0 CTPs' })
    // the bar recaps the latest DECIDED hole — hole 7, which nobody won
    expect(ctp.summaryParts).toEqual([{ label: 'H7', value: 'nobody inside' }])
    expect(ctp.holeSummary(4)).toEqual([
      'B closest to the pin',
      '↳ $2 from each of 3 other players — $6',
    ])
  })

  /**
   * F2 — THE REGRESSION THAT DEFINES THE CHANNEL (MAI-46).
   *
   * `ctx.finalized` goes true the moment play moves on, so a hole 7 with no
   * award yet is "finalized and unawarded" from the 8th tee onwards. Declaring
   * it dead there would put "nobody inside" on the pinned bar and a note in the
   * settle panel while the group is still on the course and fully intends to
   * record it at the turn — which is the exact workflow the award channel was
   * built to allow. Nothing is dead until the card is played out.
   */
  it('F2: an unawarded par 3 stays silent while the card is still live', () => {
    const round = ctpRound()
    const log = new EventLog()
    // holes 1–8 scored: hole 7 IS finalized (play moved to 8), hole 9 is not
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8])
    award(log, 4, 'p-b')
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'won', winnerId: 'p-b' },
      { hole: 7, kind: 'pending' },
    ])
    expect(ctp.notes).toBeUndefined()
    expect(ctp.holeSummary(7)).toEqual([])
    // and the bar recaps hole 4, the only hole that has actually decided
    expect(ctp.summaryParts).toEqual([{ label: 'H4', value: 'B closest' }])

    // …then the last hole lands and the same log declares it
    scoreHoles(round, log, [9])
    expect(ctpOf(round, log).notes).toHaveLength(1)
  })

  /**
   * A par 3 the group never reached is not a par 3 that went unclaimed.
   * Finishing early finalizes every hole at once, and narrating one nobody
   * played is a claim about golf that never happened (MAI-38).
   */
  it('F3: a par 3 nobody played is never called unclaimed', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5])
    award(log, 4, 'p-c')
    log.append({ type: 'round/completed' })
    const ctp = ctpOf(round, log)

    // hole 7 is finalized by completion, and absent from the results entirely
    expect(ctp.holeResults).toEqual([{ hole: 4, kind: 'won', winnerId: 'p-c' }])
    expect(ctp.notes).toBeUndefined()
  })

  /**
   * Re-tapping a different name is a CORRECTION, not a second award — the same
   * last-write-wins rule `deriveGross` applies to a corrected score. One line,
   * one winner, and the money is the second player's.
   */
  it('F4: the last award on a hole wins, and pays once', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 4, 'p-b')
    award(log, 4, 'p-d')
    award(log, 7, 'p-a')
    const ctp = ctpOf(round, log)

    expect(ctp.settlement.lines).toHaveLength(2)
    expect(ctp.settlement.perPlayerCents).toEqual({
      'p-a': 400, // +$6 on 7, -$2 on 4
      'p-b': -400,
      'p-c': -400,
      'p-d': 400,
    })
    assertZeroSum(ctp.settlement)
  })

  /**
   * Undo CLEARS the hole rather than revealing whoever held it before. A mistap
   * corrected twice must not leave the first player quietly holding money
   * nobody re-confirmed — so the lit cell retracts every award event on the
   * hole, not just the newest.
   */
  it('F5: taking back an award clears the hole, not just its latest tap', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const first = award(log, 4, 'p-b')
    const second = award(log, 4, 'p-d')

    const lit = ctpOf(round, log)
      .awards!(4)
      .find((a) => a.taken)!
    expect(lit.playerId).toBe('p-d')
    expect(lit.undoEventIds).toEqual([first.id, second.id])

    for (const id of lit.undoEventIds!) log.append({ type: 'meta/retract', targetEventId: id })
    const cleared = ctpOf(round, log)
    expect(cleared.holeResults[0]).toEqual({ hole: 4, kind: 'unclaimed' })
    expect(cleared.settlement.lines).toHaveLength(0)
    expect(Object.values(cleared.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
  })

  /** An award naming somebody outside the round can only come from a corrupt or
   *  hand-edited log. It must move no money rather than pay a ghost — which
   *  would leave the others down a stake nobody collected. */
  it('F6: an award naming a non-player is inert', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 4, 'p-nobody')
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults[0]).toEqual({ hole: 4, kind: 'unclaimed' })
    assertZeroSum(ctp.settlement)
    expect(Object.values(ctp.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
  })

  /** Two players is the minimum roster, and the stake is one-for-one there. */
  it('F7: heads-up, the winner collects a single stake', () => {
    const round = ctpRound(makePlayers([{ name: 'A' }, { name: 'B' }]), 500)
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 4, 'p-a')
    award(log, 7, 'p-a')
    const ctp = ctpOf(round, log)

    expect(ctp.settlement.perPlayerCents).toEqual({ 'p-a': 1000, 'p-b': -1000 })
    expect(ctp.holeSummary(4)).toEqual([
      'A closest to the pin',
      '↳ $5 from each of 1 other player — $5',
    ])
  })
})

describe('ctp — the award grid it offers', () => {
  it('offers one cell per player on a par 3, and nothing anywhere else', () => {
    const round = ctpRound()
    const log = new EventLog()
    const ctp = ctpOf(round, log)

    for (const hole of PAR3) {
      const cells = ctp.awards!(hole)
      expect(cells.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D'])
      expect(cells.every((c) => c.group === 'Closest to the pin')).toBe(true)
      expect(cells.every((c) => c.hole === hole)).toBe(true)
      // every award payload carries its hole — the ledger places a game event
      // in its prefix replay by reading it, and an award is the one thing
      // recorded long after the hole it names
      expect(cells.every((c) => (c.data as { hole: number }).hole === hole)).toBe(true)
      expect(cells.some((c) => c.taken)).toBe(false)
    }
    for (const hole of [1, 2, 3, 5, 6, 8, 9]) expect(ctp.awards!(hole)).toEqual([])
  })

  /**
   * THE LIFECYCLE RULE. A hole two behind the frontier, and a hole on a card
   * where everything is already scored, both stay tappable — that is the entire
   * difference between this channel and the frontier-gated actions one.
   */
  it('keeps offering cells behind the frontier and after every hole is scored', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const ctp = ctpOf(round, log)

    expect(ctp.awards!(4)).toHaveLength(4)
    expect(ctp.awards!(7)).toHaveLength(4)
  })

  it('lights exactly the winning cell, and only that cell carries an undo', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4])
    const evt = award(log, 4, 'p-c')
    const cells = ctpOf(round, log).awards!(4)

    expect(cells.filter((c) => c.taken).map((c) => c.playerId)).toEqual(['p-c'])
    expect(cells.find((c) => c.taken)!.undoEventIds).toEqual([evt.id])
    // an untappable-back cell must not carry one, or a screen could retract
    // off a cell that was never tapped
    expect(cells.filter((c) => !c.taken).every((c) => c.undoEventIds === undefined)).toBe(true)
  })
})

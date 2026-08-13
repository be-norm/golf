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

/**
 * FULL 18 pars: 4 4 5 3 4 4 3 5 4 · 4 5 3 4 4 5 3 4 4.
 * PAR 3s ARE 4, 7, 12 AND 16 — four of them, which is what the carry fixtures
 * need, and they are separated by one, four and three ineligible holes, which
 * is what makes "the holes in between do not count" a real test rather than a
 * staged one.
 */
const CARRY_PAR3 = [4, 7, 12, 16] as const

function carryRound(players = FOUR(), stakeCents = 200) {
  return makeRound({
    players,
    holes: 'full18',
    games: [{ type: 'ctp', config: { stakeCents, carryover: true } }],
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
    log.append({ type: 'round/completed' })
    const ctp = ctpOf(round, log)

    expect(ctp.settlement.perPlayerCents).toEqual({
      'p-a': -200,
      'p-b': 600,
      'p-c': -200,
      'p-d': -200,
    })
    assertZeroSum(ctp.settlement)
    expect(ctp.settlement.lines).toHaveLength(1)
    // the game's name is the panel heading directly above this line, so the
    // line itself says only what the heading cannot
    expect(ctp.settlement.lines[0]!.label).toBe('Hole 4 — B')

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'won', winnerId: 'p-b', units: 1 },
      { hole: 7, kind: 'unclaimed' },
    ])
    expect(ctp.notes).toEqual([
      'Unclaimed on hole 7 — nobody was given it, so nothing was paid',
    ])
    expect(ctp.standings[0]).toMatchObject({ label: 'B', amountCents: 600, detail: '1 CTP' })
    expect(ctp.standings[1]).toMatchObject({ detail: '0 CTPs' })
    // the bar recaps the latest DECIDED hole — hole 7, which nobody won
    expect(ctp.summaryParts).toEqual([{ label: 'H7', value: 'nobody inside' }])
    // the block heading already says the game, so the line says who
    expect(ctp.holeSummary(4)).toEqual([
      'B closest',
      '↳ $2 from each of 3 other players — $6',
    ])
  })

  /** F1b: two unclaimed par 3s — the plural sentence. F1 covers the singular,
   *  and the two differ by a pronoun that reaches the PAINTED share card. */
  it('F1b: two unclaimed par 3s read as a plural sentence', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    log.append({ type: 'round/completed' })

    expect(ctpOf(round, log).notes).toEqual([
      'Unclaimed on holes 4, 7 — nobody was given them, so nothing was paid',
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
   * built to allow.
   */
  it('F2: an unawarded par 3 stays silent while the round is still live', () => {
    const round = ctpRound()
    const log = new EventLog()
    // holes 1–8 scored: hole 7 IS finalized (play moved to 8), hole 9 is not
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8])
    award(log, 4, 'p-b')
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'won', winnerId: 'p-b', units: 1 },
      { hole: 7, kind: 'pending' },
    ])
    expect(ctp.notes).toBeUndefined()
    expect(ctp.holeSummary(7)).toEqual([])
    // and the bar recaps hole 4, the only hole that has actually decided
    expect(ctp.summaryParts).toEqual([{ label: 'H4', value: 'B closest' }])

    // …then the group finishes, and the same log declares it
    scoreHoles(round, log, [9])
    log.append({ type: 'round/completed' })
    expect(ctpOf(round, log).notes).toHaveLength(1)
  })

  /**
   * F2b — THE SAME BUG ONE LAYER DOWN, and the reason this asks `ctx.completed`
   * rather than "every hole is finalized".
   *
   * D picks up on the par 3 at hole 7, so that hole is finalized (play moved on)
   * but never complete. Every OTHER hole is finalized too once hole 9 is scored
   * out — so "the card is played out" is satisfied while the round is still
   * live, the scoring screen is still showing game rows, and the award cell for
   * hole 7 is still lit for the taking. Picking up is a thing this engine
   * explicitly supports: a winner who then picked up still won the tee shot.
   */
  it('F2b: a player picking up does not kill the CTP on that hole', () => {
    const round = ctpRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6])
    // hole 7: A, B and C post, D picks up
    for (const name of ['A', 'B', 'C']) {
      log.append({ type: 'score/set', playerId: `p-${name.toLowerCase()}`, hole: 7, gross: 3 })
    }
    scoreHoles(round, log, [8, 9])

    const ctp = ctpOf(round, log)
    // every hole is finalized, and hole 7 is STILL enterable
    expect(round.players.every((p) => ctp.awards!(7).some((c) => c.playerId === p.playerId))).toBe(true)
    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'pending' },
      { hole: 7, kind: 'pending' },
    ])
    expect(ctp.notes).toBeUndefined()
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
    expect(ctp.holeResults).toEqual([{ hole: 4, kind: 'won', winnerId: 'p-c', units: 1 }])
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
    log.append({ type: 'round/completed' })

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
    log.append({ type: 'round/completed' })
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
      'A closest',
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

describe('ctp — carryovers', () => {
  /**
   * C1 — THE POINT OF THE FEATURE, and the rule the user actually asked for.
   *
   * Nobody is given hole 4, so its $2 rolls onto hole 7 and B wins a DOUBLE.
   * Between them sit holes 5 and 6, both par 4s, both scored and both finalized:
   * they are no part of this bet and contribute nothing, so hole 7 is worth
   * exactly 2 CTPs and not 4.
   *
   * B collects 2 × $2 = $4 from each of the other three = +$12; the others pay
   * $4 apiece. Hole 4 files no settlement line at all — nothing moved there,
   * and a $0 row would make `lines.length === 0` false (MAI-40).
   */
  it('C1: an unclaimed par 3 doubles the next one, and the par 4s between do nothing', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7])
    award(log, 7, 'p-b')
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'carried', carryAfter: 1 },
      { hole: 7, kind: 'won', winnerId: 'p-b', units: 2 },
    ])
    expect(ctp.settlement.perPlayerCents).toEqual({
      'p-a': -400,
      'p-b': 1200,
      'p-c': -400,
      'p-d': -400,
    })
    assertZeroSum(ctp.settlement)
    // ONE line, on the hole that banked it, and it says what it was worth —
    // without the multiplier a doubled hole reads as an ordinary one at twice
    // the money
    expect(ctp.settlement.lines).toHaveLength(1)
    expect(ctp.settlement.lines[0]!.label).toBe('Hole 7 — B (2 CTPs)')

    expect(ctp.holeSummary(4)).toEqual([
      'Nobody inside — 1 carried',
      '↳ it rolls onto the next par 3 — the par 4s and 5s in between do not count',
    ])
    expect(ctp.holeSummary(7)).toEqual([
      'B closest — 2 CTPs',
      '↳ this par 3 + 1 carried in',
      '↳ $4 from each of 3 other players — $12',
    ])
    // the ineligible holes have nothing to say, which is the same statement
    // `holeResults` makes by holding only 4 and 7
    for (const hole of [1, 2, 3, 5, 6]) expect(ctp.holeSummary(hole)).toEqual([])
    expect(ctp.summaryParts).toEqual([{ label: 'H7', value: 'B closest · 2 CTPs' }])
    expect(ctp.standings[0]).toMatchObject({ label: 'B', amountCents: 1200, detail: '2 CTPs' })
    // banked, so nothing is riding and the bar's money aggregate can say it all
    expect(ctp.carrying).toBe(0)
    expect(ctp.openBet).toBeUndefined()
  })

  /**
   * C2 — FOUR INELIGIBLE HOLES IN THE GAP, which is the version of C1 that
   * could not pass by accident. Holes 8–11 (par 5, 4, 4, 5) sit between par 3s
   * 7 and 12, all scored. An engine that carried on every finalized hole rather
   * than every eligible one would make hole 12 worth 6 CTPs; the answer is 2.
   */
  it('C2: a carry walks past four ineligible holes without growing', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    award(log, 4, 'p-a') // banked immediately — the carry under test starts at 7
    award(log, 12, 'p-b')
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'won', winnerId: 'p-a', units: 1 },
      { hole: 7, kind: 'carried', carryAfter: 1 },
      { hole: 12, kind: 'won', winnerId: 'p-b', units: 2 },
    ])
    // A took $2 from each of 3 = +$6, then paid $4 on 12 → +$2
    // B paid $2 on 4, then took $4 from each of 3 = +$12 → +$10
    expect(ctp.settlement.perPlayerCents).toEqual({
      'p-a': 200,
      'p-b': 1000,
      'p-c': -600,
      'p-d': -600,
    })
    assertZeroSum(ctp.settlement)
  })

  /** C3: two unclaimed par 3s in a row treble the third. */
  it('C3: two in a row make the next par 3 worth three CTPs', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    award(log, 12, 'p-c')
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'carried', carryAfter: 1 },
      { hole: 7, kind: 'carried', carryAfter: 2 },
      { hole: 12, kind: 'won', winnerId: 'p-c', units: 3 },
    ])
    // 3 × $2 = $6 from each of the other three = +$18
    expect(ctp.settlement.perPlayerCents).toEqual({
      'p-a': -600,
      'p-b': -600,
      'p-c': 1800,
      'p-d': -600,
    })
    assertZeroSum(ctp.settlement)
    expect(ctp.holeSummary(12)).toEqual([
      'C closest — 3 CTPs',
      '↳ this par 3 + 2 carried in',
      '↳ $6 from each of 3 other players — $18',
    ])
  })

  /**
   * C4 — A CARRY WITH NOWHERE TO GO, and the reason the kit asks a positional
   * lookahead question at all.
   *
   * Hole 16 is the LAST par 3 of the walk. It is finalized the moment play
   * reaches 17 — but nothing has carried anywhere, because there is no par 3
   * left for a stake to roll onto, and the money is still perfectly claimable
   * ON HOLE 16 while its cell is lit. Calling it "carried" there would put a
   * pile riding onto a par 3 that does not exist, which is exactly the sentence
   * MAI-38 was filed about.
   *
   * So it stays `pending` while the round is live, and joins the dead pile at
   * completion — not before.
   */
  it('C4: the last par 3 never reads as carried while the round is live', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
    for (const hole of [4, 7, 12]) award(log, hole, 'p-a')
    const live = ctpOf(round, log)

    expect(live.holeResults).toEqual([
      { hole: 4, kind: 'won', winnerId: 'p-a', units: 1 },
      { hole: 7, kind: 'won', winnerId: 'p-a', units: 1 },
      { hole: 12, kind: 'won', winnerId: 'p-a', units: 1 },
      { hole: 16, kind: 'pending' },
    ])
    expect(live.carrying).toBe(0)
    expect(live.carryDied).toBe(0)
    // nothing riding, so nothing to announce on the bar's open-bet row
    expect(live.openBet).toBeUndefined()
    expect(live.holeSummary(16)).toEqual([])
    expect(live.notes).toBeUndefined()

    // …and the same log, once the round is over, calls it what it is
    log.append({ type: 'round/completed' })
    const done = ctpOf(round, log)
    expect(done.holeResults[3]).toEqual({ hole: 16, kind: 'carried', carryAfter: 1 })
    expect(done.carryDied).toBe(1)
    expect(done.notes).toEqual(['1 CTP died unwon — no par 3 left to win it'])
  })

  /**
   * C5 — THE WHOLE PILE DIES, and where it gets narrated.
   *
   * Nobody is given any of the four par 3s. Holes 4, 7 and 12 carry; hole 16
   * has nothing to carry onto, so it waits for completion and then takes the
   * pile with it. The death is stated on hole 16's ledger row — the last par 3,
   * where the money was sitting — and NOT on hole 18, which is what
   * `ctx.lastPlayedHole` would have given: a CTP sentence on a par 4 this game
   * has no business in.
   */
  it('C5: an unclaimed last par 3 kills the whole pile, on its own row', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, Array.from({ length: 18 }, (_, i) => i + 1))

    // While live: three carried, and hole 16 still claimable. The bar prices
    // THE HOLE, not the pile — 4 CTPs at $2 is $8 from each of the other three,
    // $24 to whoever wins it. C10 below pins that against the real payout.
    const live = ctpOf(round, log)
    expect(live.carrying).toBe(3)
    expect(live.openBet).toBe('4 CTPs riding · $24')

    log.append({ type: 'round/completed' })
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'carried', carryAfter: 1 },
      { hole: 7, kind: 'carried', carryAfter: 2 },
      { hole: 12, kind: 'carried', carryAfter: 3 },
      { hole: 16, kind: 'carried', carryAfter: 4 },
    ])
    expect(ctp.carryDied).toBe(4)
    expect(ctp.settlement.lines).toHaveLength(0)
    expect(Object.values(ctp.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
    // dead money is something to SAY, never a $0 line (MAI-40)
    expect(ctp.notes).toEqual(['4 CTPs died unwon — no par 3 left to win them'])
    // ONE phrasing, shared by the note and the row that explains it
    expect(ctp.holeSummary(16)).toEqual([
      'Nobody inside',
      '↳ 4 CTPs died unwon — no par 3 left to win them',
    ])
    // …and hole 18, which `ctx.lastPlayedHole` would have chosen, says nothing
    expect(ctp.holeSummary(18)).toEqual([])
    expect(ctp.summaryParts).toEqual([{ label: 'H16', value: 'nobody inside · 4 CTPs died unwon' }])
    // dead is not riding: the open-bet row goes away rather than promising a
    // pot nobody can win
    expect(ctp.openBet).toBeUndefined()
  })

  /**
   * C6 — THE COST OF PRICING A CARRY LIVE, pinned so it stays a choice.
   *
   * The award channel exists to let you record hole 4 on the 18th green, and
   * until you do, hole 7 is priced as a double. Recording it late re-prices
   * both holes FORWARD to the truth — exactly as a corrected score re-prices a
   * hole — and the settlement stays balanced through it.
   */
  it('C6: recording a skipped par 3 late un-carries the hole that banked it', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7])
    award(log, 7, 'p-b')
    expect(ctpOf(round, log).settlement.perPlayerCents['p-b']).toBe(1200)

    // …then somebody remembers that A was inside on 4
    award(log, 4, 'p-a')
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'won', winnerId: 'p-a', units: 1 },
      { hole: 7, kind: 'won', winnerId: 'p-b', units: 1 },
    ])
    expect(ctp.settlement.perPlayerCents).toEqual({
      'p-a': 400, // +$6 on 4, -$2 on 7
      'p-b': 400,
      'p-c': -400,
      'p-d': -400,
    })
    assertZeroSum(ctp.settlement)
  })

  /**
   * C7: a par 3 the group never reached must not carry. Finishing early
   * finalizes every remaining hole at once, and a hole nobody played left no
   * money over — the same rule that keeps it out of `unclaimed` (MAI-38).
   */
  it('C7: a par 3 nobody played contributes nothing to the pile', () => {
    const round = carryRound()
    const log = new EventLog()
    // stopped after 8: par 3s 12 and 16 were never reached
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8])
    log.append({ type: 'round/completed' })
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'carried', carryAfter: 1 },
      { hole: 7, kind: 'carried', carryAfter: 2 },
    ])
    // 2, not 4 — the unplayed par 3s are absent, not silently in the pile
    expect(ctp.carryDied).toBe(2)
    expect(ctp.notes).toEqual(['2 CTPs died unwon — no par 3 left to win them'])
    expect(ctp.holeSummary(7)).toEqual([
      'Nobody inside',
      '↳ 2 CTPs died unwon — no par 3 left to win them',
    ])
  })

  /** C8: with carryovers OFF, the same card still reports unclaimed holes and
   *  carries nothing — the regression bar for every fixture above this block. */
  it('C8: carryovers off leaves every par 3 standing on its own', () => {
    const round = makeRound({
      players: FOUR(),
      holes: 'full18',
      games: [{ type: 'ctp', config: { stakeCents: 200, carryover: false } }],
    })
    const log = new EventLog()
    scoreHoles(round, log, Array.from({ length: 18 }, (_, i) => i + 1))
    award(log, 12, 'p-b')
    log.append({ type: 'round/completed' })
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'unclaimed' },
      { hole: 7, kind: 'unclaimed' },
      { hole: 12, kind: 'won', winnerId: 'p-b', units: 1 },
      { hole: 16, kind: 'unclaimed' },
    ])
    expect(ctp.carrying).toBe(0)
    expect(ctp.carryDied).toBe(0)
    // B wins ONE CTP, not three
    expect(ctp.settlement.perPlayerCents['p-b']).toBe(600)
    expect(ctp.notes).toEqual([
      'Unclaimed on holes 4, 7, 16 — nobody was given them, so nothing was paid',
    ])
  })

  /**
   * C9 — A CONFIG WRITTEN BEFORE THIS OPTION EXISTED. Every CTP round already
   * in IndexedDB and in the synced archive carries `{ stakeCents }` and nothing
   * else. `deriveRound` makes a game whose config its own engine rejects INERT,
   * so a required `carryover` would have silently emptied all of them — no
   * grid, no money, no error.
   */
  it('C9: a legacy config with no carryover key still plays, and does not carry', () => {
    const round = ctpRound() // front 9, `{ stakeCents: 200 }` — no carryover key
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7])
    award(log, 7, 'p-b')
    const ctp = ctpOf(round, log)

    // derived at all (not inert), and hole 4 did not roll into hole 7
    expect(ctp.holeResults).toEqual([
      { hole: 4, kind: 'pending' },
      { hole: 7, kind: 'won', winnerId: 'p-b', units: 1 },
    ])
    expect(ctp.settlement.perPlayerCents['p-b']).toBe(600)
    expect(ctp.awards!(4)).toHaveLength(4)
  })

  /**
   * C10 — THE BAR'S NUMBER IS THE NUMBER THAT GETS PAID, asserted against the
   * real payout rather than against a literal, so the two cannot drift.
   *
   * `openBet` prices the next par 3, which is `carrying + 1` units — not the
   * carried pile. Quoting the pile understated it by exactly one hole's worth
   * ($18 against a $24 payout), which is the one figure a group reads off the
   * bar before swinging.
   */
  it('C10: the open bet quotes what the next par 3 actually pays', () => {
    for (const carried of [1, 2, 3]) {
      const round = carryRound()
      const log = new EventLog()
      scoreHoles(round, log, Array.from({ length: 18 }, (_, i) => i + 1))
      // bank the earliest par 3s to A, leaving exactly `carried` riding into 16
      for (const hole of CARRY_PAR3.slice(0, CARRY_PAR3.length - carried - 1)) {
        award(log, hole, 'p-a')
      }
      const live = ctpOf(round, log)
      expect(live.carrying, `${carried} carried`).toBe(carried)

      // …then B wins hole 16, and B's DELTA is exactly what that hole paid —
      // whatever B lost on the holes A banked earlier is already in `before`
      const before = live.settlement.perPlayerCents['p-b']!
      award(log, 16, 'p-b')
      const after = ctpOf(round, log).settlement.perPlayerCents['p-b']!

      const units = carried + 1
      expect(after - before, `${carried} carried`).toBe(units * 200 * 3)
      expect(live.openBet, `${carried} carried`).toBe(`${units} CTPs riding · $${units * 2 * 3}`)
    }
  })

  /** …and the rule it must NOT swallow: a par 3 with neither a score nor an
   *  award is still a hole nobody played, and stays out of the results
   *  entirely (MAI-38). C7 covers the carry side; this pins the boundary. */
  it('C11b: a par 3 with no score and no award is still absent', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, Array.from({ length: 15 }, (_, i) => i + 1))
    log.append({ type: 'round/completed' })

    expect(ctpOf(round, log).holeResults.map((r) => r.hole)).toEqual([4, 7, 12])
  })

  /** The par 3s the carry fixtures are built on — asserted, not assumed, so a
   *  change to the harness course fails here rather than silently rewriting
   *  every expectation above. */
  it('the fixture course really does hold four par 3s where the tests say', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, Array.from({ length: 18 }, (_, i) => i + 1))
    const ctp = ctpOf(round, log)

    expect(ctp.holeResults.map((r) => r.hole)).toEqual([...CARRY_PAR3])
  })
})

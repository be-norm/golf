import { describe, expect, it } from 'vitest'
import { deriveAwardPot, type AwardPot } from './awardPot'
import { buildRoundContext } from './context'
import { assertZeroSum } from './money'
import { effectiveEvents, gameEventsFor } from './replay'
import { EventLog, makePlayers, makeRound } from '../test/harness'

/**
 * THE AWARD KIT'S CLASSIFICATION TABLE, stated once so a new award game learns
 * the rules here rather than by reading whichever engine happens to exist.
 *
 * The two that matter — and the two that were regressions in CTP (MAI-46) —
 * are the last pair: an unawarded hole is PENDING while the round is live and
 * only UNCLAIMED once it is over, and "every hole is finalized" is not the same
 * question. `ctp.test.ts` F2/F2b hold those against a real engine; this holds
 * them against the kit, so the next game inherits the answer rather than the
 * bug.
 */

/** Harness front 9 pars: 4 4 5 3 4 4 3 5 4. This kit is told which holes it
 *  plays for, so the fixture picks two arbitrary ones and says so. */
const ELIGIBLE = [2, 5] as const

const FOUR = () => makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])

function potRound(players = FOUR()) {
  // No game needs to be REGISTERED: the kit is a pure function of context and
  // events, which is exactly what makes it testable without one.
  return makeRound({ players, holes: 'front9', games: [{ type: 'probe', config: {} }] })
}

function potOf(round: ReturnType<typeof makeRound>, log: EventLog, stakeCents = 200): AwardPot {
  const effective = effectiveEvents(log.events)
  const ctx = buildRoundContext(round, effective)
  return deriveAwardPot(ctx, gameEventsFor(effective, 'game-1'), {
    gameId: 'game-1',
    stakeCents,
    eligible: (hole) => (ELIGIBLE as readonly number[]).includes(hole),
    group: 'Prize',
    eventKind: 'probe/award',
    lineLabel: (hole, winner) => `Hole ${hole} — ${winner}`,
  })
}

function scoreHoles(round: ReturnType<typeof makeRound>, log: EventLog, holes: number[]) {
  const card = Object.fromEntries(round.players.map((p) => [p.name, holes.map(() => 4)]))
  log.scoreByHole(round, card, holes)
}

const award = (log: EventLog, hole: number, playerId: string) =>
  log.append({ type: 'game/event', gameId: 'game-1', kind: 'probe/award', data: { hole, playerId } })

describe('deriveAwardPot — which holes report what', () => {
  it('skips an eligible hole nobody played, even once the round is over', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    log.append({ type: 'round/completed' })
    // hole 5 is eligible and finalized by completion — and absent, because
    // narrating a hole nobody played is a claim about golf that never happened
    expect(potOf(round, log).holeResults).toEqual([{ hole: 2, kind: 'unclaimed' }])
  })

  it('is pending on the frontier hole, where scores can still change', () => {
    const round = potRound()
    const log = new EventLog()
    // hole 5 is the last hole touched, so it is not finalized
    scoreHoles(round, log, [1, 2, 3, 4, 5])
    award(log, 2, 'p-b')
    expect(potOf(round, log).holeResults).toEqual([
      { hole: 2, kind: 'won', winnerId: 'p-b' },
      { hole: 5, kind: 'pending' },
    ])
  })

  /** The regression the channel exists for: finalized-and-unawarded is NOT dead
   *  while the group is still on the course intending to record it. */
  it('stays pending, not unclaimed, while the round is live', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const live = potOf(round, log)
    expect(live.holeResults.every((r) => r.kind === 'pending')).toBe(true)
    expect(live.settlement.lines).toHaveLength(0)

    log.append({ type: 'round/completed' })
    expect(potOf(round, log).holeResults).toEqual([
      { hole: 2, kind: 'unclaimed' },
      { hole: 5, kind: 'unclaimed' },
    ])
  })

  /** …and the same bug one layer down: one player picking up finalizes a hole
   *  without completing it, so "every hole finalized" fires while play goes on. */
  it('a player picking up does not kill the award on that hole', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1])
    for (const id of ['p-a', 'p-b', 'p-c']) {
      log.append({ type: 'score/set', playerId: id, hole: 2, gross: 4 })
    }
    scoreHoles(round, log, [3, 4, 5, 6, 7, 8, 9])
    const pot = potOf(round, log)
    expect(pot.holeResults.find((r) => r.hole === 2)).toEqual({ hole: 2, kind: 'pending' })
    expect(pot.awards(2)).toHaveLength(4)
  })
})

describe('deriveAwardPot — the money', () => {
  it('pays the winner a stake from every other player, and balances', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 2, 'p-b')
    const pot = potOf(round, log)

    expect(pot.settlement.perPlayerCents).toEqual({
      'p-a': -200,
      'p-b': 600,
      'p-c': -200,
      'p-d': -200,
    })
    assertZeroSum(pot.settlement)
    expect(pot.settlement.lines.map((l) => l.label)).toEqual(['Hole 2 — B'])
    expect(pot.wonByPlayer.get('p-b')).toBe(1)
    expect(pot.wonByPlayer.get('p-a')).toBe(0)
  })

  /** THE WHOLE ROSTER PAYS — a winner who then picked up still won the shot. */
  it('charges players who posted no score on the hole', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1])
    for (const id of ['p-a', 'p-b']) {
      log.append({ type: 'score/set', playerId: id, hole: 2, gross: 4 })
    }
    scoreHoles(round, log, [3])
    award(log, 2, 'p-a')
    const pot = potOf(round, log)

    expect(pot.settlement.perPlayerCents).toEqual({
      'p-a': 600,
      'p-b': -200,
      'p-c': -200,
      'p-d': -200,
    })
    assertZeroSum(pot.settlement)
  })

  it('the last award on a hole wins, and pays once', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 2, 'p-b')
    award(log, 2, 'p-d')
    const pot = potOf(round, log)

    expect(pot.settlement.lines).toHaveLength(1)
    expect(pot.holeResults[0]).toEqual({ hole: 2, kind: 'won', winnerId: 'p-d' })
  })

  /**
   * A ONE-PLAYER ROUND, which every `validateSetup` refuses and `importRound`
   * accepts (`.min(1)` on the roster). The winner collects from nobody, so the
   * line is every-entry-zero — and a zero row would make `lines.length === 0`,
   * the settle panel's "No money moved." signal, false on a round where nothing
   * moved (MAI-40). `addLine` refuses it at the choke point, which is where a
   * bug that zeroes every engine at once belongs; this pins that the kit
   * inherits the refusal rather than working around it.
   */
  it('a winner with nobody to collect from moves no money and files no line', () => {
    const round = potRound(makePlayers([{ name: 'A' }]))
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    award(log, 2, 'p-a')
    log.append({ type: 'round/completed' })
    const pot = potOf(round, log)

    expect(pot.holeResults[0]).toEqual({ hole: 2, kind: 'won', winnerId: 'p-a' })
    expect(pot.settlement.lines).toHaveLength(0)
    expect(pot.settlement.perPlayerCents).toEqual({ 'p-a': 0 })
  })

  /** An award naming somebody outside the round can only come from a corrupt or
   *  hand-edited log. It must move no money rather than pay a ghost. */
  it('an award naming a non-player is inert', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 2, 'p-nobody')
    log.append({ type: 'round/completed' })
    const pot = potOf(round, log)

    expect(pot.holeResults[0]).toEqual({ hole: 2, kind: 'unclaimed' })
    assertZeroSum(pot.settlement)
    expect(Object.values(pot.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
  })
})

describe('deriveAwardPot — the cells it offers', () => {
  it('offers one cell per player on an eligible hole, and nothing elsewhere', () => {
    const round = potRound()
    const pot = potOf(round, new EventLog())

    for (const hole of ELIGIBLE) {
      const cells = pot.awards(hole)
      expect(cells.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D'])
      expect(cells.every((c) => c.group === 'Prize')).toBe(true)
      // every payload carries its hole — `buildHoleLedger` places a game event
      // in its prefix replay by reading it, and an award is the one thing
      // recorded long after the hole it names
      expect(cells.every((c) => (c.data as { hole: number }).hole === hole)).toBe(true)
      expect(cells.some((c) => c.taken)).toBe(false)
    }
    for (const hole of [1, 3, 4, 6, 7, 8, 9]) expect(pot.awards(hole)).toEqual([])
  })

  /** THE LIFECYCLE RULE: no frontier gate and no all-scored gate. */
  it('keeps offering cells behind the frontier and after every hole is scored', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(potOf(round, log).awards(2)).toHaveLength(4)
  })

  /**
   * Undo CLEARS the hole rather than revealing whoever held it before. A mistap
   * corrected twice must not leave the first player quietly holding money
   * nobody re-confirmed — so the lit cell retracts every award event on the
   * hole, not just the newest.
   */
  it('lights only the winner, and its undo retracts every tap on the hole', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    const first = award(log, 2, 'p-b')
    const second = award(log, 2, 'p-d')
    const cells = potOf(round, log).awards(2)

    const lit = cells.filter((c) => c.taken)
    expect(lit.map((c) => c.playerId)).toEqual(['p-d'])
    expect(lit[0]!.undoEventIds).toEqual([first.id, second.id])
    // an untappable-back cell must not carry one, or a screen could retract
    // off a cell that was never tapped
    expect(cells.filter((c) => !c.taken).every((c) => c.undoEventIds === undefined)).toBe(true)

    for (const id of lit[0]!.undoEventIds!) log.append({ type: 'meta/retract', targetEventId: id })
    expect(potOf(round, log).awards(2).some((c) => c.taken)).toBe(false)
  })

  it('ignores an event of another kind on the same game', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'probe/somethingElse',
      data: { hole: 2, playerId: 'p-a' },
    })
    expect(potOf(round, log).awards(2).some((c) => c.taken)).toBe(false)
  })
})

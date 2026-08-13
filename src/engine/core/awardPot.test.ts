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

function potOf(
  round: ReturnType<typeof makeRound>,
  log: EventLog,
  opts: { stakeCents?: number; carryover?: boolean; eligible?: readonly number[] } = {},
): AwardPot {
  const { stakeCents = 200, carryover = false, eligible = ELIGIBLE } = opts
  const effective = effectiveEvents(log.events)
  const ctx = buildRoundContext(round, effective)
  return deriveAwardPot(ctx, gameEventsFor(effective, 'game-1'), {
    gameId: 'game-1',
    stakeCents,
    eligible: (hole) => eligible.includes(hole),
    group: 'Prize',
    eventKind: 'probe/award',
    carryover,
    // the kit hands `units` to every game; this one spends it so the fixtures
    // below can read the multiplier off the line rather than only off the money
    lineLabel: (hole, winner, units) =>
      units > 1 ? `Hole ${hole} — ${winner} ×${units}` : `Hole ${hole} — ${winner}`,
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
      { hole: 2, kind: 'won', winnerId: 'p-b', units: 1 },
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
    expect(pot.holeResults[0]).toEqual({ hole: 2, kind: 'won', winnerId: 'p-d', units: 1 })
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

    expect(pot.holeResults[0]).toEqual({ hole: 2, kind: 'won', winnerId: 'p-a', units: 1 })
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

/**
 * THE CARRY'S HALF OF THE CLASSIFICATION TABLE, stated against the kit for the
 * same reason as the block at the top of this file: the next award game should
 * inherit these answers rather than rediscover them by reading CTP.
 *
 * Three eligible holes on the front 9 — 2, 5 and 8 — with holes 3, 4, 6 and 7
 * ineligible and in between, which is what makes "it only ever carries onto an
 * eligible hole" a real assertion.
 */
const CARRY_ELIGIBLE = [2, 5, 8] as const
const carry = (round: ReturnType<typeof makeRound>, log: EventLog) =>
  potOf(round, log, { carryover: true, eligible: CARRY_ELIGIBLE })

describe('deriveAwardPot — carryover', () => {
  it('rolls an unawarded hole onto the next ELIGIBLE hole, never the next one', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5])
    award(log, 5, 'p-b')
    const pot = carry(round, log)

    // holes 3 and 4 are finalized and ineligible: they are not in the results
    // at all, and they added nothing to the pile
    expect(pot.holeResults).toEqual([
      { hole: 2, kind: 'carried', carryAfter: 1 },
      { hole: 5, kind: 'won', winnerId: 'p-b', units: 2 },
    ])
    expect(pot.settlement.lines.map((l) => l.label)).toEqual(['Hole 5 — B ×2'])
    // 2 × $2 = $4 from each of the other three
    expect(pot.settlement.perPlayerCents).toEqual({
      'p-a': -400,
      'p-b': 1200,
      'p-c': -400,
      'p-d': -400,
    })
    assertZeroSum(pot.settlement)
    // the subtitle counts what the money counts, so a doubled hole reads as 2
    expect(pot.wonByPlayer.get('p-b')).toBe(2)
    expect(pot.carrying).toBe(0)
  })

  /**
   * THE LOOKAHEAD. Hole 8 is the last eligible hole of the walk, so nothing can
   * carry off it — the stake is sitting on hole 8 itself, whose cell is still
   * lit. Saying "carried" here would promise a roll onto a hole that does not
   * exist, which is MAI-38's exact sentence.
   *
   * Skins' gate for this (every hole finalized) is unavailable to an award
   * game: it fires the moment one player picks up, which is the regression the
   * block at the top of this file exists to prevent. Hence a positional
   * question instead.
   */
  it('does not carry off the last eligible hole while the round is live', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (const hole of [2, 5]) award(log, hole, 'p-a')
    const live = carry(round, log)

    expect(live.holeResults[2]).toEqual({ hole: 8, kind: 'pending' })
    expect(live.carrying).toBe(0)
    expect(live.carryDied).toBe(0)
    expect(live.diedAt).toBeUndefined()

    log.append({ type: 'round/completed' })
    const done = carry(round, log)
    expect(done.holeResults[2]).toEqual({ hole: 8, kind: 'carried', carryAfter: 1 })
    expect(done.carryDied).toBe(1)
    expect(done.diedAt).toBe(8)
  })

  /** Dead exactly when it can no longer be claimed — `ctx.completed`, the same
   *  gate as `unclaimed`, and `diedAt` is the eligible hole it was sitting on. */
  it('kills the pile only once the round is over, on the last eligible hole', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const live = carry(round, log)
    expect(live.carrying).toBe(2) // holes 2 and 5; hole 8 has nowhere to go yet
    expect(live.carryDied).toBe(0)

    log.append({ type: 'round/completed' })
    const done = carry(round, log)
    expect(done.carrying).toBe(3)
    expect(done.carryDied).toBe(3)
    expect(done.diedAt).toBe(8)
    // nothing was ever WON, so no line moved — dead money is the engine's to
    // narrate on `notes`, never a $0 row (MAI-40)
    expect(done.settlement.lines).toHaveLength(0)
  })

  /** An eligible hole nobody played leaves no money over, so it must not swell
   *  the pile — the same rule that keeps it out of `unclaimed` (MAI-38). */
  it('never carries a hole nobody played', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3]) // holes 5 and 8 never reached
    log.append({ type: 'round/completed' })
    const pot = carry(round, log)

    expect(pot.holeResults).toEqual([{ hole: 2, kind: 'carried', carryAfter: 1 }])
    expect(pot.carryDied).toBe(1)
    expect(pot.diedAt).toBe(2)
  })

  /** With carryover off nothing carries and every hole pays one unit — the
   *  regression bar for the whole block above. */
  it('carries nothing, and pays single units, when the flag is off', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 5, 'p-b')
    log.append({ type: 'round/completed' })
    const pot = potOf(round, log, { eligible: CARRY_ELIGIBLE })

    expect(pot.holeResults).toEqual([
      { hole: 2, kind: 'unclaimed' },
      { hole: 5, kind: 'won', winnerId: 'p-b', units: 1 },
      { hole: 8, kind: 'unclaimed' },
    ])
    expect(pot.carrying).toBe(0)
    expect(pot.carryDied).toBe(0)
    expect(pot.settlement.perPlayerCents['p-b']).toBe(600)
  })
})

describe('deriveAwardPot — an award outranks a missing score', () => {
  /**
   * These bets are decided ON THE TEE — you tap the grid standing there, before
   * anybody writes a number down (MAI-46). So an eligible hole holding a
   * recorded winner and no score is a hole somebody hit a shot on and never
   * scored, not one the group never reached, and the MAI-38 skip must not
   * swallow it: the grid keeps that cell LIT, so the money has to agree with it.
   */
  it('settles an eligible hole that was awarded but never scored', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1]) // hole 2 is eligible and never scored
    award(log, 2, 'p-b')
    log.append({ type: 'round/completed' })
    const pot = potOf(round, log)

    expect(pot.holeResults[0]).toEqual({ hole: 2, kind: 'won', winnerId: 'p-b', units: 1 })
    expect(pot.settlement.perPlayerCents['p-b']).toBe(600)
    assertZeroSum(pot.settlement)
    // …and the cell the money came from is the one the grid shows lit
    expect(pot.awards(2).filter((c) => c.taken).map((c) => c.playerId)).toEqual(['p-b'])
  })

  /** …and it must not swallow the rule it sits beside: no score AND no award is
   *  still a hole nobody played, absent from the results entirely. */
  it('still skips an eligible hole with neither a score nor an award', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    log.append({ type: 'round/completed' })

    expect(potOf(round, log).holeResults).toEqual([{ hole: 2, kind: 'unclaimed' }])
  })

  /** An award naming a ghost is not evidence of anything — it stays inert
   *  rather than resurrecting a hole nobody played. */
  it('does not treat an award naming a non-player as evidence the hole was played', () => {
    const round = potRound()
    const log = new EventLog()
    scoreHoles(round, log, [1])
    award(log, 2, 'p-nobody')
    log.append({ type: 'round/completed' })

    expect(potOf(round, log).holeResults).toEqual([])
  })
})

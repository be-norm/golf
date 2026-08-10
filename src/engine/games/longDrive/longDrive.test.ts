import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { assertZeroSum } from '../../core/money'
import type { GameConfig } from '../../core/types'
import { EventLog, makeCourse, makePlayers, makeRound } from '../../test/harness'
import { longDriveEngine, type LongDriveConfig, type LongDriveDerivation } from './engine'

/**
 * The harness's default course, front 9: pars 4 4 5 3 4 4 3 5 4.
 * PAR 5s ARE HOLES 3 AND 8 — every fixture below is built on that.
 */
const PAR5 = [3, 8] as const

const FOUR = () => makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])

function ldRound(
  players = FOUR(),
  config: Partial<LongDriveConfig> = {},
  course?: ReturnType<typeof makeCourse>,
) {
  return makeRound({
    players,
    holes: 'front9',
    ...(course && { course }),
    games: [{ type: 'longDrive', config: { stakeCents: 200, holes: 'par5s', ...config } }],
  })
}

function ldOf(round: ReturnType<typeof makeRound>, log: EventLog): LongDriveDerivation {
  const { derivations } = deriveRound(round, log.events)
  return derivations.get(round.games[0]!.gameId) as LongDriveDerivation
}

/** Everyone scores par-ish on the given holes — Long Drive never reads the
 *  numbers, but `finalized`/`anyScored` do, and those are what gate the money. */
function scoreHoles(round: ReturnType<typeof makeRound>, log: EventLog, holes: number[]) {
  const card = Object.fromEntries(round.players.map((p) => [p.name, holes.map(() => 4)]))
  log.scoreByHole(round, card, holes)
}

const award = (log: EventLog, hole: number, playerId: string) =>
  log.append({
    type: 'game/event',
    gameId: 'game-1',
    kind: 'longDrive/award',
    data: { hole, playerId },
  })

describe('longDrive — golden fixtures (hand-verified)', () => {
  /**
   * L1: 4 players, $2 a hole, par 5s, front 9 fully scored.
   * Hole 3 goes to B; hole 8 is never awarded and the card is played out.
   *
   * B collects $2 from each of the other three = +$6; A, C and D pay $2 each.
   * Hole 8 pays NOTHING and says so on `notes` — a $0 settlement line would
   * make `lines.length === 0` (the settle panel's "No money moved." signal)
   * false for a round where exactly one payment happened (MAI-40).
   */
  it('L1: one par 5 claimed, one unclaimed', () => {
    const round = ldRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 3, 'p-b')
    log.append({ type: 'round/completed' })
    const ld = ldOf(round, log)

    expect(ld.settlement.perPlayerCents).toEqual({
      'p-a': -200,
      'p-b': 600,
      'p-c': -200,
      'p-d': -200,
    })
    assertZeroSum(ld.settlement)
    expect(ld.settlement.lines).toHaveLength(1)
    expect(ld.settlement.lines[0]!.label).toBe('Hole 3 — B longest drive')

    expect(ld.designated).toEqual([3, 8])
    expect(ld.holeResults).toEqual([
      { hole: 3, kind: 'won', winnerId: 'p-b' },
      { hole: 8, kind: 'unclaimed' },
    ])
    expect(ld.notes).toEqual([
      'Long drive went unclaimed on hole 8 — nobody was given it, so nothing was paid',
    ])
    expect(ld.standings[0]).toMatchObject({ label: 'B', amountCents: 600, detail: '1 long drive' })
    expect(ld.standings[1]).toMatchObject({ detail: '0 long drives' })
    // the bar recaps the latest DECIDED hole — hole 8, which nobody won
    expect(ld.summaryParts).toEqual([{ label: 'H8', value: 'nobody kept it' }])
    expect(ld.holeSummary(3)).toEqual([
      'B longest drive',
      '↳ $2 from each of 3 other players — $6',
    ])
  })

  /**
   * L2 — the regression that defines the channel (MAI-46). `ctx.finalized` goes
   * true the moment play moves on, so an unawarded hole 3 is "finalized and
   * unawarded" from the 4th tee onwards. Declaring it dead there would put
   * "nobody kept it" on the bar while the group is still on the course and
   * fully intends to record it at the turn.
   */
  it('L2: an unawarded par 5 stays silent while the round is still live', () => {
    const round = ldRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8])
    award(log, 8, 'p-c')
    const ld = ldOf(round, log)

    expect(ld.holeResults).toEqual([
      { hole: 3, kind: 'pending' },
      { hole: 8, kind: 'won', winnerId: 'p-c' },
    ])
    expect(ld.notes).toBeUndefined()

    scoreHoles(round, log, [9])
    log.append({ type: 'round/completed' })
    expect(ldOf(round, log).notes).toHaveLength(1)
  })

  it('L3: holes "all" puts a cell on every hole of the round', () => {
    const round = ldRound(FOUR(), { holes: 'all' })
    const log = new EventLog()
    const ld = ldOf(round, log)

    expect(ld.designated).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (const hole of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(ld.awards!(hole).map((c) => c.label)).toEqual(['A', 'B', 'C', 'D'])
    }
  })

  /**
   * L4: a card with no par 5 at all. The bet can never pay anything, so it says
   * so FROM THE FIRST TEE — deliberately not gated on `ctx.completed` like
   * every other note, because the settle screen is the one moment the group can
   * no longer do anything about it. And it must not also claim anything went
   * "unclaimed": nothing was ever eligible to claim.
   */
  it('L4: a round with no par 5 is inert, and says so before anyone tees off', () => {
    const par34s = makeCourse(
      [4, 4, 4, 3, 4, 4, 3, 4, 4, 4, 4, 3, 4, 4, 4, 3, 4, 4],
      [5, 13, 1, 9, 17, 3, 11, 7, 15, 6, 2, 16, 10, 4, 8, 18, 12, 14],
    )
    const round = ldRound(FOUR(), {}, par34s)

    // before a single score
    const fresh = ldOf(round, new EventLog())
    expect(fresh.designated).toEqual([])
    expect(fresh.notes).toEqual([
      'No par 5s in the holes you are playing — long drive has nothing to play for',
    ])
    expect(fresh.summaryParts).toEqual([{ label: '', value: 'no holes to play for' }])
    for (const hole of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(fresh.awards!(hole)).toEqual([])

    // …and played out, it still says only that — nothing went unclaimed
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    log.append({ type: 'round/completed' })
    const done = ldOf(round, log)
    expect(done.notes).toHaveLength(1)
    expect(done.holeResults).toEqual([])
    expect(Object.values(done.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
  })

  /** Re-tapping a different name is a CORRECTION, not a second award, and undo
   *  CLEARS the hole rather than revealing whoever held it before. */
  it('L5: the last award on a hole wins, and undo clears the hole', () => {
    const round = ldRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const first = award(log, 3, 'p-b')
    const second = award(log, 3, 'p-d')
    log.append({ type: 'round/completed' })

    const lit = ldOf(round, log)
      .awards!(3)
      .find((a) => a.taken)!
    expect(lit.playerId).toBe('p-d')
    expect(lit.undoEventIds).toEqual([first.id, second.id])

    for (const id of lit.undoEventIds!) log.append({ type: 'meta/retract', targetEventId: id })
    const cleared = ldOf(round, log)
    expect(cleared.holeResults[0]).toEqual({ hole: 3, kind: 'unclaimed' })
    expect(cleared.settlement.lines).toHaveLength(0)
  })

  /** An award naming somebody outside the round can only come from a corrupt or
   *  hand-edited log. It must move no money rather than pay a ghost. */
  it('L6: an award naming a non-player is inert', () => {
    const round = ldRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 3, 'p-nobody')
    log.append({ type: 'round/completed' })
    const ld = ldOf(round, log)

    expect(ld.holeResults[0]).toEqual({ hole: 3, kind: 'unclaimed' })
    assertZeroSum(ld.settlement)
    expect(Object.values(ld.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
  })

  /**
   * L7: THE CUSTOM LIST BEATS THE PAR RULE. Holes 1 and 2 are par 4s on this
   * card, and the par 5s (3 and 8) carry nothing — which is the whole point of
   * letting a group nominate holes at the tee.
   */
  it('L7: a nominated list decides the holes, par notwithstanding', () => {
    const round = ldRound(FOUR(), { holes: [1, 2] })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 1, 'p-a')
    award(log, 2, 'p-a')
    log.append({ type: 'round/completed' })
    const ld = ldOf(round, log)

    expect(ld.designated).toEqual([1, 2])
    expect(ld.awards!(1)).toHaveLength(4)
    expect(ld.awards!(2)).toHaveLength(4)
    for (const hole of PAR5) expect(ld.awards!(hole)).toEqual([])

    expect(ld.settlement.perPlayerCents).toEqual({
      'p-a': 1200,
      'p-b': -400,
      'p-c': -400,
      'p-d': -400,
    })
    assertZeroSum(ld.settlement)
  })

  /**
   * L8: a list left over from a longer range — the group picked 12 and 15 on an
   * eighteen, then went back and chose the front nine. Setup does not rewrite
   * the config behind them, so the engine narrows it to nothing and degrades to
   * the inert note rather than settling or throwing.
   */
  it('L8: a nominated list naming holes this round never plays is inert', () => {
    const round = ldRound(FOUR(), { holes: [12, 15] })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    // an award for one of them is in the log too, and must move nothing
    award(log, 12, 'p-a')
    log.append({ type: 'round/completed' })
    const ld = ldOf(round, log)

    expect(ld.designated).toEqual([])
    expect(ld.notes).toEqual([
      'None of the holes you are playing carry the long drive — nothing to play for',
    ])
    expect(ld.holeResults).toEqual([])
    assertZeroSum(ld.settlement)
    expect(Object.values(ld.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
  })

  /** Two players is the minimum roster, and the stake is one-for-one there. */
  it('L9: heads-up, the winner collects a single stake', () => {
    const round = ldRound(makePlayers([{ name: 'A' }, { name: 'B' }]), { stakeCents: 500 })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 3, 'p-a')
    award(log, 8, 'p-a')
    const ld = ldOf(round, log)

    expect(ld.settlement.perPlayerCents).toEqual({ 'p-a': 1000, 'p-b': -1000 })
    expect(ld.holeSummary(3)).toEqual([
      'A longest drive',
      '↳ $5 from each of 1 other player — $5',
    ])
  })
})

describe('longDrive — setup', () => {
  const validate = (config: unknown, players = FOUR()) =>
    longDriveEngine.validateSetup(
      {
        gameId: 'g',
        type: 'longDrive',
        handicap: longDriveEngine.defaultHandicap(),
        config,
      } as GameConfig<LongDriveConfig>,
      players,
      [],
    )

  it('refuses an empty hole list in words the user can act on', () => {
    expect(validate({ stakeCents: 200, holes: [] })).toEqual([
      'Long Drive needs at least one hole',
    ])
  })

  it('accepts both presets and a nominated list', () => {
    expect(validate({ stakeCents: 200, holes: 'par5s' })).toEqual([])
    expect(validate({ stakeCents: 200, holes: 'all' })).toEqual([])
    expect(validate({ stakeCents: 200, holes: [3, 8] })).toEqual([])
  })
})

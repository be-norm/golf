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
    expect(ld.settlement.lines[0]!.label).toBe('Hole 3 — B')

    expect(ld.designated).toEqual([3, 8])
    expect(ld.holeResults).toEqual([
      { hole: 3, kind: 'won', winnerId: 'p-b', units: 1 },
      { hole: 8, kind: 'unclaimed' },
    ])
    expect(ld.notes).toEqual([
      'Unclaimed on hole 8 — nobody was given it, so nothing was paid',
    ])
    expect(ld.standings[0]).toMatchObject({ label: 'B', amountCents: 600, detail: '1 long drive' })
    expect(ld.standings[1]).toMatchObject({ detail: '0 long drives' })
    // the bar recaps the latest DECIDED hole — hole 8, which nobody won
    expect(ld.summaryParts).toEqual([{ label: 'H8', value: 'nobody kept it' }])
    // the block heading already says the game, so the line says who
    expect(ld.holeSummary(3)).toEqual([
      'B longest',
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
      { hole: 8, kind: 'won', winnerId: 'p-c', units: 1 },
    ])
    expect(ld.notes).toBeUndefined()

    scoreHoles(round, log, [9])
    log.append({ type: 'round/completed' })
    expect(ldOf(round, log).notes).toHaveLength(1)
  })

  /**
   * L1b: two unclaimed holes, which is where the ≤4 branch has to say "them".
   * L1 covers the one-hole form; both are prose the settle screen and the
   * PAINTED share card render verbatim.
   */
  it('L1b: two unclaimed holes read as a plural sentence', () => {
    const round = ldRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    log.append({ type: 'round/completed' })

    expect(ldOf(round, log).notes).toEqual([
      'Unclaimed on holes 3, 8 — nobody was given them, so nothing was paid',
    ])
  })

  /**
   * L1c: "every hole" can leave up to eighteen unclaimed, and a fifteen-number
   * sentence wraps over several lines of the share card nobody reads. Past four
   * it counts instead — the one place the note stops naming holes.
   */
  it('L1c: past four unclaimed holes the note counts them', () => {
    const round = ldRound(FOUR(), { holes: 'all' })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    award(log, 4, 'p-a')
    log.append({ type: 'round/completed' })

    expect(ldOf(round, log).notes).toEqual([
      '8 holes went unclaimed — nobody was given them, so nothing was paid',
    ])
    // …and EXACTLY FOUR still name themselves, which is what makes the
    // threshold a threshold rather than a number the test agrees with. Six
    // holes played, two awarded, so 3–6 go unclaimed.
    const four = new EventLog()
    scoreHoles(round, four, [1, 2, 3, 4, 5, 6])
    for (const h of [1, 2]) award(four, h, 'p-a')
    four.append({ type: 'round/completed' })
    expect(ldOf(round, four).notes).toEqual([
      'Unclaimed on holes 3, 4, 5, 6 — nobody was given them, so nothing was paid',
    ])
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
      'No par 5s in the holes you are playing — nothing to play for',
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
      'None of the holes you are playing carry this bet — nothing to play for',
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
      'A longest',
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

/**
 * FULL 18 pars: 4 4 5 3 4 4 3 5 4 · 4 5 3 4 4 5 3 4 4.
 * PAR 5s ARE 3, 8, 11 AND 15 — four designated holes, separated by four, two
 * and three holes this bet does not run on.
 */
describe('longDrive — carryovers', () => {
  const carryRound = (config: Partial<LongDriveConfig> = {}) =>
    makeRound({
      players: FOUR(),
      holes: 'full18',
      games: [
        { type: 'longDrive', config: { stakeCents: 200, holes: 'par5s', carryover: true, ...config } },
      ],
    })

  /**
   * LC1 — the point of the feature, in Long Drive's own words. Nobody keeps
   * hole 3, so its $2 rolls onto hole 8 and C wins a double: 2 × $2 = $4 from
   * each of the other three, +$12. Holes 4–7 are par 3/4/4/3 — no part of this
   * bet, and they contribute nothing.
   */
  it('LC1: an unclaimed par 5 doubles the next one, and the holes between do nothing', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8])
    award(log, 8, 'p-c')
    const ld = ldOf(round, log)

    expect(ld.holeResults).toEqual([
      { hole: 3, kind: 'carried', carryAfter: 1 },
      { hole: 8, kind: 'won', winnerId: 'p-c', units: 2 },
    ])
    expect(ld.settlement.perPlayerCents).toEqual({
      'p-a': -400,
      'p-b': -400,
      'p-c': 1200,
      'p-d': -400,
    })
    assertZeroSum(ld.settlement)
    expect(ld.settlement.lines).toHaveLength(1)
    expect(ld.settlement.lines[0]!.label).toBe('Hole 8 — C (2 long drives)')
    expect(ld.holeSummary(3)).toEqual([
      'Nobody kept it — 1 carried',
      '↳ it rolls onto the next designated hole — the holes in between do not count',
    ])
    expect(ld.holeSummary(8)).toEqual([
      'C longest — 2 long drives',
      '↳ this designated hole + 1 carried in',
      '↳ $4 from each of 3 other players — $12',
    ])
    expect(ld.summaryParts).toEqual([{ label: 'H8', value: 'C longest · 2 long drives' }])
    expect(ld.standings[0]).toMatchObject({ label: 'C', detail: '2 long drives' })
  })

  /**
   * LC2 — THE LAST DESIGNATED HOLE HAS NOWHERE TO CARRY. Hole 15 is the last
   * par 5; once play reaches 16 it is finalized, but nothing has rolled
   * anywhere and the money is still claimable on 15 itself. `pending` until the
   * round ends — see the kit's `carryover` note and MAI-38.
   */
  it('LC2: the last par 5 never reads as carried while the round is live', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, Array.from({ length: 16 }, (_, i) => i + 1))
    for (const hole of [3, 8, 11]) award(log, hole, 'p-a')
    const live = ldOf(round, log)

    expect(live.holeResults[3]).toEqual({ hole: 15, kind: 'pending' })
    expect(live.carrying).toBe(0)
    expect(live.openBet).toBeUndefined()
    expect(live.notes).toBeUndefined()

    log.append({ type: 'round/completed' })
    const done = ldOf(round, log)
    expect(done.holeResults[3]).toEqual({ hole: 15, kind: 'carried', carryAfter: 1 })
    expect(done.notes).toEqual(['1 long drive died unwon — no designated hole left to win it'])
  })

  /** LC3: nobody keeps any of the four, so the whole pile dies on hole 15 —
   *  the last designated hole, not hole 18. */
  it('LC3: an unclaimed last par 5 kills the pile, on the last designated row', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, Array.from({ length: 18 }, (_, i) => i + 1))

    // the bar prices THE HOLE, not the pile carried into it: 4 × $2 = $8 from
    // each of the other three, $24 to whoever wins hole 15
    const live = ldOf(round, log)
    expect(live.carrying).toBe(3)
    expect(live.openBet).toBe('4 long drives riding · $24')

    log.append({ type: 'round/completed' })
    const ld = ldOf(round, log)

    expect(ld.holeResults).toEqual([
      { hole: 3, kind: 'carried', carryAfter: 1 },
      { hole: 8, kind: 'carried', carryAfter: 2 },
      { hole: 11, kind: 'carried', carryAfter: 3 },
      { hole: 15, kind: 'carried', carryAfter: 4 },
    ])
    expect(ld.carryDied).toBe(4)
    expect(ld.settlement.lines).toHaveLength(0)
    expect(ld.notes).toEqual([
      '4 long drives died unwon — no designated hole left to win them',
    ])
    expect(ld.holeSummary(15)).toEqual([
      'Nobody kept it',
      '↳ 4 long drives died unwon — no designated hole left to win them',
    ])
    expect(ld.holeSummary(18)).toEqual([])
    expect(ld.openBet).toBeUndefined()
  })

  /**
   * LC4 — `holes: 'all'` IS THE DEGENERATE END OF THE SAME RULE: every hole is
   * designated, so "the next designated hole" is simply the next hole, and the
   * pile rolls one at a time. Nothing about the mechanic is special-cased for
   * it, which is the thing worth pinning.
   */
  it('LC4: every hole designated makes the carry roll hole to hole', () => {
    const round = carryRound({ holes: 'all' })
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4])
    award(log, 4, 'p-d')
    const ld = ldOf(round, log)

    expect(ld.holeResults).toEqual([
      { hole: 1, kind: 'carried', carryAfter: 1 },
      { hole: 2, kind: 'carried', carryAfter: 2 },
      { hole: 3, kind: 'carried', carryAfter: 3 },
      { hole: 4, kind: 'won', winnerId: 'p-d', units: 4 },
    ])
    // 4 × $2 = $8 from each of the other three = +$24
    expect(ld.settlement.perPlayerCents).toEqual({
      'p-a': -800,
      'p-b': -800,
      'p-c': -800,
      'p-d': 2400,
    })
    assertZeroSum(ld.settlement)
  })

  /** LC5b: the bar's quote is the money that gets paid — see CTP's C10. The
   *  pile alone understates the hole by exactly one unit. */
  it('LC5b: the open bet quotes what the next par 5 actually pays', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, Array.from({ length: 15 }, (_, i) => i + 1))
    award(log, 3, 'p-a') // banked, so exactly two carry into hole 15
    const live = ldOf(round, log)
    expect(live.carrying).toBe(2)

    const before = live.settlement.perPlayerCents['p-b']!
    award(log, 15, 'p-b')
    const after = ldOf(round, log).settlement.perPlayerCents['p-b']!

    expect(after - before).toBe(3 * 200 * 3) // 3 units × $2 × 3 others = $18
    expect(live.openBet).toBe('3 long drives riding · $18')
  })

  /** LC6: an award outranks a missing score — these bets are decided on the
   *  tee, so a designated hole with a recorded winner and no score is one
   *  somebody played and never scored. See CTP's C11. */
  it('LC6: a par 5 awarded but never scored still pays, and banks the carry', () => {
    const round = carryRound()
    const log = new EventLog()
    scoreHoles(round, log, Array.from({ length: 14 }, (_, i) => i + 1))
    award(log, 15, 'p-b') // tapped on the tee; nobody ever posts a score on 15
    log.append({ type: 'round/completed' })
    const ld = ldOf(round, log)

    expect(ld.awards!(15).filter((a) => a.taken).map((a) => a.playerId)).toEqual(['p-b'])
    expect(ld.holeResults[3]).toEqual({ hole: 15, kind: 'won', winnerId: 'p-b', units: 4 })
    expect(ld.settlement.perPlayerCents['p-b']).toBe(2400)
    assertZeroSum(ld.settlement)
    expect(ld.carryDied).toBe(0)
  })

  /** LC5: a legacy config with no `carryover` key still derives and does not
   *  carry — `deriveRound` makes a config its engine rejects INERT, so a
   *  required key would have emptied every stored Long Drive round. */
  it('LC5: a legacy config with no carryover key still plays, and does not carry', () => {
    const round = ldRound(FOUR(), {}) // `{ stakeCents, holes }` — no carryover key
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8])
    award(log, 8, 'p-c')
    const ld = ldOf(round, log)

    expect(ld.holeResults).toEqual([
      { hole: 3, kind: 'pending' },
      { hole: 8, kind: 'won', winnerId: 'p-c', units: 1 },
    ])
    expect(ld.settlement.perPlayerCents['p-c']).toBe(600)
  })
})

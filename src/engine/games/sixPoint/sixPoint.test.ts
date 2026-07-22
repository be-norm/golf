import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { assertZeroSum } from '../../core/money'
import { EventLog, makeCourse, makePlayers, makeRound } from '../../test/harness'
import { sixPointEngine, type SixPointDerivation } from './engine'
import type { GameConfig } from '../../core/types'

function sixPointOf(round: ReturnType<typeof makeRound>, log: EventLog): SixPointDerivation {
  const { derivations } = deriveRound(round, log.events)
  return derivations.get(round.games[0]!.gameId) as SixPointDerivation
}

describe('six point — golden fixtures (hand-verified)', () => {
  /**
   * SP1: 3 players, GROSS, $1/point, front 9. Exercises all four splits.
   *   H1 A3 B4 C5 → distinct        → A4 B2 C0
   *   H2 A4 B4 C5 → A&B tie low      → A3 B3 C0
   *   H3 A4 B5 C5 → B&C tie (worst)  → A4 B1 C1
   *   H4 A5 B5 C5 → three-way tie    → A2 B2 C2  (no money)
   *   H5 A6 B5 C4 → distinct, C low  → A0 B2 C4
   *   H6 A4 B5 C6 → distinct, A low  → A4 B2 C0
   *   H7 A5 B4 C4 → B&C tie low      → A0 B3 C3
   *   H8 A4 B4 C6 → A&B tie low      → A3 B3 C0
   *   H9 A6 B6 C5 → C low, A&B worst → A1 B1 C4
   * Points: A 21, B 19, C 14 (sum 54 = 6×9).
   * Money (pts − 18)×$1: A +$3, B +$1, C −$4.
   */
  it('SP1: gross, all four split shapes', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'sixPoint', config: { pointCents: 100 } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [3, 4, 4, 5, 6, 4, 5, 4, 6],
      B: [4, 4, 5, 5, 5, 5, 4, 4, 6],
      C: [5, 5, 5, 5, 4, 6, 4, 6, 5],
    })
    const sp = sixPointOf(round, log)

    assertZeroSum(sp.settlement)
    expect(sp.settlement.perPlayerCents).toEqual({ 'p-a': 300, 'p-b': 100, 'p-c': -400 })
    expect(sp.holeResults.map((r) => (r.kind === 'scored' ? r.split : r.kind))).toEqual([
      '4-2-0',
      '3-3-0',
      '4-1-1',
      '2-2-2',
      '4-2-0',
      '4-2-0',
      '3-3-0',
      '3-3-0',
      '4-1-1',
    ])
    expect(sp.standings.map((s) => [s.label, s.detail, s.amountCents])).toEqual([
      ['A', '21 pts', 300],
      ['B', '19 pts', 100],
      ['C', '14 pts', -400],
    ])
    // three-way tie moves no money, so it never books a settlement line
    expect(sp.settlement.lines).toHaveLength(8)
    // settle-screen labels name who won what, not just the abstract split shape
    expect(sp.settlement.lines[0]!.label).toBe('Hole 1 — A 4 · B 2 · C 0')
    expect(sp.settlement.lines[7]!.label).toBe('Hole 9 — C 4 · A 1 · B 1')
    // bar recaps the latest decided hole (H9: C 4, then A/B tied worst)
    expect(sp.summaryParts).toEqual([{ label: 'H9', value: 'C 4 · A 1 · B 1' }])
  })

  it('SP1 ledger explains the split on each hole', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'sixPoint', config: { pointCents: 100 } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [3, 4, 4, 5, 6, 4, 5, 4, 6],
      B: [4, 4, 5, 5, 5, 5, 4, 4, 6],
      C: [5, 5, 5, 5, 4, 6, 4, 6, 5],
    })
    const sp = sixPointOf(round, log)

    expect(sp.holeSummary(1)).toEqual(['A 4 · B 2 · C 0', '↳ scores 3 · 4 · 5'])
    expect(sp.holeSummary(2)).toEqual(['A 3 · B 3 · C 0', '↳ A & B tied for low (4) — top two split 3-3'])
    expect(sp.holeSummary(3)).toEqual(['A 4 · B 1 · C 1', '↳ B & C tied (5) — bottom two split 1-1'])
    expect(sp.holeSummary(4)).toEqual(['A 2 · B 2 · C 2', '↳ three-way tie (5) — 6 points split evenly'])
  })

  /**
   * SP2: NET off-low proves handicap strokes reshape the ranking.
   * Course SIs 1..9 in order; CH Ben 0 / Alice 1 / Carol 2 → off low 0/1/2.
   * Alice gets a stroke on h1 (SI-rank 1); Carol on h1 and h2.
   *   H1 gross Ben4 Alice5 Carol6 → net 4 / 4 / 5 → Ben&Alice tie low → Ben3 Alice3 Carol0
   *   H2 gross Ben4 Alice5 Carol5 → net 4 / 5 / 4 → Ben&Carol tie low → Ben3 Carol3 Alice0
   * Points Ben 6, Alice 3, Carol 3. Money (pts−4)×$1: Ben +$2, Alice −$1, Carol −$1.
   */
  it('SP2: net off-low strokes change who wins the points', () => {
    const course = makeCourse([4, 4, 4, 4, 4, 4, 4, 4, 4], [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const players = makePlayers([
      { name: 'Ben', ch: 0 },
      { name: 'Alice', ch: 1 },
      { name: 'Carol', ch: 2 },
    ])
    const round = makeRound({
      course,
      players,
      holes: 'front9',
      games: [
        {
          type: 'sixPoint',
          config: { pointCents: 100 },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, { Ben: [4, 4], Alice: [5, 5], Carol: [6, 5] }, [1, 2])
    const sp = sixPointOf(round, log)

    assertZeroSum(sp.settlement)
    expect(sp.settlement.perPlayerCents).toEqual({ 'p-ben': 200, 'p-alice': -100, 'p-carol': -100 })
    expect(sp.holeResults.slice(0, 2).map((r) => (r.kind === 'scored' ? r.split : r.kind))).toEqual([
      '3-3-0',
      '3-3-0',
    ])
    // net scores drive the ledger explanation
    // tie names order by score then alphabetically → Alice before Ben
    expect(sp.holeSummary(1)[1]).toBe('↳ Alice & Ben tied for low (net 4) — top two split 3-3')
  })

  /**
   * A finalized hole missing any of the three scores is void — six points can't
   * be split three ways with only two scores.
   */
  it('a finalized hole missing a score is void', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'sixPoint', config: { pointCents: 100 } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [3], B: [4], C: [5] }, [1])
    log.scoreByHole(round, { A: [4], B: [5] }, [2]) // C misses h2
    log.scoreByHole(round, { A: [4], B: [5], C: [6] }, [3])
    const sp = sixPointOf(round, log)

    expect(sp.holeResults.slice(0, 3).map((r) => r.kind)).toEqual(['scored', 'void', 'scored'])
    expect(sp.settlement.perPlayerCents).toEqual({ 'p-a': 400, 'p-b': 0, 'p-c': -400 })
    expect(sp.holeSummary(2)).toEqual(['Missing scores — hole void'])
  })

  /**
   * `derive` is total and runs on whatever roster the round carries; setup
   * validation is the only gate on player count. A roster that isn't exactly
   * three voids every hole — the money math assumes 3 (2 = 6/3), so this keeps
   * the settlement structurally zero-sum instead of producing junk / NaN.
   */
  it('a roster that is not exactly three voids every hole (zero-sum holds)', () => {
    for (const names of [
      [{ name: 'A' }, { name: 'B' }],
      [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
    ]) {
      const players = makePlayers(names)
      const round = makeRound({
        players,
        holes: 'front9',
        games: [{ type: 'sixPoint', config: { pointCents: 100 } }],
      })
      const log = new EventLog()
      log.scoreByHole(
        round,
        Object.fromEntries(names.map((n, i) => [n.name, [3 + i, 4 + i, 5 + i]])),
        [1, 2, 3],
      )
      const sp = sixPointOf(round, log)

      assertZeroSum(sp.settlement)
      expect(sp.holeResults.every((r) => r.kind === 'void' || r.kind === 'pending')).toBe(true)
      expect(Object.values(sp.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
    }
  })

  /** Corrections + retraction replay exactly (event-sourcing invariant). */
  it('mid-round correction and retraction replay correctly', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'sixPoint', config: { pointCents: 100 } }],
    })
    const log = new EventLog()
    // H1 A3 B4 C5 → A4 B2 C0; H2 all 4 → 2-2-2 (finalizes H1)
    log.scoreByHole(round, { A: [3, 4], B: [4, 4], C: [5, 4] }, [1, 2])
    expect(sixPointOf(round, log).settlement.perPlayerCents).toEqual({
      'p-a': 200,
      'p-b': 0,
      'p-c': -200,
    })

    // Correct A's H1 to 5 → A5 B4 C5 → B4 A1 C1
    const correction = log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 5 })
    expect(sixPointOf(round, log).settlement.perPlayerCents).toEqual({
      'p-a': -100,
      'p-b': 200,
      'p-c': -100,
    })

    log.append({ type: 'meta/retract', targetEventId: correction.id })
    expect(sixPointOf(round, log).settlement.perPlayerCents).toEqual({
      'p-a': 200,
      'p-b': 0,
      'p-c': -200,
    })
  })

  it('the frontier hole with partial scores stays pending — no premature points', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'sixPoint', config: { pointCents: 100 } }],
    })
    const log = new EventLog()
    log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    log.append({ type: 'score/set', playerId: 'p-b', hole: 1, gross: 5 })

    const sp = sixPointOf(round, log)
    expect(sp.holeResults[0]).toEqual({ hole: 1, kind: 'pending' })
    expect(sp.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0, 'p-c': 0 })
    expect(sp.summaryParts).toEqual([{ label: '', value: 'no points yet' }])
  })

  it('validateSetup enforces exactly three players', () => {
    const cfg: GameConfig<{ pointCents: number }> = {
      gameId: 'game-1',
      type: 'sixPoint',
      handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
      config: { pointCents: 100 },
    }
    expect(sixPointEngine.validateSetup(cfg, makePlayers([{ name: 'A' }, { name: 'B' }]))).toEqual([
      'Six Point is a threesome game — exactly 3 players',
    ])
    expect(
      sixPointEngine.validateSetup(
        cfg,
        makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
      ),
    ).toEqual(['Six Point is a threesome game — exactly 3 players'])
    expect(
      sixPointEngine.validateSetup(cfg, makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])),
    ).toEqual([])
  })
})

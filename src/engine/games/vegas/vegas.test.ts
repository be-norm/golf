import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { EventLog, makeCourse, makePlayers, makeRound } from '../../test/harness'
import { pairFlipped, pairNormal } from './engine'

describe('vegas pairing rules', () => {
  it('pairs low digit first', () => {
    expect(pairNormal(4, 5)).toBe(45)
    expect(pairNormal(5, 4)).toBe(45)
  })
  it('10+ leads in normal pairing (soften)', () => {
    expect(pairNormal(4, 10)).toBe(104)
    expect(pairNormal(12, 4)).toBe(124)
  })
  it('flip reverses: high first, 10+ trails (punitive)', () => {
    expect(pairFlipped(4, 7)).toBe(74)
    expect(pairFlipped(4, 10)).toBe(410)
  })
})

describe('vegas — golden fixture (hand-verified)', () => {
  /**
   * Gross vegas, 10¢/pt, front 9 (pars 4,4,5,3,4,4,3,5,4), {A,B} vs {C,D}.
   * h1: 45 v 46 → AB +1 · h2: A birdie 3: 35 v 45→54 → AB +19
   * h3: B makes 10: 105 v 67 → CD +38 · h4: both sides birdie, no flips: 23 v 24 → AB +1
   * h5: A birdie: 34 v 55 (flip is identity on doubles) → AB +21
   * h6: A eagle 2: 26 v 44 ×2 → AB +36 · h7: 33 v 33 push
   * h8: AB both birdie 44; C eagle 35; flips cancel, eagle ×2 → CD +18
   * h9: 45 v 45 push.
   * Totals: AB 78, CD 56 → AB +22 pts → A,B +220¢ · C,D −220¢.
   */
  it('flips, eagle doubles, and double-digit rule', () => {
    const course = makeCourse([4, 4, 5, 3, 4, 4, 3, 5, 4], [5, 13, 1, 9, 17, 3, 11, 7, 15])
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      course,
      players,
      holes: 'front9',
      games: [
        {
          type: 'vegas',
          config: {
            pointCents: 10,
            teams: { a: ['p-a', 'p-b'], b: ['p-c', 'p-d'] },
            birdieFlip: true,
            eagleDouble: true,
          },
        },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [4, 3, 5, 2, 3, 2, 3, 4, 4],
      B: [5, 5, 10, 3, 4, 6, 3, 4, 5],
      C: [4, 4, 6, 2, 5, 4, 3, 3, 4],
      D: [6, 5, 7, 4, 5, 4, 3, 5, 5],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents).toEqual({
      'p-a': 220,
      'p-b': 220,
      'p-c': -220,
      'p-d': -220,
    })
    expect(d.holeSummary(2)[0]).toContain('flipped')
    expect(d.holeSummary(6)[0]).toContain('×2')
    expect(d.holeSummary(7)[0]).toContain('push')
  })

  it('net vegas applies strokes before pairing but flips on gross birdies only', () => {
    const course = makeCourse([4, 4, 5, 3, 4, 4, 3, 5, 4], [5, 13, 1, 9, 17, 3, 11, 7, 15])
    const players = makePlayers([
      { name: 'A', ch: 0 },
      { name: 'B', ch: 9 },
      { name: 'C', ch: 0 },
      { name: 'D', ch: 0 },
    ])
    const round = makeRound({
      course,
      players,
      holes: 'front9',
      games: [
        {
          type: 'vegas',
          config: {
            pointCents: 10,
            teams: { a: ['p-a', 'p-b'], b: ['p-c', 'p-d'] },
            birdieFlip: true,
            eagleDouble: true,
          },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    const log = new EventLog()
    // Hole 1 only: B gets a stroke everywhere (9 over 9 holes).
    // A 4, B 5 (net 4) → 44; C 4, D 5 → 45 → AB win 1 pt.
    // B's net birdie (net 3 would be) — here net par — must NOT flip.
    log.scoreByHole(round, { A: [4], B: [5], C: [4], D: [5] }, [1])
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents).toEqual({
      'p-a': 10,
      'p-b': 10,
      'p-c': -10,
      'p-d': -10,
    })
    expect(d.holeSummary(1)[0]).not.toContain('flipped')
  })
})

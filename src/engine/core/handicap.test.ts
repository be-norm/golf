import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { allocateStrokes, applyAllowance, courseHandicap, rankStrokeIndexes } from './handicap'

describe('courseHandicap (WHS)', () => {
  it('matches the WHS formula', () => {
    // 10.4 index, slope 125, rating 71.2, par 72 → 10.4×(125/113) + (71.2−72) = 10.70 → 11
    expect(courseHandicap(10.4, 125, 71.2, 72)).toBe(11)
    // plus handicap
    expect(courseHandicap(-2.0, 113, 72.0, 72)).toBe(-2)
  })
})

describe('applyAllowance', () => {
  it('rounds to nearest', () => {
    expect(applyAllowance(9, 100)).toBe(9)
    expect(applyAllowance(9, 90)).toBe(8) // 8.1 → 8
    expect(applyAllowance(13, 50)).toBe(7) // 6.5 → 7 (round half up)
  })
})

describe('rankStrokeIndexes', () => {
  it('re-ranks a 9-hole subset densely', () => {
    expect(rankStrokeIndexes([5, 13, 1, 9, 17, 3, 11, 7, 15])).toEqual([3, 7, 1, 5, 9, 2, 6, 4, 8])
  })
})

describe('allocateStrokes', () => {
  const si18 = [5, 13, 1, 9, 17, 3, 11, 7, 15, 6, 2, 16, 10, 4, 8, 18, 12, 14]

  it('gives one stroke on the N hardest holes for CH ≤ 18', () => {
    const strokes = allocateStrokes(3, si18)
    // hardest three: SI 1 (hole 3), SI 2 (hole 11), SI 3 (hole 6)
    expect(strokes[2]).toBe(1)
    expect(strokes[10]).toBe(1)
    expect(strokes[5]).toBe(1)
    expect(strokes.reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('wraps past 18: CH 20 → 2 strokes on SI 1–2, 1 elsewhere', () => {
    const strokes = allocateStrokes(20, si18)
    expect(strokes[2]).toBe(2) // SI 1
    expect(strokes[10]).toBe(2) // SI 2
    expect(strokes.filter((s) => s === 1)).toHaveLength(16)
  })

  it('plus handicaps give back strokes on the easiest holes', () => {
    const strokes = allocateStrokes(-2, si18)
    expect(strokes[15]).toBe(-1) // SI 18
    expect(strokes[4]).toBe(-1) // SI 17
    expect(strokes.reduce((a, b) => a + b, 0)).toBe(-2)
  })

  it('property: sum of allocated strokes always equals the playing handicap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 45 }),
        fc.constantFrom(9, 18),
        fc.gen(),
        (ph, n, g) => {
          // random permutation of 1..n as stroke indexes
          const sis = Array.from({ length: n }, (_, i) => i + 1)
          for (let i = sis.length - 1; i > 0; i--) {
            const j = g(fc.integer, { min: 0, max: i })
            ;[sis[i], sis[j]] = [sis[j]!, sis[i]!]
          }
          const strokes = allocateStrokes(ph, sis)
          expect(strokes.reduce((a, b) => a + b, 0)).toBe(ph)
          // every hole gets base or base±1 — max spread of 1
          expect(Math.max(...strokes) - Math.min(...strokes)).toBeLessThanOrEqual(1)
        },
      ),
    )
  })
})

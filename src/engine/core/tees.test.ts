import { describe, expect, it } from 'vitest'
import type { Course, TeeSet } from './types'
import {
  applyTee,
  doubleNine,
  isStrokeIndexPermutation,
  looksLikeEighteenHoleRating,
  teePar,
} from './tees'

// 4-hole fixture (holeCount is unused by these pure helpers). Hole 2 is the
// "4/3" case: par 4 by default, par 3 from a forward tee.
const base: Course = {
  id: 'c',
  name: 'Test',
  holeCount: 18,
  holes: [
    { number: 1, par: 4, strokeIndex: 1 },
    { number: 2, par: 4, strokeIndex: 2 },
    { number: 3, par: 3, strokeIndex: 3 },
    { number: 4, par: 5, strokeIndex: 4 },
  ],
  teeSets: [],
  source: 'user',
  updatedAt: '',
  revision: 0,
}
const tee = (patch: Partial<TeeSet>): TeeSet => ({ id: 't', name: 'Blue', rating: 71, slope: 125, ...patch })

describe('isStrokeIndexPermutation', () => {
  it('accepts a 1..n permutation and rejects dups / gaps / out-of-range', () => {
    expect(isStrokeIndexPermutation([1, 2, 3, 4])).toBe(true)
    expect(isStrokeIndexPermutation([4, 3, 2, 1])).toBe(true)
    expect(isStrokeIndexPermutation([1, 1, 2, 4])).toBe(false) // dup + gap
    expect(isStrokeIndexPermutation([0, 1, 2, 3])).toBe(false) // out of range
    expect(isStrokeIndexPermutation([1, 2, 3, 5])).toBe(false) // gap
  })
})

describe('applyTee', () => {
  it('overlays the tee’s own stroke index and par (incl. a 4/3 hole)', () => {
    const out = applyTee(base, tee({ strokeIndexes: [4, 3, 2, 1], pars: [4, 3, 3, 5] }))
    expect(out.holes.map((h) => h.strokeIndex)).toEqual([4, 3, 2, 1])
    expect(out.holes.map((h) => h.par)).toEqual([4, 3, 3, 5]) // hole 2 now par 3
  })

  it('falls back to course-wide values where the tee has no row', () => {
    const out = applyTee(base, tee({ pars: [4, 3, 3, 5] })) // no strokeIndexes
    expect(out.holes.map((h) => h.strokeIndex)).toEqual([1, 2, 3, 4]) // unchanged
    expect(out.holes.map((h) => h.par)).toEqual([4, 3, 3, 5])
  })

  it('ignores an invalid (non-permutation) stroke-index row but still applies par', () => {
    const out = applyTee(base, tee({ strokeIndexes: [1, 1, 2, 3], pars: [4, 3, 3, 5] }))
    expect(out.holes.map((h) => h.strokeIndex)).toEqual([1, 2, 3, 4]) // kept course-wide
    expect(out.holes.map((h) => h.par)).toEqual([4, 3, 3, 5])
  })

  it('ignores arrays whose length does not match the holes', () => {
    const out = applyTee(base, tee({ strokeIndexes: [1, 2, 3], pars: [4, 4, 4] }))
    expect(out).toBe(base) // nothing to apply → same reference
  })

  it('returns the course unchanged for an undefined tee or a tee with no rows', () => {
    expect(applyTee(base, undefined)).toBe(base)
    expect(applyTee(base, tee({}))).toBe(base)
  })
})

describe('doubleNine', () => {
  // Penmar-shaped nine: par 33, a 9-hole rating, its own SI row on one tee.
  const pars = [4, 4, 3, 4, 3, 4, 4, 4, 3] // 33
  const sis = [6, 2, 8, 4, 9, 1, 5, 3, 7] // 1..9, deliberately not in hole order
  const nine: Course = {
    ...base,
    holeCount: 9,
    holes: pars.map((par, i) => ({ number: i + 1, par, strokeIndex: sis[i]! })),
    teeSets: [
      tee({
        rating: 33.4,
        slope: 103,
        strokeIndexes: sis,
        pars,
        yardages: [281, 355, 139, 298, 150, 320, 300, 340, 120],
      }),
    ],
  }

  it('mirrors the nine into an 18-hole course', () => {
    const out = doubleNine(nine)
    expect(out.holeCount).toBe(18)
    expect(out.holes.map((h) => h.number)).toEqual([...Array(18)].map((_, i) => i + 1))
    // second loop plays the same holes: par 33 + 33 = 66
    expect(out.holes.map((h) => h.par).slice(9)).toEqual(nine.holes.map((h) => h.par))
    expect(teePar(out, out.teeSets[0])).toBe(66)
  })

  it('splits each 9-hole stroke index into 2s−1 (first loop) / 2s (second)', () => {
    const out = doubleNine(nine)
    const sis = out.holes.map((h) => h.strokeIndex)
    expect(isStrokeIndexPermutation(sis)).toBe(true)
    // hole 6 is the nine's SI 1 → SI 1 first time around, SI 2 second time
    expect(sis[5]).toBe(1)
    expect(sis[14]).toBe(2)
    // first loop takes every odd index, second every even one
    expect(sis.slice(0, 9).every((si) => si % 2 === 1)).toBe(true)
    expect(sis.slice(9).every((si) => si % 2 === 0)).toBe(true)
    // and the tee's own row gets the same treatment, so applyTee still accepts it
    expect(isStrokeIndexPermutation(out.teeSets[0]!.strokeIndexes!)).toBe(true)
    expect(applyTee(out, out.teeSets[0]).holes.map((h) => h.strokeIndex)).toEqual(sis)
  })

  it('doubles the tee rating (an 18-hole rating is two loops) but not the slope', () => {
    const out = doubleNine(nine)
    expect(out.teeSets[0]!.rating).toBe(66.8)
    expect(out.teeSets[0]!.slope).toBe(103)
    expect(out.teeSets[0]!.yardages).toHaveLength(18)
    expect(out.teeSets[0]!.pars).toHaveLength(18)
    expect(out.teeSets[0]!.id).toBe(nine.teeSets[0]!.id) // tee ids survive → still selectable
  })

  it('records which hole each card number physically is', () => {
    const out = doubleNine(nine)
    // card 14 is the 5th hole, second time round — what the scorecard shows
    expect(out.holes[13]!.loop).toEqual({ hole: 5, nth: 2 })
    expect(out.holes[4]!.loop).toEqual({ hole: 5, nth: 1 })
    expect(out.holes.every((h) => h.loop!.hole === ((h.number - 1) % 9) + 1)).toBe(true)
  })

  it('leaves an 18-hole course alone', () => {
    expect(doubleNine(base)).toBe(base)
    expect(base.holes.every((h) => h.loop === undefined)).toBe(true)
  })
})

describe('looksLikeEighteenHoleRating', () => {
  const nine = { ...base, holeCount: 9 as const } // par 16 over its 4 holes
  it('flags a rating ~10+ over the nine’s own par', () => {
    expect(looksLikeEighteenHoleRating(nine, tee({ rating: 63.4 }))).toBe(true)
    expect(looksLikeEighteenHoleRating(nine, tee({ rating: 18 }))).toBe(false) // plausible
  })
  it('never flags an 18-hole course', () => {
    expect(looksLikeEighteenHoleRating(base, tee({ rating: 71.2 }))).toBe(false)
  })
})

describe('teePar', () => {
  it('sums the tee’s pars where present, else course-wide', () => {
    expect(teePar(base, tee({ pars: [4, 3, 3, 5] }))).toBe(15)
    expect(teePar(base, tee({}))).toBe(16) // 4+4+3+5
    expect(teePar(base, undefined)).toBe(16)
  })
})

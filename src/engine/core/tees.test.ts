import { describe, expect, it } from 'vitest'
import type { Course, TeeSet } from './types'
import { applyTee, isStrokeIndexPermutation, teePar } from './tees'

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

describe('teePar', () => {
  it('sums the tee’s pars where present, else course-wide', () => {
    expect(teePar(base, tee({ pars: [4, 3, 3, 5] }))).toBe(15)
    expect(teePar(base, tee({}))).toBe(16) // 4+4+3+5
    expect(teePar(base, undefined)).toBe(16)
  })
})

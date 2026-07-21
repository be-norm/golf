import { describe, expect, it } from 'vitest'
import { buildRemoteCourse, usableHoleRows } from './transform'

describe('usableHoleRows', () => {
  it('drops junk trailing rows using the declared count (Penmar: 11 rows, holes=9)', () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ number: i + 1, par: 4 }))
    expect(usableHoleRows(rows, 9).map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
  it('keeps a clean 18 untouched', () => {
    const rows = Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4 }))
    expect(usableHoleRows(rows, 18)).toHaveLength(18)
  })
  it('dedupes duplicate hole numbers', () => {
    const rows = [{ number: 1 }, { number: 1 }, { number: 2 }]
    expect(usableHoleRows(rows, 9).map((r) => r.number)).toEqual([1, 2])
  })
  it('with no usable count, only dedupes by number (keeps out-of-range)', () => {
    const rows = [{ number: 1 }, { number: 2 }, { number: 10 }]
    expect(usableHoleRows(rows).map((r) => r.number)).toEqual([1, 2, 10])
  })
})

const holes = [
  { number: 1, par: 4, handicapIndex: 1 },
  { number: 2, par: 4, handicapIndex: 2 },
  { number: 3, par: 3, handicapIndex: 3 },
  { number: 4, par: 5, handicapIndex: 4 },
]

describe('buildRemoteCourse per-tee stroke index / par', () => {
  it('keeps a complete per-tee row, re-ranking SI into a clean permutation', () => {
    const course = buildRemoteCourse({
      id: 'x',
      name: 'T',
      holes,
      // raw SI uses arbitrary 18-hole indexes (7,3,17,13) → re-ranked to 1..4 by value
      tees: [{ name: 'Gold', strokeIndexes: [7, 3, 17, 13], pars: [4, 3, 3, 5] }],
    })
    expect(course.teeSets[0]!.strokeIndexes).toEqual([2, 1, 4, 3])
    expect(course.teeSets[0]!.pars).toEqual([4, 3, 3, 5])
  })

  it('drops an incomplete per-tee row (partial / wrong length) rather than misalign', () => {
    const course = buildRemoteCourse({
      id: 'x',
      name: 'T',
      holes,
      tees: [{ name: 'Blue', strokeIndexes: [1, 2, undefined, 4], pars: [4, 4, 3] }],
    })
    expect(course.teeSets[0]!.strokeIndexes).toBeUndefined()
    expect(course.teeSets[0]!.pars).toBeUndefined()
  })

  it('clamps out-of-range per-tee par to 4', () => {
    const course = buildRemoteCourse({
      id: 'x',
      name: 'T',
      holes,
      tees: [{ name: 'Red', pars: [4, 9, 3, 5] }],
    })
    expect(course.teeSets[0]!.pars).toEqual([4, 4, 3, 5])
  })
})

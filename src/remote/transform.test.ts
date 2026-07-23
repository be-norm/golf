import { describe, expect, it } from 'vitest'
import type { Course } from '../engine/core/types'
import { buildRemoteCourse, normalizeTeeRatings, usableHoleRows } from './transform'

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

describe('normalizeTeeRatings', () => {
  // par 33 nine
  const nine = (rating: number, extra?: Partial<Course>): Course => ({
    id: 'c',
    name: 'Penmar',
    holeCount: 9,
    holes: [4, 4, 3, 4, 3, 4, 4, 4, 3].map((par, i) => ({
      number: i + 1,
      par,
      strokeIndex: i + 1,
    })),
    teeSets: [{ id: 't', name: 'Blue', rating, slope: 103 }],
    source: 'remote',
    updatedAt: '',
    revision: 0,
    ...extra,
  })

  it('halves an 18-hole rating that landed on a 9-hole card', () => {
    // a doubled nine at GolfCourseAPI: 63.4 against par 33 is 30 over — an
    // 18-hole number, and worth ~30 phantom strokes to every player.
    expect(normalizeTeeRatings(nine(63.4)).teeSets[0]!.rating).toBe(31.7)
  })

  it('leaves a plausible 9-hole rating alone', () => {
    expect(normalizeTeeRatings(nine(35.6)).teeSets[0]!.rating).toBe(35.6)
    expect(normalizeTeeRatings(nine(33)).teeSets[0]!.rating).toBe(33) // the par fallback
  })

  it('never touches an 18-hole course', () => {
    const eighteen = nine(71.2, { holeCount: 18 })
    expect(normalizeTeeRatings(eighteen)).toBe(eighteen)
  })

  it('runs inside buildRemoteCourse, and the missing-rating fallback still lands on par', () => {
    const nineRows = [4, 4, 3, 4, 3, 4, 4, 4, 3].map((par, i) => ({
      number: i + 1,
      par,
      handicapIndex: i + 1,
    }))
    const built = buildRemoteCourse({
      id: 'x',
      name: 'T',
      holes: nineRows,
      tees: [{ name: 'Blue', rating: 63.4, slope: 103 }, { name: 'Red', rating: null, slope: null }],
    })
    expect(built.teeSets[0]!.rating).toBe(31.7)
    expect(built.teeSets[1]!.rating).toBe(33) // par fallback, untouched
  })
})

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

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { pointsToMoney, rankPoints } from './points'

/** The slot sets the app ships or has scoped: Six Point, then Nines. */
const SHIPPED_SLOTS: readonly number[][] = [
  [4, 2, 0],
  [5, 3, 1],
]

const scoredFrom = (scores: number[]) => scores.map((score, i) => ({ id: `p-${i}`, score }))

describe('rankPoints', () => {
  it('hands out the slots in rank order when nobody ties', () => {
    const points = rankPoints(scoredFrom([5, 3, 4]), [4, 2, 0])!
    expect(points['p-1']).toBe(4) // lowest score
    expect(points['p-2']).toBe(2)
    expect(points['p-0']).toBe(0)
  })

  it('splits the slots a tie spans — every Six Point shape', () => {
    expect(rankPoints(scoredFrom([4, 4, 5]), [4, 2, 0])).toEqual({
      'p-0': 3,
      'p-1': 3,
      'p-2': 0,
    })
    expect(rankPoints(scoredFrom([4, 5, 5]), [4, 2, 0])).toEqual({
      'p-0': 4,
      'p-1': 1,
      'p-2': 1,
    })
    expect(rankPoints(scoredFrom([4, 4, 4]), [4, 2, 0])).toEqual({
      'p-0': 2,
      'p-1': 2,
      'p-2': 2,
    })
  })

  it("does the same for Nines' 5-3-1, which is why the rule is shared", () => {
    expect(rankPoints(scoredFrom([4, 4, 5]), [5, 3, 1])).toEqual({
      'p-0': 4,
      'p-1': 4,
      'p-2': 1,
    })
    expect(rankPoints(scoredFrom([4, 5, 5]), [5, 3, 1])).toEqual({
      'p-0': 5,
      'p-1': 2,
      'p-2': 2,
    })
    expect(rankPoints(scoredFrom([4, 4, 4]), [5, 3, 1])).toEqual({
      'p-0': 3,
      'p-1': 3,
      'p-2': 3,
    })
  })

  /**
   * A hole with the wrong number of scores has no distribution. NULL rather
   * than a throw: `deriveRound` has no try/catch, so throwing over a missing
   * score would crash a live round — and null is the answer Six Point already
   * turns into a void hole.
   */
  it('returns null when the field does not match the slots', () => {
    expect(rankPoints(scoredFrom([4, 5]), [4, 2, 0])).toBeNull()
    expect(rankPoints(scoredFrom([4, 5, 6, 7]), [4, 2, 0])).toBeNull()
    expect(rankPoints([], [4, 2, 0])).toBeNull()
  })

  it('conserves the pot: the distribution always sums to the slots', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }).chain((n) =>
          fc.tuple(
            fc.array(fc.integer({ min: 1, max: 4 }), { minLength: n, maxLength: n }),
            fc.array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n }),
          ),
        ),
        ([scores, slots]) => {
          const points = rankPoints(scoredFrom(scores), slots)!
          const dealt = Object.values(points).reduce((a, b) => a + b, 0)
          const available = slots.reduce((a, b) => a + b, 0)
          // tolerance, not equality: an arbitrary slot set can average to a
          // repeating fraction. Integrality is a constraint on the slot sets we
          // CHOOSE, asserted exactly below.
          expect(dealt).toBeCloseTo(available, 9)
        },
      ),
    )
  })

  /**
   * The real constraint behind slot choice: with these sets, every tie average
   * is a whole number, so points stay integers and the money riding on them
   * stays cents. A future game picking [4,3,0] would tie two low players at 3.5
   * and this is where it finds out.
   */
  it('keeps points integral for every tie shape of the slot sets we ship', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHIPPED_SLOTS),
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 3 }),
        (slots, scores) => {
          const points = rankPoints(scoredFrom(scores), slots)!
          for (const p of Object.values(points)) expect(Number.isInteger(p)).toBe(true)
        },
      ),
    )
  })
})

describe('pointsToMoney', () => {
  it('pays the gap against each opponent', () => {
    // 3 players, 4/1/1 points at 25¢: A is +3 on each of two opponents
    const money = pointsToMoney(
      ['a', 'b', 'c'],
      new Map([
        ['a', 4],
        ['b', 1],
        ['c', 1],
      ]),
      25,
    )
    expect(money).toEqual({ a: 25 * (3 * 4 - 6), b: 25 * (3 * 1 - 6), c: 25 * (3 * 1 - 6) })
    expect(money.a).toBe(150)
    expect(money.b).toBe(-75)
  })

  it('is zero-sum for 2–8 players, whatever the points', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }).chain((n) =>
          fc.tuple(
            fc.constant(Array.from({ length: n }, (_, i) => `p-${i}`)),
            fc.array(fc.integer({ min: -5, max: 20 }), { minLength: n, maxLength: n }),
          ),
        ),
        fc.integer({ min: 1, max: 1000 }),
        ([ids, points], perPointCents) => {
          const money = pointsToMoney(
            ids,
            new Map(ids.map((id, i) => [id, points[i]!])),
            perPointCents,
          )
          expect(Object.values(money).reduce((a, b) => a + b, 0)).toBe(0)
        },
      ),
    )
  })

  /**
   * Σ is taken over the ROSTER, not over the map. A points map carrying an id
   * that isn't playing must not be able to tilt the balance — a settlement that
   * doesn't sum to zero is the one thing a money app cannot ship.
   */
  it('ignores points belonging to nobody on the roster', () => {
    const money = pointsToMoney(
      ['a', 'b'],
      new Map([
        ['a', 3],
        ['b', 1],
        ['ghost', 99],
      ]),
      100,
    )
    expect(Object.values(money).reduce((a, b) => a + b, 0)).toBe(0)
    expect(money).toEqual({ a: 200, b: -200 })
  })

  it('treats a player with no points recorded as zero', () => {
    const money = pointsToMoney(['a', 'b'], new Map([['a', 2]]), 50)
    expect(money).toEqual({ a: 100, b: -100 })
  })
})

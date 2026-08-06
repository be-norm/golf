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

  it('conserves the pot EXACTLY whenever it distributes at all', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }).chain((n) =>
          fc.tuple(
            fc.array(fc.integer({ min: 1, max: 4 }), { minLength: n, maxLength: n }),
            fc.array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n }),
          ),
        ),
        ([scores, slots]) => {
          const points = rankPoints(scoredFrom(scores), slots)
          // a slot set whose ties don't average whole returns null rather than
          // fractions, so this is exact equality — no float tolerance needed
          if (points === null) return
          const dealt = Object.values(points).reduce((a, b) => a + b, 0)
          expect(dealt).toBe(slots.reduce((a, b) => a + b, 0))
        },
      ),
    )
  })

  /**
   * CLAUDE.md invariant #3: money is integer cents. `pointsToMoney` multiplies
   * these straight into cents, so fractional points would settle half-pennies —
   * zero-sum, unroundable, and impossible to reconcile against what players
   * actually hand each other. The constraint is enforced here rather than
   * described: a game wired to [4,3,0] ties two low players at 3.5, and gets
   * null (a void hole its golden test will shout about) instead of 12.5¢.
   */
  it('refuses slots whose ties do not average whole', () => {
    expect(rankPoints(scoredFrom([4, 4, 5]), [4, 3, 0])).toBeNull()
    expect(rankPoints(scoredFrom([4, 4, 4]), [1, 0, 0])).toBeNull()
    // distinct scores never average, so the same slots are fine untied
    expect(rankPoints(scoredFrom([4, 5, 6]), [4, 3, 0])).toEqual({
      'p-0': 4,
      'p-1': 3,
      'p-2': 0,
    })
  })

  it('always yields integral points for the slot sets we ship', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHIPPED_SLOTS),
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 3 }),
        (slots, scores) => {
          const points = rankPoints(scoredFrom(scores), slots)
          // never null for these: that IS the property that makes them shippable
          expect(points).not.toBeNull()
          for (const p of Object.values(points!)) expect(Number.isInteger(p)).toBe(true)
        },
      ),
    )
  })

  /**
   * Golf ranks ascending — lowest score takes the top slot. A higher-is-better
   * game (Stableford, Quota) that forgets to negate gets an exactly inverted
   * settlement that is still zero-sum, so no property here would catch it.
   * Pinning the direction is the only warning available.
   */
  it('ranks ascending: the LOWEST score takes the first slot', () => {
    const points = rankPoints(scoredFrom([9, 2]), [10, 0])!
    expect(points['p-1']).toBe(10)
    expect(points['p-0']).toBe(0)
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

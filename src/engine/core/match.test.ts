import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  closeMargin,
  holesRemainingIn,
  matchClosed,
  matchWonLabel,
  newMatch,
  scoreMatchHole,
  segmentSpans,
  sideStake,
  toPlayAfterIn,
  type MatchHoleResult,
  type MatchSides,
} from './match'

/** The non-breaking space, as an escape — the character is invisible in source. */
const NBSP = '\u00A0'

const sides = (a: string[], b: string[]): MatchSides => ({
  a,
  b,
  short: (side) => (side === 'a' ? a : b).join(' & '),
})

describe('closeMargin — the mandated single formatter', () => {
  it('speaks golf: 3&2 early, N up at the distance', () => {
    expect(closeMargin(3, 2)).toBe('3&2')
    expect(closeMargin(1, 5)).toBe('1&5')
    expect(closeMargin(2, 0)).toBe(`2${NBSP}up`)
    expect(closeMargin(1, 0)).toBe(`1${NBSP}up`)
  })

  /**
   * THE structural guard. CLAUDE.md states the rule in prose and Nassau's
   * fixtures test it through five layers of derivation; this tests it at the
   * choke point, where every future match game inherits it.
   *
   * The share card is painted by hand onto a canvas and word-wraps on spaces,
   * so any ASCII space in this token is a card that reads "Ann wins 1" with the
   * "up" stranded on the line below. A plain space is invisible next to a
   * non-breaking one in an editor — only an assertion catches the swap.
   */
  it('never emits an ASCII space, for any margin', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 18 }),
        fc.integer({ min: 0, max: 17 }),
        (up, toPlay) => {
          expect(closeMargin(up, toPlay)).not.toContain(' ')
        },
      ),
    )
  })

  it('never spaces the ampersand either', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 18 }),
        fc.integer({ min: 1, max: 17 }),
        (up, toPlay) => {
          expect(closeMargin(up, toPlay)).not.toMatch(/\d\s*&\s+\d|\d\s+&/)
        },
      ),
    )
  })
})

describe('segmentSpans', () => {
  it('splits an 18 into front, back and overall', () => {
    const spans = segmentSpans(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(spans.front).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(spans.back).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18])
    expect(spans.overall).toHaveLength(18)
  })

  it('collapses a nine to a single overall bet', () => {
    const spans = segmentSpans([10, 11, 12, 13, 14, 15, 16, 17, 18])
    expect(spans.front).toEqual([])
    expect(spans.back).toEqual([])
    expect(spans.overall).toHaveLength(9)
  })
})

describe('toPlayAfterIn', () => {
  it('counts a span structurally, not by what is still undecided', () => {
    const after = toPlayAfterIn([1, 2, 3, 4, 5])
    expect(after(1)).toBe(4)
    expect(after(4)).toBe(1)
    expect(after(5)).toBe(0)
  })

  /**
   * The miss case must fail towards NOT closing. Answering 0 for an unknown
   * hole reads as "no holes left", which any lead beats — quietly settling a
   * bet that is still live.
   */
  it('answers a hole outside the span with a count no lead can beat', () => {
    const after = toPlayAfterIn([1, 2, 3])
    expect(after(17)).toBe(3)
  })
})

describe('match state', () => {
  const decided = (holes: number[]) =>
    new Map<number, MatchHoleResult>(holes.map((h) => [h, 1 as MatchHoleResult]))

  it('closes when a side is up more holes than the match has left, and freezes there', () => {
    const span = [1, 2, 3, 4, 5]
    const after = toPlayAfterIn(span)
    const m = newMatch()
    // A wins 1, 2, 3 → 3 up with 2 to play, decided on hole 3
    for (const hole of [1, 2, 3]) scoreMatchHole(m, hole, 1, after(hole), true)
    expect(m.closedAt).toBe(3)
    expect(m.closeToPlay).toBe(2)
    expect(matchWonLabel(m, sides(['Ann'], ['Bob']))).toBe('Ann wins 3&2')
  })

  it('returns the diff BEFORE the hole, so callers can see the crossing', () => {
    const m = newMatch()
    expect(scoreMatchHole(m, 1, 1, 8, true)).toBe(0)
    expect(scoreMatchHole(m, 2, 1, 7, true)).toBe(1)
    expect(m.diff).toBe(2)
  })

  /**
   * A bet can run out of room on a hole nobody played — the group finishes
   * early and `round/completed` finalizes the rest of the card at once. Quoting
   * "2&1" there describes holes that never happened (MAI-38).
   */
  it('degrades to a plain N up when the deciding hole was never played', () => {
    const m = newMatch()
    scoreMatchHole(m, 6, 1, 0, false)
    expect(m.closedAt).toBe(6)
    expect(m.closeToPlay).toBe(0)
    expect(matchWonLabel(m, sides(['Ann'], ['Bob']))).toBe(`Ann wins 1${NBSP}up`)
  })

  it('reports a live match and a push as unwon', () => {
    const live = newMatch()
    scoreMatchHole(live, 1, 1, 8, true)
    live.holesRemaining = 8
    expect(matchWonLabel(live, sides(['Ann'], ['Bob']))).toBeNull()
    expect(matchClosed(live)).toBe(false)

    const push = newMatch()
    scoreMatchHole(push, 1, 0, 0, true)
    expect(matchWonLabel(push, sides(['Ann'], ['Bob']))).toBeNull()
    expect(matchClosed(push)).toBe(true)
  })

  it('agrees with the side on the verb — a pair win, a lone player wins', () => {
    const m = newMatch()
    scoreMatchHole(m, 3, -1, 0, true)
    expect(matchWonLabel(m, sides(['Ann'], ['Bob & Cy']))).toBe(`Bob & Cy wins 1${NBSP}up`)
    expect(matchWonLabel(m, sides(['Ann'], ['Bob', 'Cy']))).toBe(`Bob & Cy win 1${NBSP}up`)
  })

  it('counts only undecided holes from the start hole on', () => {
    expect(holesRemainingIn([1, 2, 3, 4], 3, decided([1, 2]))).toBe(2)
    expect(holesRemainingIn([1, 2, 3, 4], 1, decided([1, 2, 3, 4]))).toBe(0)
  })
})

describe('sideStake', () => {
  /**
   * A full side wagers ONE stake; an outnumbered lone player books it against
   * EACH opponent. That is what keeps an uneven 2v1 zero-sum: the pair risk
   * $5 each, the solo player $10.
   */
  it('scales a lone side with the size of the other', () => {
    const uneven = sides(['ann', 'bob'], ['cy'])
    expect(sideStake(500, uneven, 'a')).toBe(500)
    expect(sideStake(500, uneven, 'b')).toBe(1000)
  })

  it('is symmetric for even sides', () => {
    const even = sides(['ann', 'bob'], ['cy', 'dee'])
    expect(sideStake(500, even, 'a')).toBe(500)
    expect(sideStake(500, even, 'b')).toBe(500)
  })

  /**
   * Zero-sum holds for EVERY split a match game can actually deal at ≤4
   * players: even sides, or one lone player against the rest.
   *
   * It is deliberately not claimed beyond that. A 3-v-2 does NOT balance under
   * this rule (three players risking one stake each against two doing the same
   * moves $5 the wrong way), and there is no fifth player to deal it — Nassau
   * caps at 4, and the lone side is the only uneven shape below that. A game
   * that ever wants 3-v-2 needs a stake rule of its own, and this test is where
   * it will find that out rather than in somebody's settlement.
   */
  it('keeps every split a foursome can deal zero-sum', () => {
    const SHAPES: [number, number][] = [
      [1, 1],
      [1, 2],
      [2, 1],
      [1, 3],
      [3, 1],
      [2, 2],
    ]
    fc.assert(
      fc.property(fc.constantFrom(...SHAPES), fc.integer({ min: 1, max: 10000 }), (shape, stake) => {
        const [aCount, bCount] = shape
        const s = sides(
          Array.from({ length: aCount }, (_, i) => `a${i}`),
          Array.from({ length: bCount }, (_, i) => `b${i}`),
        )
        // winners collect their per-player stake, losers pay theirs
        const moved = aCount * sideStake(stake, s, 'a') - bCount * sideStake(stake, s, 'b')
        expect(moved).toBe(0)
      }),
    )
  })
})

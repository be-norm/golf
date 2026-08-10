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
  spanFrom,
  stretchLabel,
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

  /**
   * The halves are the nines WALKED, not the nines printed on the card. A group
   * teeing off on 10 plays its front bet over 10–18 and its back bet over 1–9 —
   * splitting by hole number would settle their first bet with the last nine
   * holes they play, which is the carry-across-the-turn failure MAI-41 is for.
   */
  it('splits a wrapped 18 by the order the holes were played', () => {
    const wrapped = [...Array.from({ length: 9 }, (_, i) => i + 10), ...Array.from({ length: 9 }, (_, i) => i + 1)]
    const spans = segmentSpans(wrapped)
    expect(spans.front).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18])
    expect(spans.back).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(spans.overall).toEqual(wrapped)
  })
})

describe('a match over a wrapped round', () => {
  const wrapped = [...Array.from({ length: 9 }, (_, i) => i + 10), ...Array.from({ length: 9 }, (_, i) => i + 1)]

  /**
   * THE bug this kit had before MAI-41, and the reason `spanFrom` exists.
   *
   * `filter(h => h >= startHole)` over `[10…18, 1…9]` starting at 10 counts
   * NINE holes, not eighteen — so a side going 5 up through the first nine
   * would be "5 up with 4 to play", i.e. closed out 5&4, while the group is
   * standing on the first tee with half their match still ahead of them. Money
   * moves on a close (MAI-38), so this paid out a bet that was still live.
   */
  it('seeds all eighteen holes as remaining, not the nine above the start hole', () => {
    expect(newMatch(wrapped, 10).holesRemaining).toBe(18)
  })

  it('counts the undecided holes of a wrapped span, wherever the bet opened', () => {
    // decided: the first five walked (10–14). A bet opened on the first tee has
    // 13 left; one opened on hole 1 — the TENTH hole walked — has all 9 of its.
    const results = new Map<number, MatchHoleResult>(
      wrapped.map((h) => [h, [10, 11, 12, 13, 14].includes(h) ? 1 : null]),
    )
    expect(holesRemainingIn(wrapped, 10, results)).toBe(13)
    expect(holesRemainingIn(wrapped, 1, results)).toBe(9)
  })

  it('takes the tail of a span in play order, and the whole span for a hole not in it', () => {
    expect(spanFrom(wrapped, 17)).toEqual([17, 18, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(spanFrom(wrapped, 99)).toEqual(wrapped)
  })
})

describe('stretchLabel', () => {
  it('names the whole card 18, and a nine by which nine it was', () => {
    expect(stretchLabel(Array.from({ length: 18 }, (_, i) => i + 1))).toBe('18')
    expect(stretchLabel([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe('F9')
    expect(stretchLabel([10, 11, 12, 13, 14, 15, 16, 17, 18])).toBe('B9')
  })

  /**
   * The holes played are the WHOLE input now — the round's declared range used
   * to come in beside them, and stopped being able to answer the question it
   * was asked. `back9` said "starts on 10" only while a round had to; once one
   * can tee off anywhere and wrap (MAI-41), the hole list is the only thing
   * that knows which nine this is. A round set to `full18` on a 9-hole course
   * still plays nine, and calling that "18" would name holes that don't exist.
   */
  it('reads the holes actually played', () => {
    expect(stretchLabel([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe('F9')
    expect(stretchLabel(Array.from({ length: 18 }, (_, i) => ((i + 9) % 18) + 1))).toBe('18')
  })

  /**
   * A nine that is neither of the card's own nines gets the bare count.
   *
   * Unreachable from setup — the start-hole picker is offered on 18-hole rounds
   * only (`holesForRound`) — so this exists for a loosely-validated import, and
   * it is the honest answer: holes 15–5 are not the front nine and not the back
   * nine, and naming them either would be a claim about the card that is false.
   * DON'T "fix" this into F9 by reading `holesPlayed[0] <= 9`.
   */
  it('names a nine that is neither of the card nines as just a nine', () => {
    expect(stretchLabel([15, 16, 17, 18, 1, 2, 3, 4, 5])).toBe('9')
  })

  /**
   * A round with no playable holes at all is reachable — a back-nine round
   * whose course snapshot has nine holes leaves `holesPlayed` empty
   * (`holesForRound`), and `importRound` validates loosely enough to restore
   * one. It is still named as a NINE rather than an 18.
   *
   * It used to answer B9/F9 off the declared range. It now answers '9',
   * deliberately: a round with no holes has no nine to point at, and the label
   * that named one was reading a field that no longer decides where a round
   * starts. Such a round moves no money, so nothing rides on the string —
   * pinning it keeps the next reader from restoring a rule this never had.
   */
  it('names an unplayable round as a nine, naming no particular nine', () => {
    expect(stretchLabel([])).toBe('9')
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
  /** a full nine, for matches whose span doesn't matter to the assertion */
  const FULL = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  const decided = (holes: number[]) =>
    new Map<number, MatchHoleResult>(holes.map((h) => [h, 1 as MatchHoleResult]))

  it('closes when a side is up more holes than the match has left, and freezes there', () => {
    const span = [1, 2, 3, 4, 5]
    const after = toPlayAfterIn(span)
    const m = newMatch(span, 1)
    // A wins 1, 2, 3 → 3 up with 2 to play, decided on hole 3
    for (const hole of [1, 2, 3]) scoreMatchHole(m, hole, 1, after(hole), true)
    expect(m.closedAt).toBe(3)
    expect(m.closeToPlay).toBe(2)
    expect(matchWonLabel(m, sides(['Ann'], ['Bob']))).toBe('Ann wins 3&2')
  })

  /**
   * A match that is over is over. Nassau enforced this by filtering closed bets
   * out of its walk, which meant every other match game had to re-derive the
   * rule — and the one that forgot would rewrite `closedAt` to a later hole and
   * pay whichever side was ahead at the end, with zero-sum intact the whole way.
   */
  it('is inert once decided — the margin cannot drift on later holes', () => {
    const span = [1, 2, 3, 4, 5]
    const after = toPlayAfterIn(span)
    const m = newMatch(span, 1)
    for (const hole of [1, 2, 3]) scoreMatchHole(m, hole, 1, after(hole), true)
    expect(matchWonLabel(m, sides(['Ann'], ['Bob']))).toBe('Ann wins 3&2')

    // B takes the dead holes — a caller without Nassau's filter would score them
    for (const hole of [4, 5]) scoreMatchHole(m, hole, -1, after(hole), true)
    expect(m.closedAt).toBe(3)
    expect(m.closeToPlay).toBe(2)
    expect(m.diff).toBe(3)
    expect(m.history.has(4)).toBe(false)
    expect(matchWonLabel(m, sides(['Ann'], ['Bob']))).toBe('Ann wins 3&2')
  })

  it('returns the diff BEFORE the hole, so callers can see the crossing', () => {
    const m = newMatch(FULL, 1)
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
    const m = newMatch([6], 6)
    scoreMatchHole(m, 6, 1, 0, false)
    expect(m.closedAt).toBe(6)
    expect(m.closeToPlay).toBe(0)
    expect(matchWonLabel(m, sides(['Ann'], ['Bob']))).toBe(`Ann wins 1${NBSP}up`)
  })

  /**
   * `holesRemaining` is seeded by `newMatch` and re-derived by the engine once
   * it knows which holes decided — `scoreMatchHole` cannot maintain it, because
   * a match doesn't carry its own span. Both halves are exercised here rather
   * than hand-patching the field: seeding is what stops a fresh match reading
   * as a push, and the re-derive is what makes a real push read as one.
   */
  it('reports a live match as live and a played-out tie as a push', () => {
    const live = newMatch(FULL, 1)
    scoreMatchHole(live, 1, 1, 8, true)
    expect(matchClosed(live)).toBe(false)
    live.holesRemaining = holesRemainingIn(FULL, 1, decided([1]))
    expect(matchWonLabel(live, sides(['Ann'], ['Bob']))).toBeNull()
    expect(matchClosed(live)).toBe(false)

    const push = newMatch([1], 1)
    expect(matchClosed(push)).toBe(false) // not decided before a ball is struck
    scoreMatchHole(push, 1, 0, 0, true)
    push.holesRemaining = holesRemainingIn([1], 1, decided([1]))
    expect(matchWonLabel(push, sides(['Ann'], ['Bob']))).toBeNull()
    expect(matchClosed(push)).toBe(true)
  })

  it('agrees with the side on the verb — a pair win, a lone player wins', () => {
    const m = newMatch([3], 3)
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

import { describe, expect, it } from 'vitest'
import { holeRangeLabel, holesForRound, teedOffAway } from './holes'
import { doubleNine } from './tees'
import { makeCourse } from '../test/harness'
import type { Course, Round, RoundHoles } from './types'

const EIGHTEEN = makeCourse(
  [4, 4, 5, 3, 4, 4, 3, 5, 4, 4, 5, 3, 4, 4, 5, 3, 4, 4],
  [5, 13, 1, 9, 17, 3, 11, 7, 15, 6, 2, 16, 10, 4, 8, 18, 12, 14],
)
const NINE = makeCourse([4, 4, 5, 3, 4, 4, 3, 5, 4], [5, 3, 1, 9, 7, 2, 8, 4, 6])

const range = (
  holes: RoundHoles,
  startHole?: number,
  courseSnapshot: Course = EIGHTEEN,
): Pick<Round, 'holes' | 'startHole' | 'courseSnapshot'> => ({
  holes,
  ...(startHole !== undefined && { startHole }),
  courseSnapshot,
})

const seq = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i)

describe('holesForRound', () => {
  /**
   * The three ranges as they behaved before start holes existed. Every round
   * ever played is one of these, so nothing here may move: a change in this
   * block is a change to what a finished round in somebody's archive replays as.
   */
  it('plays the declared range when no start hole is stored', () => {
    expect(holesForRound(range('full18'))).toEqual(seq(1, 18))
    expect(holesForRound(range('front9'))).toEqual(seq(1, 9))
    expect(holesForRound(range('back9'))).toEqual(seq(10, 9))
  })

  /** The ticket: eighteen holes that carry across the turn instead of ending on 18. */
  it('wraps an eighteen from the hole it teed off on', () => {
    expect(holesForRound(range('full18', 10))).toEqual([...seq(10, 9), ...seq(1, 9)])
    expect(holesForRound(range('full18', 14))).toEqual([...seq(14, 5), ...seq(1, 13)])
    expect(holesForRound(range('full18', 1))).toEqual(seq(1, 18))
  })

  /** A nine rotates inside its own nine — 13–18 then 10–12, never the front. */
  it('wraps a nine within the nine it is playing', () => {
    expect(holesForRound(range('back9', 13))).toEqual([13, 14, 15, 16, 17, 18, 10, 11, 12])
    expect(holesForRound(range('front9', 4))).toEqual([4, 5, 6, 7, 8, 9, 1, 2, 3])
  })

  /**
   * THE BOUND, and it lives here rather than in the picker.
   *
   * A start hole on the wrong nine is not merely un-offered — it is
   * underivable, so the range falls back to its own head. `importRound`
   * validates neither `holes` nor `startHole`, so "the UI doesn't offer it" was
   * never going to be enough: an archive can say `back9` + hole 3, and the
   * answer has to be holes 10–18 rather than a round that plays the front nine
   * under a name that says otherwise.
   *
   * This is also what keeps every rotation revertible — a round can only ever
   * be a permutation of the holes its range names, so reverting MAI-41 restores
   * the same hole SET with every score still on a hole the round plays.
   */
  it('refuses a start hole from the other nine, falling back to its own head', () => {
    expect(holesForRound(range('back9', 3))).toEqual(seq(10, 9))
    expect(holesForRound(range('front9', 14))).toEqual(seq(1, 9))
    // …and a full 18 has no "other nine" to be sent back from
    expect(holesForRound(range('full18', 14))).toEqual([...seq(14, 5), ...seq(1, 13)])
  })

  /**
   * Garbage arrives: `importRound` casts the round without validating either
   * field. Falling back to the range's own default keeps a round the user can
   * still open from deriving zero holes — or throwing out of `ctx.par`, which
   * fails loudly on a hole the snapshot lacks.
   */
  it('falls back to the range default for a start hole the card does not have', () => {
    expect(holesForRound(range('full18', 99))).toEqual(seq(1, 18))
    expect(holesForRound(range('back9', 0))).toEqual(seq(10, 9))
    expect(holesForRound(range('full18', -3))).toEqual(seq(1, 18))
  })

  /**
   * Preserved deliberately from before this existed: a range whose START the
   * card doesn't have plays NOTHING rather than silently sliding to hole 1.
   * Match Play documents an empty span as "a match with no holes" and settles
   * it as a push — a behaviour that only reads correctly if this stays empty.
   */
  it('plays nothing when the range starts on a hole the card has not got', () => {
    expect(holesForRound(range('back9', undefined, NINE))).toEqual([])
  })

  /**
   * …and NO start hole can smuggle it back into playability.
   *
   * This used to be the exception: a stored hole the card happened to have was
   * honoured before the range was consulted, so `back9` + `startHole: 3` on a
   * nine played 3…9,1,2 — a back-nine round playing the front, out of an
   * import. Rotating inside the block removes the case rather than documenting
   * it: the block is empty, so there is nothing to rotate.
   */
  it('stays unplayable whatever start hole an import claims', () => {
    expect(holesForRound(range('back9', 3, NINE))).toEqual([])
    expect(holesForRound(range('back9', 10, NINE))).toEqual([])
  })

  it('caps a full 18 on a nine-hole card at the holes that exist', () => {
    expect(holesForRound(range('full18', undefined, NINE))).toEqual(seq(1, 9))
  })

  /**
   * A nine played twice arrives as an 18-hole snapshot numbered 1–18, so it
   * takes the ordinary 18 path. Setup doesn't offer a start hole here (the loop
   * stamps would mislabel which time round you were on), but the derivation
   * must still be sane for an import.
   */
  it('treats a doubled nine as the ordinary eighteen it is numbered as', () => {
    expect(holesForRound(range('full18', undefined, doubleNine(NINE)))).toEqual(seq(1, 18))
  })
})

/**
 * The one rule three surfaces state — first-tee screen, scorecard, share card.
 * They each had their own version and disagreed: one asked whether `startHole`
 * was set, one compared against 1, one against the range default, so an
 * imported `back9` carrying `startHole: 10` read "Back 9" on one screen and
 * "9 holes from 10" on another.
 */
describe('teedOffAway', () => {
  it('says nothing when the round starts where its range already says', () => {
    expect(teedOffAway(range('full18'))).toBeUndefined()
    expect(teedOffAway(range('front9'))).toBeUndefined()
    expect(teedOffAway(range('back9'))).toBeUndefined()
    // the case the three separate rules disagreed on
    expect(teedOffAway(range('back9', 10))).toBeUndefined()
    expect(teedOffAway(range('full18', 1))).toBeUndefined()
  })

  it('names the hole when the round teed off somewhere else', () => {
    expect(teedOffAway(range('full18', 10))).toBe(10)
    expect(teedOffAway(range('back9', 13))).toBe(13)
    expect(teedOffAway(range('front9', 4))).toBe(4)
  })

  /**
   * The DERIVED hole, never the stored one — else it announces a hole nobody
   * played. Includes a start hole from the other nine, which the range refuses
   * (see `holesForRound`): the round begins at its own head, so there is
   * nothing extra to say about it.
   */
  it('says nothing for a start hole this round would not honour', () => {
    expect(teedOffAway(range('full18', 40))).toBeUndefined()
    expect(teedOffAway(range('front9', 14))).toBeUndefined()
    expect(teedOffAway(range('back9', 3))).toBeUndefined()
    expect(teedOffAway(range('back9', undefined, NINE))).toBeUndefined()
  })
})

describe('holeRangeLabel', () => {
  it('collapses a run, and names a lone hole bare', () => {
    expect(holeRangeLabel(seq(12, 7))).toBe('12–18')
    expect(holeRangeLabel([18])).toBe('18')
    expect(holeRangeLabel([])).toBe('')
  })

  /**
   * The whole reason it exists. A wrapped stretch is two runs, and the phrasing
   * it replaced — first hole, dash, last hole — rendered this as "12–9", quoted
   * to the person deciding whether to take the bet.
   */
  it('names a wrapped stretch as the two runs it really is', () => {
    expect(holeRangeLabel([...seq(12, 7), ...seq(1, 9)])).toBe('12–18, 1–9')
  })
})

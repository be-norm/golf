import { describe, expect, it } from 'vitest'
import { holeRangeLabel, holesForRound } from './holes'
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

  /**
   * The model handles a nine from anywhere even though setup won't offer it —
   * `holesForRound` is what an imported round is read through, so the behaviour
   * has to be defined rather than accidental. Note that a nine from 10 is
   * exactly `back9`, which is why the picker can lock the two together.
   */
  it('wraps a nine too, and a nine from 10 is the back nine', () => {
    expect(holesForRound(range('front9', 10))).toEqual(seq(10, 9))
    expect(holesForRound(range('front9', 15))).toEqual([...seq(15, 4), ...seq(1, 5)])
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
   * Preserved deliberately from before this existed: a range naming holes the
   * card doesn't have plays NOTHING rather than silently sliding to hole 1.
   * Match Play documents an empty span as "a match with no holes" and settles
   * it as a push — a behaviour that only reads correctly if this stays empty.
   */
  it('plays nothing when the range names holes the card has not got', () => {
    expect(holesForRound(range('back9', undefined, NINE))).toEqual([])
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

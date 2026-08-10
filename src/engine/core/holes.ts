import type { Round } from './types'

/**
 * WHICH HOLES A ROUND PLAYS, AND IN WHAT ORDER (MAI-41).
 *
 * The one producer of that list. Everything downstream reads it as
 * `ctx.holesPlayed` and compares POSITION in it — never hole number — because a
 * round can tee off anywhere and wrap: 18 holes from 10 plays 10–18 and then
 * 1–9. A lower hole number stopped meaning "earlier" the moment that shipped.
 */

/** Just the fields the hole list needs — so setup can pass a draft round. */
type HoleRange = Pick<Round, 'holes' | 'startHole' | 'courseSnapshot'>

/**
 * The holes this round plays, in PLAY order, wrapping the card from `startHole`.
 *
 * Built FROM the snapshot's own hole numbers rather than from 1..n and filtered
 * afterwards, so it cannot name a hole the snapshot lacks — `ctx.par` throws on
 * one of those, deliberately.
 *
 * A `startHole` the card doesn't have falls back to the range's own default.
 * Guard it here, where the value first arrives: `importRound` casts the round
 * without validating either field, so an archive can carry anything, and a
 * round the user can still open must not white-screen over it.
 *
 * A range whose start hole the card hasn't got returns EMPTY (a back nine on a
 * 9-hole card), preserved from before start holes existed — Match Play
 * documents and depends on that reading: an empty span is a match with no
 * holes, which settles nothing, rather than a crash. Two limits on how far that
 * preservation goes, both reachable only through a hand-edited export:
 *   - it is the EFFECTIVE start that must be missing. A stored `startHole` the
 *     card DOES have is honoured and the fallback never runs, so 'back9' plus
 *     `startHole: 3` on a 9-hole card plays 3…9,1,2 rather than nothing.
 *   - a card that holds the start but runs out before the count does now WRAPS
 *     where the old snapshot filter truncated ('back9' on a 14-hole card was 5
 *     holes and is now 9).
 *
 * REVERT SAFETY, and why setup only offers a start hole on an 18-hole round:
 * `startHole` is stored only when it differs from the default, so it can only
 * ever sit on a 'full18'. Revert MAI-41 and such a round re-derives as 1–18 —
 * the same eighteen holes, in a different order, AND FOR DIFFERENT MONEY: Wolf
 * assigns by position so every hole gets a new wolf (and the recorded picks
 * then read as stale, sending settled holes back to pending), nassau's front
 * bet moves to holes 1–9, and match close-outs land elsewhere. Recoverable,
 * because every score is still in the log against a hole the round plays.
 * A NINE would not be: 'front9' + startHole 10 re-derives as holes 1–9 against
 * scores posted on 10–18, i.e. an empty card in a synced archive.
 */
export function holesForRound(round: HoleRange): number[] {
  const card = round.courseSnapshot.holes.map((h) => h.number).sort((a, b) => a - b)
  const count = round.holes === 'full18' ? 18 : 9
  const fallback = round.holes === 'back9' ? 10 : 1
  const asked = card.indexOf(round.startHole ?? fallback)
  const start = asked === -1 ? card.indexOf(fallback) : asked
  if (start === -1) return []
  return Array.from(
    { length: Math.min(count, card.length) },
    (_, i) => card[(start + i) % card.length]!,
  )
}

/**
 * The hole this round teed off on WHEN THAT IS WORTH SAYING — i.e. when it
 * isn't where the range already starts. Undefined otherwise.
 *
 * One rule, because three surfaces state this (the first-tee screen, the
 * scorecard, the painted share card) and they were each deciding it
 * separately: one asked "is `startHole` set", one compared against 1, one
 * against the range default. An imported `back9` carrying `startHole: 10`
 * therefore got "Back 9" on one screen and "9 holes from 10" on another,
 * announcing the hole the range already implies.
 *
 * Reads the DERIVED first hole, never the stored field, so a start hole the
 * card hasn't got says nothing rather than announcing a hole nobody played.
 */
export function teedOffAway(round: HoleRange): number | undefined {
  const first = holesForRound(round)[0]
  if (first === undefined) return undefined
  return first === (round.holes === 'back9' ? 10 : 1) ? undefined : first
}

/**
 * Holes as a person would say them: "12–18, 1–9", "15–18", "hole 7" as "7".
 *
 * Collapses ascending runs, which is the whole point — a wrapped stretch is two
 * runs, and the old `holes ${first}–${last}` phrasing renders it as "12–9". A
 * bet's stretch is quoted to the person deciding whether to take it, so it has
 * to be a true sentence about holes they are going to play.
 */
export function holeRangeLabel(holes: readonly number[]): string {
  const runs: number[][] = []
  for (const h of holes) {
    const run = runs[runs.length - 1]
    if (run && h === run[run.length - 1]! + 1) run.push(h)
    else runs.push([h])
  }
  return runs
    .map((run) => (run.length === 1 ? `${run[0]}` : `${run[0]}–${run[run.length - 1]}`))
    .join(', ')
}

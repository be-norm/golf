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
 * The holes this round plays, in PLAY order — the range's own block of the
 * card, rotated to begin at `startHole`.
 *
 * TWO STEPS, AND THE ORDER OF THEM IS THE RULE. First the BLOCK: the holes the
 * range names, taken from the snapshot's own numbers so it cannot name a hole
 * the card lacks (`ctx.par` throws on one of those, deliberately). Then the
 * rotation, INSIDE that block.
 *
 * So a back nine started on 13 plays 13–18 and then 10, 11, 12. It never
 * reaches the front, because the block it rotates within is holes 10–18 and
 * nothing puts a front-nine hole in there. That is the whole design:
 *
 *   - "Back 9" stays a TRUE name for the round. A rotation cannot make it
 *     describe holes it doesn't play, so no surface has to derive a different
 *     label for a rotated nine.
 *   - The bound is enforced HERE, not in the picker. `importRound` validates
 *     neither `holes` nor `startHole`, so 'back9' + `startHole: 3` has to be
 *     answerable — and the answer is the range's own head, 10, because 3 is not
 *     one of this round's holes. Un-offered would only have been a UI promise;
 *     un-derivable is a fact.
 *
 * A `startHole` outside the block — off the card entirely, or on the wrong nine
 * — falls back to the block's head for the same reason: an archive can carry
 * anything, and a round the user can still open must not white-screen over it.
 *
 * A range whose block is EMPTY plays nothing (a back nine on a 9-hole card),
 * preserved from before start holes existed — Match Play documents and depends
 * on that reading: an empty span is a match with no holes, which settles
 * nothing, rather than a crash. No start hole can smuggle such a round back
 * into playability now that the rotation happens inside the block.
 *
 * REVERT SAFETY. `startHole` is stored only when it differs from the range
 * default, and a rotation never leaves its block, so EVERY round re-derives on
 * a revert of MAI-41 as the SAME HOLES in a different order — the eighteen for
 * a `full18`, that nine for a nine. Different money (Wolf assigns by position,
 * so every hole gets a new wolf and the recorded picks read as stale; nassau's
 * halves move; match close-outs land elsewhere) but recoverable, because every
 * score in the log still sits on a hole the round plays. It is the block bound
 * that buys this for the nines: unbounded, a 'front9' teed off on 10 would come
 * back as holes 1–9 against scores posted on 10–18 — an empty card in a synced
 * archive, and nothing to recover from.
 */
export function holesForRound(round: HoleRange): number[] {
  const card = round.courseSnapshot.holes.map((h) => h.number).sort((a, b) => a - b)
  const from = round.holes === 'back9' ? 10 : 1
  const to = round.holes === 'full18' ? 18 : from + 8
  // The holes this range NAMES, intersected with the card — not "the lowest N
  // at or above the floor". On a card numbered 2–19 the two disagree: a count
  // would put hole 10 inside the front nine, and a back nine on a card missing
  // hole 10 would reach hole 19. The window is what the range has always meant.
  const block = card.filter((h) => h >= from && h <= to)
  // `?? -1` rather than the block's head: an absent start hole and one that
  // isn't in this block are the same answer, and both are "start at the head".
  const asked = block.indexOf(round.startHole ?? -1)
  const start = asked === -1 ? 0 : asked
  return block.map((_, i) => block[(start + i) % block.length]!)
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

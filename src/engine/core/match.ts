import type { RoundContext } from './context'
import type { Uuid } from './types'

/**
 * The match-play kit — hole-by-hole matches, close-outs, and golf's own
 * notation for a finished one.
 *
 * Nassau owned all of this privately. Match Play, Best Ball, Sixes and Defender
 * need the same machinery, and re-implementing it per game guarantees the five
 * copies eventually disagree about when a bet is won and what to call the
 * margin — which is exactly what a single formatter exists to prevent (MAI-48).
 *
 * What did NOT come along: press identity, auto-press spawning, bet naming.
 * Those are Nassau's rules, not match play's, and they stay in its engine.
 */

export type MatchSide = 'a' | 'b'

/**
 * The nassau-style three-bet convention — a front, a back and the whole card —
 * which Match Play and Best Ball share. A game whose stretches are shaped
 * differently (Sixes' rotating six-hole blocks) simply doesn't use these:
 * better a game that never calls `segmentSpans` than one contorted into
 * three names that don't describe it.
 */
export type MatchSegment = 'front' | 'back' | 'overall'

/** +1 side A, -1 side B, 0 halved, null not yet finalized */
export type MatchHoleResult = 1 | -1 | 0 | null

export interface MatchSides {
  a: readonly Uuid[]
  b: readonly Uuid[]
  /**
   * The side's COMPACT name — "Ann & Bob", built from first names, the form the
   * pinned bar has room for.
   *
   * Named `short` rather than `label` deliberately. Nassau renders first names
   * inside the margin and full names in its hole narration, so a field called
   * `label` invites the next match game to wire the full ones in here — and
   * then the bar and the ledger quote the same won bet differently. Naming the
   * form the contract wants is what stops that.
   */
  short(side: MatchSide): string
}

/**
 * THE definition of who won a hole in match play: better ball of each side,
 * over posted scores only.
 *
 * Posted-only matters. A side with nobody's score on the card can't win the
 * hole, and neither side posting halves it — semantics that live in
 * `ctx.bestNetAmongPosted` precisely so no engine re-derives them.
 */
export function matchHoleResults(
  ctx: RoundContext,
  gameId: Uuid,
  sides: MatchSides,
): Map<number, MatchHoleResult> {
  const results = new Map<number, MatchHoleResult>()
  for (const hole of ctx.holesPlayed) {
    if (!ctx.finalized(hole)) {
      results.set(hole, null)
      continue
    }
    const a = ctx.bestNetAmongPosted(gameId, sides.a, hole)
    const b = ctx.bestNetAmongPosted(gameId, sides.b, hole)
    // a side with no posted score can't win the hole; neither side → halved
    if (a === null && b === null) results.set(hole, 0)
    else if (b === null) results.set(hole, 1)
    else if (a === null) results.set(hole, -1)
    else results.set(hole, a < b ? 1 : b < a ? -1 : 0)
  }
  return results
}

/** The holes each segment scores. A 9-hole round collapses to one 'overall' bet. */
export function segmentSpans(holesPlayed: readonly number[]): Record<MatchSegment, number[]> {
  if (holesPlayed.length <= 9) {
    return { front: [], back: [], overall: [...holesPlayed] }
  }
  return {
    front: holesPlayed.filter((h) => h <= 9),
    back: holesPlayed.filter((h) => h > 9),
    overall: [...holesPlayed],
  }
}

/**
 * How many of a span's holes come after a given one — STRUCTURAL, not "how many
 * are still undecided". The two agree mid-round, but `round/completed`
 * finalizes every hole at once (core/context.ts), so an undecided count would
 * report every finished bet as won "3&0". A match won 3&2 was three up with two
 * holes left in it, whether or not those holes were played out.
 *
 * Returns a lookup rather than computing per call: it is read once per
 * (bet × decided hole), inside a `derive` that itself runs once per hole in the
 * ledger's prefix replay.
 *
 * The miss case must fail towards NOT closing. Returning 0 for an unknown hole
 * would read as "no holes left", which any non-zero lead beats — silently
 * settling a bet that is still live. The span's own length can never be
 * exceeded by a lead, so it is the safe answer.
 */
export function toPlayAfterIn(span: readonly number[]): (hole: number) => number {
  const byHole = new Map<number, number>()
  span.forEach((hole, i) => byHole.set(hole, span.length - 1 - i))
  return (hole: number) => byHole.get(hole) ?? span.length
}

/**
 * The running state of one match, from side A's perspective. Engines extend it
 * with whatever identifies their bet (Nassau adds segment, start hole, press
 * depth).
 */
export interface MatchState {
  /** running diff from side A's perspective, over decided holes */
  diff: number
  /** diff after each decided hole, recorded during the accumulation walk */
  history: Map<number, number>
  holesRemaining: number
  /**
   * The hole this match became mathematically decided on — up more holes than
   * its stretch has left. Undefined means still live, OR level at the end
   * (a push, which never "closes" because nobody won it). So
   * `closedAt !== undefined` is exactly "this bet pays".
   */
  closedAt?: number
  /** holes that still remained in the stretch at `closedAt` — the "2" in 3&2 */
  closeToPlay?: number
}

export function newMatch(): MatchState {
  return { diff: 0, history: new Map(), holesRemaining: 0 }
}

/**
 * Score one decided hole into a match, closing it if the hole decided it.
 *
 * Returns the diff BEFORE the hole, because callers need the TRANSITION rather
 * than the position: Nassau's auto-press fires on crossing ±2, not on sitting
 * at it, and a caller that re-read `match.diff` afterwards could not tell the
 * difference.
 *
 * `played` is `ctx.anyScored(hole)`, and it decides whether the margin may
 * quote a to-play count. "3&2" claims a REAL hole clinched it with two left. A
 * bet can also run out of room on a hole nobody played — most often when the
 * group finishes early and `round/completed` finalizes the rest of the card at
 * once. Quoting a count there invents golf: an 18 abandoned after 5 holes would
 * announce "won 2&1" about a match whose last 13 holes never happened. Falling
 * back to the plain "2 up" is the honest statement of where the bet ended.
 */
export function scoreMatchHole(
  match: MatchState,
  hole: number,
  result: 1 | -1 | 0,
  toPlayAfter: number,
  played: boolean,
): number {
  const before = match.diff
  match.diff += result
  match.history.set(hole, match.diff)
  if (Math.abs(match.diff) > toPlayAfter) {
    match.closedAt = hole
    match.closeToPlay = played ? toPlayAfter : 0
  }
  return before
}

/** Holes of a span, from `startHole` on, that are not yet decided. */
export function holesRemainingIn(
  span: readonly number[],
  startHole: number,
  results: ReadonlyMap<number, MatchHoleResult>,
): number {
  return span.filter((h) => h >= startHole && (results.get(h) ?? null) === null).length
}

/**
 * Decided, one way or the other — won early, won at the end, or pushed.
 *
 * A match level at the end never sets `closedAt`: it pushes, and pays nothing
 * either way. `holesRemaining === 0` is in the predicate so that case reads as
 * closed rather than perpetually live.
 */
export function matchClosed(match: MatchState): boolean {
  return match.closedAt !== undefined || match.holesRemaining === 0
}

/**
 * A finished match in golf's own notation: 3&2 is three up with two to play,
 * 2 up is a match that went the distance. ONE formatter, because the pinned
 * bar, the ledger, the standings detail, the settlement labels and the share
 * card must all name the same margin the same way.
 *
 * The margin is ONE UNBREAKABLE TOKEN. The share card is painted by hand and
 * word-wraps on spaces (paintSummaryCard.ts), so a plain "3 & 2" splits across
 * two lines, and so does "1 up" — leaving a card that reads "Ann wins 1" with
 * the "up" stranded below. Hence the bare ampersand and the non-breaking space.
 *
 * Spelled as an escape rather than typed literally: the character is invisible
 * in source, so a plain space pasted over it would look identical here and be
 * a silent regression. `match.test.ts` asserts no ASCII space can appear.
 */
export function closeMargin(up: number, toPlay: number): string {
  return toPlay > 0 ? `${up}&${toPlay}` : `${up}\u00A0up`
}

/**
 * "Ann wins 3&2" for a decided match; null while it is still live, and null for
 * a push (nobody won it). THE definition of a won bet, shared by the pinned
 * bar, the bet ledger, the settlement label and the hole notes — the same
 * one-helper-many-callers rule the press logic learned in MAI-34.
 *
 * The verb agrees with the side: a pair WIN, a lone player WINS. Reading it off
 * the winning side rather than hardcoding "wins" is the difference between
 * "Ann & Bob win 3&2" and the bar announcing "Ann & Bob wins 3&2" on every
 * 2v2 close.
 */
export function matchWonLabel(match: MatchState, sides: MatchSides): string | null {
  if (match.closedAt === undefined || match.diff === 0) return null
  const side: MatchSide = match.diff > 0 ? 'a' : 'b'
  const plural = sides[side].length > 1
  const margin = closeMargin(Math.abs(match.diff), match.closeToPlay ?? 0)
  return `${sides.short(side)} ${plural ? 'win' : 'wins'} ${margin}`
}

/**
 * What one player on this side wagers per bet.
 *
 * A full side collectively wagers ONE stake (the 1v1/2v2 convention: a $5 bet
 * swings $5 per player). An outnumbered lone player instead plays that stake
 * against EACH opponent, so their swing scales with the other side's size —
 * this keeps an uneven 2v1 zero-sum and mirrors Wolf's lone-wolf math. With
 * ≤4 players the only uneven split is a lone side, so it stays integer.
 */
export function sideStake(stakeCents: number, sides: MatchSides, side: MatchSide): number {
  const self = sides[side]
  const other = sides[side === 'a' ? 'b' : 'a']
  return self.length === 1 ? stakeCents * other.length : stakeCents
}

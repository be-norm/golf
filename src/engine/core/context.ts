import type { RoundEvent } from './events'
import { deriveGross } from './replay'
import { allocateStrokes, applyAllowance } from './handicap'
import type { Round, RoundHoles, Uuid } from './types'

export interface RoundContext {
  round: Round
  /** absolute hole numbers being played, in order */
  holesPlayed: readonly number[]
  /** playerId → (hole → gross); missing key = no score yet */
  gross: ReadonlyMap<Uuid, ReadonlyMap<number, number>>
  /**
   * How many putts this player took on this hole, or undefined if nobody
   * recorded it — the first shared fact contributed to context rather than
   * owned by an engine (MAI-54, MAI-90).
   *
   * UNDEFINED AND 0 ARE DIFFERENT, and any consumer that conflates them is
   * wrong: a chip-in genuinely takes no putts, so folding absence to zero would
   * hand Snake a three-putt-free hole it never saw and Dots a poley nobody
   * made. Read it as "we don't know" and let the game decide what that means.
   *
   * Round-level because putts are a SCORECARD fact: a group can track them with
   * no putting game running at all, and Snake, Dots and Trouble all want the
   * same number rather than three of their own.
   */
  puttsFor(playerId: Uuid, hole: number): number | undefined
  par(hole: number): number
  strokeIndex(hole: number): number
  /** handicap strokes this player receives on this hole under this game's handicap policy */
  strokesFor(gameId: Uuid, playerId: Uuid, hole: number): number
  /** net score under this game's handicap policy, or null if not scored yet */
  netFor(gameId: Uuid, playerId: Uuid, hole: number): number | null
  /**
   * Best net ball among a side's POSTED scores, or null if nobody posted.
   * The one shared definition of "best ball" — engines must not re-implement
   * posted-only semantics (a side with no posted scores can't win a hole).
   */
  bestNetAmongPosted(gameId: Uuid, playerIds: readonly Uuid[], hole: number): number | null
  /**
   * A hole's scores are final and games may settle it: everyone scored, or
   * play has moved on (a later hole has scores), or the round is completed.
   * Missing players on a finalized hole simply can't win it. The frontier
   * hole being actively entered stays unfinalized — no premature payouts.
   */
  finalized(hole: number): boolean
  /**
   * The round is OVER: nothing more is coming.
   *
   * Read from `round/completed` / `round/reopened` in the events, deliberately
   * ignoring `round.status` — the money ledger replays prefixes against the
   * same round object, and a status flag would report every prefix as finished.
   *
   * Distinct from "every hole is finalized", which is true as soon as play has
   * moved past the last hole anybody touched, and so is ALREADY true while the
   * group is still on the course with scores outstanding. Any game whose
   * narration depends on a manual input still being enterable has to ask THIS,
   * not that: a thing is unclaimed exactly when it can no longer be claimed
   * (see the award channel, and `ctp`'s dead-money note).
   */
  completed: boolean
  /**
   * Did ANYBODY post a score on this hole — i.e. was it actually played?
   * Distinct from `finalized`, which is true for a hole nobody reached once
   * the round completes. Engines need the difference whenever they narrate or
   * attribute something to a hole: a claim about a hole no one played is a
   * claim about golf that never happened.
   */
  anyScored(hole: number): boolean
  /**
   * WHERE a hole's outcome becomes visible: the hole at which `hole` first
   * counts as final, which is the hole a prefix replay first settles it on and
   * therefore the hole any money riding on it lands on. Undefined if it isn't
   * final yet.
   *
   * Usually `hole` itself — everyone scored it. But a hole that finalized only
   * because play MOVED ON belongs to the hole play moved on to, and a hole
   * finalized by `round/completed` belongs to the last hole anybody played.
   *
   * This lives here, beside `finalized`, because it is the same rule read
   * backwards, and a caller that re-derives it from `anyScored` gets a subtly
   * different answer — money landing on one ledger row while the sentence
   * explaining it sits on another (MAI-38).
   */
  finalizedAt(hole: number): number | undefined
}

export function holesForRange(range: RoundHoles): number[] {
  const start = range === 'back9' ? 10 : 1
  const count = range === 'full18' ? 18 : 9
  return Array.from({ length: count }, (_, i) => start + i)
}

/** Build the shared read-model every engine derives from. Events must already be effective. */
export function buildRoundContext(round: Round, effective: readonly RoundEvent[]): RoundContext {
  const course = round.courseSnapshot
  const holesPlayed = holesForRange(round.holes).filter((h) =>
    course.holes.some((hole) => hole.number === h),
  )
  const gross = deriveGross(effective)

  // Last write wins per (player, hole), the same rule `deriveGross` applies to
  // scores — a corrected putt count is a correction, not a second one — and a
  // clear takes the fact away entirely rather than setting it to 0.
  const putts = new Map<Uuid, Map<number, number>>()
  for (const e of effective) {
    if (e.type === 'score/putts') {
      let byHole = putts.get(e.playerId)
      if (!byHole) {
        byHole = new Map()
        putts.set(e.playerId, byHole)
      }
      byHole.set(e.hole, e.putts)
    } else if (e.type === 'score/puttsClear') {
      // back to NOT RECORDED, not to zero — the whole reason this kind exists
      putts.get(e.playerId)?.delete(e.hole)
    }
  }
  const puttsFor = (playerId: Uuid, hole: number): number | undefined =>
    putts.get(playerId)?.get(hole)

  const holeByNumber = new Map(course.holes.map((h) => [h.number, h]))
  const holeData = (hole: number) => {
    const h = holeByNumber.get(hole)
    // fail loudly: a hole outside the snapshot is a data bug, and inventing
    // par/SI here would silently corrupt stroke allocation and money
    if (!h) throw new Error(`hole ${hole} is not in the course snapshot`)
    return h
  }
  const par = (hole: number): number => holeData(hole).par
  const strokeIndex = (hole: number): number => holeData(hole).strokeIndex

  // Playing 9 holes of an 18-hole course halves the (post-allowance) course
  // handicap before allocation — the WHS convention when no dedicated 9-hole
  // rating exists. A true 9-hole course is left alone: its stored handicap is
  // ALREADY a 9-hole number, computed off 9-hole rating/slope from half the
  // index (`courseHandicapForTee`, handicap.ts). Halving here too would double-
  // discount it. A nine played twice around arrives as an 18-hole snapshot
  // (`doubleNine`, tees.ts) and takes the 18-hole path.
  const nineOfEighteen = holesPlayed.length <= 9 && course.holeCount === 18

  // Precompute per-game, per-player stroke allocation over the holes played.
  const allocations = new Map<Uuid, Map<Uuid, Map<number, number>>>()
  for (const game of round.games) {
    const perPlayer = new Map<Uuid, Map<number, number>>()
    // Read DEFENSIVELY, and here rather than at each screen. A round restored
    // from an export can carry a game with no `handicap` at all (importRound
    // validates a game loosely), and this is the first thing every surface
    // touches — `useRound` → `deriveRound` → here — so an unguarded deref is a
    // white screen on a round the user can still see in their list. Absent
    // means gross, which allocates no strokes: the honest reading of "we don't
    // know this game's handicap policy".
    const handicap = game.handicap
    if (handicap?.mode === 'net') {
      const effectiveCH = round.players.map((p) => {
        const allowed = applyAllowance(p.courseHandicap, handicap.allowancePct)
        return nineOfEighteen ? Math.round(allowed / 2) : allowed
      })
      const low = handicap.reference === 'offLow' ? Math.min(...effectiveCH) : 0
      const subsetSIs = holesPlayed.map((h) => strokeIndex(h))
      round.players.forEach((p, i) => {
        const playing = effectiveCH[i]! - low
        const strokes = allocateStrokes(playing, subsetSIs)
        perPlayer.set(p.playerId, new Map(holesPlayed.map((h, j) => [h, strokes[j]!])))
      })
    }
    allocations.set(game.gameId, perPlayer)
  }

  const strokesFor = (gameId: Uuid, playerId: Uuid, hole: number): number =>
    allocations.get(gameId)?.get(playerId)?.get(hole) ?? 0

  const netFor = (gameId: Uuid, playerId: Uuid, hole: number): number | null => {
    const g = gross.get(playerId)?.get(hole)
    return g === undefined ? null : g - strokesFor(gameId, playerId, hole)
  }

  const bestNetAmongPosted = (
    gameId: Uuid,
    playerIds: readonly Uuid[],
    hole: number,
  ): number | null => {
    let best: number | null = null
    for (const id of playerIds) {
      const net = netFor(gameId, id, hole)
      if (net !== null && (best === null || net < best)) best = net
    }
    return best
  }

  // Completion comes from EVENTS ONLY, deliberately ignoring round.status:
  // prefix replays (the money ledger) reuse the same round object, and a
  // status flag would finalize every prefix the moment the round finishes.
  let completed = false
  for (const e of effective) {
    if (e.type === 'round/completed') completed = true
    else if (e.type === 'round/reopened') completed = false
  }

  const anyScored = (hole: number): boolean =>
    round.players.some((p) => gross.get(p.playerId)?.get(hole) !== undefined)

  let lastTouchedIdx = -1
  holesPlayed.forEach((h, i) => {
    if (anyScored(h)) lastTouchedIdx = i
  })
  const allScored = (hole: number): boolean =>
    round.players.every((p) => gross.get(p.playerId)?.get(hole) !== undefined)

  const finalized = (hole: number): boolean => {
    const idx = holesPlayed.indexOf(hole)
    if (idx === -1) return false
    if (allScored(hole)) return true
    if (completed) return true
    return idx < lastTouchedIdx
  }

  // Mirrors `finalized`'s three clauses, in the same order, so the two can't
  // drift: scored out → here; play moved on → the hole it moved on to;
  // completed → the last hole anybody played.
  const finalizedAt = (hole: number): number | undefined => {
    const idx = holesPlayed.indexOf(hole)
    if (idx === -1 || !finalized(hole)) return undefined
    if (allScored(hole)) return hole
    const movedOnTo = holesPlayed.find((h, i) => i > idx && anyScored(h))
    if (movedOnTo !== undefined) return movedOnTo
    return holesPlayed.filter(anyScored).pop()
  }

  return {
    round,
    holesPlayed,
    gross,
    puttsFor,
    par,
    strokeIndex,
    strokesFor,
    netFor,
    bestNetAmongPosted,
    finalized,
    completed,
    anyScored,
    finalizedAt,
  }
}

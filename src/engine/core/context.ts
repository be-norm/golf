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
    if (game.handicap.mode === 'net') {
      const effectiveCH = round.players.map((p) => {
        const allowed = applyAllowance(p.courseHandicap, game.handicap.allowancePct)
        return nineOfEighteen ? Math.round(allowed / 2) : allowed
      })
      const low = game.handicap.reference === 'offLow' ? Math.min(...effectiveCH) : 0
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

  let lastTouchedIdx = -1
  holesPlayed.forEach((h, i) => {
    if (round.players.some((p) => gross.get(p.playerId)?.get(h) !== undefined)) lastTouchedIdx = i
  })
  const finalized = (hole: number): boolean => {
    const idx = holesPlayed.indexOf(hole)
    if (idx === -1) return false
    if (round.players.every((p) => gross.get(p.playerId)?.get(hole) !== undefined)) return true
    if (completed) return true
    return idx < lastTouchedIdx
  }

  return {
    round,
    holesPlayed,
    gross,
    par,
    strokeIndex,
    strokesFor,
    netFor,
    bestNetAmongPosted,
    finalized,
  }
}

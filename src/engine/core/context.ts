import type { RoundEvent } from './events'
import { deriveGross, isCompleted } from './replay'
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
  const par = (hole: number): number => holeByNumber.get(hole)?.par ?? 4
  const strokeIndex = (hole: number): number => holeByNumber.get(hole)?.strokeIndex ?? hole

  // Precompute per-game, per-player stroke allocation over the holes played.
  const allocations = new Map<Uuid, Map<Uuid, Map<number, number>>>()
  for (const game of round.games) {
    const perPlayer = new Map<Uuid, Map<number, number>>()
    if (game.handicap.mode === 'net') {
      const effective = round.players.map((p) =>
        applyAllowance(p.courseHandicap, game.handicap.allowancePct),
      )
      const low = game.handicap.reference === 'offLow' ? Math.min(...effective) : 0
      const subsetSIs = holesPlayed.map((h) => strokeIndex(h))
      round.players.forEach((p, i) => {
        const playing = effective[i]! - low
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

  const completed = isCompleted(round, effective)
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

  return { round, holesPlayed, gross, par, strokeIndex, strokesFor, netFor, finalized }
}

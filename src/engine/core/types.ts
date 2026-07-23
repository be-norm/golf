export type Uuid = string

export interface HoleCore {
  /** 1-based hole number on the course (1–18) */
  number: number
  par: number
  /** 18-hole stroke index: 1 = hardest */
  strokeIndex: number
  /**
   * Set only when a course is played more than once around — a nine twice, via
   * `doubleNine`. `hole` is the hole on the physical card this one replays and
   * `nth` is which time around, so the scorekeeper standing on the 5th tee for
   * the second time isn't asked for "hole 14" with no explanation. Absent on an
   * ordinary course, where `number` IS the hole. Display only: scoring, money
   * and the event log all key off `number`.
   */
  loop?: { hole: number; nth: number }
}

export interface TeeSet {
  id: Uuid
  name: string
  color?: string
  rating: number
  slope: number
  yardages?: number[]
  /** Per-hole stroke index for THIS tee (1 = hardest), when the card/API rates
   *  tees separately. Falls back to HoleCore.strokeIndex when absent. Length
   *  matches the course's holes; a valid 1..n permutation. */
  strokeIndexes?: number[]
  /** Per-hole par for THIS tee, when it differs by tee (e.g. a short hole that
   *  plays as a par 3 from a forward tee). Falls back to HoleCore.par. */
  pars?: number[]
}

export interface Course {
  id: Uuid
  name: string
  location?: string
  holeCount: 9 | 18
  holes: HoleCore[]
  teeSets: TeeSet[]
  source: 'seed' | 'user' | 'remote'
  updatedAt: string
  revision: number
}

export interface Player {
  id: Uuid
  name: string
  /** WHS handicap index — course handicap is computed per course/tee from this */
  handicapIndex?: number
  /** legacy fallback default from before indexes were stored */
  lastCourseHandicap?: number
  /** GHIN number, when the player was added via GHIN lookup (enables re-lookup) */
  ghinNumber?: string
  updatedAt: string
  /**
   * Owner partition. Signed-out ("guest") rows use the LOCAL_USER sentinel;
   * signing in claims them to the auth uid. Optional so the pure engine and
   * fixtures never have to declare it — repos always stamp it and the Dexie v2
   * upgrade backfills existing rows. See src/db/ids.ts (LOCAL_USER).
   */
  userId?: string
}

export interface RoundPlayer {
  playerId: Uuid
  /** snapshotted so a round stays self-contained */
  name: string
  /** what the player reported at setup; kept as a record, never re-derived */
  handicapIndex?: number
  /**
   * The number the engine actually uses; negative = plus handicap. It is the
   * course handicap for the course AS RATED — an 18-hole number on an 18-hole
   * course, a 9-hole number on a 9-hole course (`courseHandicapForTee`) — and
   * the engine scales it to the holes actually played. Authoritative: editing
   * it (first-tee adjustments) changes the strokes; the index does not.
   */
  courseHandicap: number
  teeSetId?: Uuid
}

export type HandicapMode = 'gross' | 'net'

/** Core-owned per-game handicap policy; engine config never re-declares this. */
export interface HandicapSettings {
  mode: HandicapMode
  /** percent of course handicap used, e.g. 100, 90 */
  allowancePct: number
  /** 'offLow' subtracts the lowest effective handicap from everyone */
  reference: 'absolute' | 'offLow'
}

export interface GameConfig<C = unknown> {
  /** instance id — two skins games could coexist in one round */
  gameId: Uuid
  type: string
  handicap: HandicapSettings
  config: C
}

export type RoundHoles = 'front9' | 'back9' | 'full18'

export type RoundStatus = 'setup' | 'live' | 'completed'

export interface Round {
  id: Uuid
  courseId: Uuid
  /** frozen at tee-off: a played round replays identically forever */
  courseSnapshot: Course
  teeSetId: Uuid
  holes: RoundHoles
  players: RoundPlayer[]
  games: GameConfig[]
  status: RoundStatus
  startedAt: string
  updatedAt: string
  deviceId: string
  schemaVersion: number
  /** Owner partition — see the note on Player.userId. */
  userId?: string
}

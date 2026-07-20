export type Uuid = string

export interface HoleCore {
  /** 1-based hole number on the course (1–18) */
  number: number
  par: number
  /** 18-hole stroke index: 1 = hardest */
  strokeIndex: number
}

export interface TeeSet {
  id: Uuid
  name: string
  color?: string
  rating: number
  slope: number
  yardages?: number[]
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
  handicapIndex?: number
  /** the number the engine actually uses; negative = plus handicap */
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

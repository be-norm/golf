import type { Course, Player, Round } from '../engine/core/types'
import { db as defaultDb, type GolfDB } from './schema'
import { newId } from './ids'

export class CourseRepo {
  constructor(private db: GolfDB = defaultDb) {}

  list(): Promise<Course[]> {
    return this.db.courses.orderBy('name').toArray()
  }

  get(id: string): Promise<Course | undefined> {
    return this.db.courses.get(id)
  }

  async put(course: Course): Promise<void> {
    await this.db.courses.put({
      ...course,
      updatedAt: new Date().toISOString(),
      revision: course.revision + 1,
    })
  }
}

export class PlayerRepo {
  constructor(private db: GolfDB = defaultDb) {}

  list(): Promise<Player[]> {
    return this.db.players.orderBy('name').toArray()
  }

  /** Reuse the roster: same name → same player. */
  async upsertByName(name: string): Promise<Player> {
    const trimmed = name.trim()
    const existing = await this.db.players.where('name').equals(trimmed).first()
    if (existing) return existing
    const player: Player = { id: newId(), name: trimmed, updatedAt: new Date().toISOString() }
    await this.db.players.put(player)
    return player
  }
}

export class RoundRepo {
  constructor(private db: GolfDB = defaultDb) {}

  get(id: string): Promise<Round | undefined> {
    return this.db.rounds.get(id)
  }

  async put(round: Round): Promise<void> {
    await this.db.rounds.put({ ...round, updatedAt: new Date().toISOString() })
  }

  /** The round to resume, if any — most recently started live round. */
  async liveRound(): Promise<Round | undefined> {
    const live = await this.db.rounds.where('status').equals('live').toArray()
    return live.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  }

  async listRecent(limit = 20): Promise<Round[]> {
    return this.db.rounds.orderBy('startedAt').reverse().limit(limit).toArray()
  }
}

export const courseRepo = new CourseRepo()
export const playerRepo = new PlayerRepo()
export const roundRepo = new RoundRepo()

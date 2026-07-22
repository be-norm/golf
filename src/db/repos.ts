import Dexie from 'dexie'
import type { Course, Player, Round } from '../engine/core/types'
import { db as defaultDb, type GolfDB } from './schema'
import { LOCAL_USER, newId } from './ids'

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

  /** Remove a course from this device's library. Local only — the shared
   *  Supabase library and any frozen round snapshots are untouched, and the
   *  course stays re-importable via search. */
  async delete(id: string): Promise<void> {
    await this.db.courses.delete(id)
  }
}

export class PlayerRepo {
  constructor(private db: GolfDB = defaultDb) {}

  /** The signed-in (or guest) user's roster, sorted by name. */
  list(userId: string): Promise<Player[]> {
    return this.db.players
      .where('[userId+name]')
      .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
      .toArray()
  }

  get(id: string): Promise<Player | undefined> {
    return this.db.players.get(id)
  }

  /** Reuse the roster: same (owner, name) → same player. */
  async upsertByName(userId: string, name: string): Promise<Player> {
    const trimmed = name.trim()
    const existing = await this.db.players.where('[userId+name]').equals([userId, trimmed]).first()
    if (existing) return existing
    return this.create(userId, trimmed)
  }

  /** Explicit roster add (used by the Players screen). */
  async create(
    userId: string,
    name: string,
    handicapIndex?: number,
    ghinNumber?: string,
  ): Promise<Player> {
    const player: Player = {
      id: newId(),
      userId,
      name: name.trim(),
      handicapIndex,
      ghinNumber,
      updatedAt: new Date().toISOString(),
    }
    await this.db.players.put(player)
    return player
  }

  async update(
    id: string,
    patch: Partial<Pick<Player, 'name' | 'handicapIndex' | 'ghinNumber'>>,
  ): Promise<void> {
    const next: Partial<Player> = { updatedAt: new Date().toISOString() }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if ('handicapIndex' in patch) next.handicapIndex = patch.handicapIndex
    if ('ghinNumber' in patch) next.ghinNumber = patch.ghinNumber
    await this.db.players.update(id, next)
  }

  async delete(id: string): Promise<void> {
    await this.db.players.delete(id)
  }

  /** Remember what a player teed off with — next setup recomputes from their index. */
  async rememberHandicap(
    playerId: string,
    handicapIndex: number,
    courseHandicap: number,
  ): Promise<void> {
    await this.db.players.update(playerId, {
      handicapIndex,
      lastCourseHandicap: courseHandicap,
      updatedAt: new Date().toISOString(),
    })
  }
}

export class RoundRepo {
  constructor(private db: GolfDB = defaultDb) {}

  /** Read-by-id is intentionally NOT owner-scoped: the id already owns access
   *  (resume link, scoring, import all hold an owned id). */
  get(id: string): Promise<Round | undefined> {
    return this.db.rounds.get(id)
  }

  async put(round: Round): Promise<void> {
    await this.db.rounds.put({ ...round, updatedAt: new Date().toISOString() })
  }

  /**
   * The round to resume, if any — most recently started live round. With a
   * userId, scoped to that owner (Home resume card); without, any live round
   * on the device (UpdateToast suppresses the update prompt mid-round).
   */
  async liveRound(userId?: string): Promise<Round | undefined> {
    const live = await this.db.rounds.where('status').equals('live').toArray()
    const scoped =
      userId === undefined ? live : live.filter((r) => (r.userId ?? LOCAL_USER) === userId)
    return scoped.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  }

  async listRecent(userId: string, limit = 20): Promise<Round[]> {
    return this.db.rounds
      .where('[userId+startedAt]')
      .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
      .reverse()
      .limit(limit)
      .toArray()
  }

  /** Hard-delete a round and its event log. Deleting a whole round is outside
   *  the append-only event invariant (that governs edits WITHIN a round). */
  async delete(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.rounds, this.db.round_events, async () => {
      await this.db.rounds.delete(id)
      await this.db.round_events.where('roundId').equals(id).delete()
    })
  }
}

export const courseRepo = new CourseRepo()
export const playerRepo = new PlayerRepo()
export const roundRepo = new RoundRepo()

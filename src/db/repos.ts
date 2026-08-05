import Dexie from 'dexie'
import type { Course, Player, Round } from '../engine/core/types'
import { db as defaultDb, type GolfDB, type SavedCourse } from './schema'
import { LOCAL_USER, newId } from './ids'

/**
 * Course DATA is shared; MEMBERSHIP is owned.
 *
 * `courses` caches scorecards — the same card serves everyone who plays there,
 * so it has no owner and is never scoped. `saved_courses` records which courses
 * are a given user's, which is owned data: it follows them between devices and
 * must not leak to whoever signs in on this phone next.
 *
 * Every save goes through `save()` and every removal through `remove()`, so
 * membership and its sync push cannot drift apart — the same
 * one-write-path rule `EventStore.append` follows for events (MAI-76).
 */
export class CourseRepo {
  constructor(private db: GolfDB = defaultDb) {}

  /** This user's saved library, sorted by name. */
  async list(userId: string): Promise<Course[]> {
    const ids = await this.db.saved_courses.where('userId').equals(userId).toArray()
    const courses = await this.db.courses.bulkGet(ids.map((s) => s.courseId))
    return courses
      .filter((c): c is Course => c !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Course data by id, unscoped — an id you hold is the capability, and a
   *  round's course must resolve whether or not it's still in your library. */
  get(id: string): Promise<Course | undefined> {
    return this.db.courses.get(id)
  }

  isSaved(userId: string, courseId: string): Promise<SavedCourse | undefined> {
    return this.db.saved_courses.get([userId, courseId])
  }

  /**
   * Cache the card and record that this user keeps it. Returns the stored
   * course so callers push exactly what landed.
   */
  async save(userId: string, course: Course): Promise<Course> {
    const stored: Course = {
      ...course,
      updatedAt: new Date().toISOString(),
      revision: course.revision + 1,
    }
    const now = new Date().toISOString()
    await this.db.transaction('rw', this.db.courses, this.db.saved_courses, async () => {
      await this.db.courses.put(stored)
      // keep the ORIGINAL save time if it's already theirs — re-importing a
      // course you already had isn't a new decision, and bumping it would win
      // a last-write-wins race against a deletion made elsewhere since
      const existing = await this.db.saved_courses.get([userId, course.id])
      if (!existing) {
        await this.db.saved_courses.put({ userId, courseId: course.id, updatedAt: now })
      }
    })
    return stored
  }

  /**
   * Make sure this user keeps this course, without touching the card.
   *
   * "I played there" is a way of saving a course, not a thing that happens to
   * saved courses — so teeing off asserts membership rather than assuming the
   * import already did. Returns true if it added one, so the caller knows
   * whether there's anything new to push.
   */
  async ensureSaved(userId: string, courseId: string): Promise<boolean> {
    if (await this.db.saved_courses.get([userId, courseId])) return false
    await this.db.saved_courses.put({
      userId,
      courseId,
      updatedAt: new Date().toISOString(),
    })
    return true
  }

  /**
   * Drop it from THIS user's library. The cached card stays: it is shared, other
   * accounts on this device may keep it, and frozen round snapshots are
   * untouched either way (invariant #4).
   */
  async remove(userId: string, courseId: string): Promise<void> {
    await this.db.saved_courses.delete([userId, courseId])
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

  /**
   * Set one player's course handicap. Read-modify-write inside a transaction so
   * two quick edits can't clobber each other through a stale in-memory round.
   *
   * Handicaps live on the round doc, not the event log, so changing one silently
   * re-derives every settlement — which is only honest on a round that has
   * nothing derived yet. That's enforced HERE, in the same transaction, not just
   * by the UI hiding the control: an empty log is the invariant (CLAUDE.md #2),
   * and a write racing the first score must lose. Returns whether it applied.
   */
  async setCourseHandicap(
    roundId: string,
    playerId: string,
    courseHandicap: number,
  ): Promise<boolean> {
    return this.db.transaction('rw', this.db.rounds, this.db.round_events, async () => {
      const round = await this.db.rounds.get(roundId)
      if (!round) return false
      const scored = await this.db.round_events.where('roundId').equals(roundId).count()
      if (scored > 0) return false
      await this.db.rounds.put({
        ...round,
        players: round.players.map((p) =>
          p.playerId === playerId ? { ...p, courseHandicap } : p,
        ),
        updatedAt: new Date().toISOString(),
      })
      return true
    })
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

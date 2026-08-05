import Dexie from 'dexie'
import type { Course, Player, Round } from '../engine/core/types'
import {
  db as defaultDb,
  type DeleteSavedCoursePayload,
  type GolfDB,
  type PushSavedCoursePayload,
} from './schema'
import { LOCAL_USER, newId } from './ids'
import { notifyOutboxWrite } from './outboxSignal'

/** Local stamps end in `Z`; Postgres returns `+00:00`. Compare instants,
 *  never strings — string order across the two encodings is meaningless. */
const epoch = (iso: string) => Date.parse(iso)

/**
 * Course DATA is shared; MEMBERSHIP is owned (MAI-76).
 *
 * `courses` caches scorecards — the same card serves everyone who plays there,
 * so it has no owner and is never scoped. `saved_courses` records which courses
 * are a given user's: that fact follows them between devices and must not leak
 * to whoever signs in on this phone next.
 *
 * This class is the ONE write path for membership, and that is structural, not
 * convention: every mutator writes the `saved_courses` row and its outbox op in
 * the SAME transaction (the rule EventStore.append follows for events), and an
 * ESLint rule keeps `db.saved_courses` unreferenceable outside `src/db`. The
 * previous attempt left the enqueue to callers, and the import paths — the main
 * way courses enter the library — forgot; the feature looked done and silently
 * never synced. The `applyRemote*` pair is the sanctioned exception: it IS the
 * sync applying remote state, so pushing from there would echo.
 */
export class CourseRepo {
  constructor(private db: GolfDB = defaultDb) {}

  /** This user's saved library, sorted by name. */
  async list(userId: string): Promise<Course[]> {
    const saved = await this.db.saved_courses.where('userId').equals(userId).toArray()
    const courses = await this.db.courses.bulkGet(saved.map((s) => s.courseId))
    return courses
      .filter((c): c is Course => c !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Course data by id, unscoped — an id you hold is the capability, and a
   *  round's course must resolve whether or not it's still in your library. */
  get(id: string): Promise<Course | undefined> {
    return this.db.courses.get(id)
  }

  /** How many courses this user keeps — drives the claim prompt's count. */
  countMemberships(userId: string): Promise<number> {
    return this.db.saved_courses.where('userId').equals(userId).count()
  }

  /**
   * Cache the card and record that this user keeps it. The membership clock is
   * stamped to now on every explicit save — saving is the user acting NOW, so
   * it must out-date a removal made earlier on another device. Returns the
   * stored card so callers publish exactly what landed.
   */
  async save(userId: string, course: Course): Promise<Course> {
    const now = new Date().toISOString()
    const stored: Course = { ...course, updatedAt: now, revision: course.revision + 1 }
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        await this.db.courses.put(stored)
        await this.db.saved_courses.put({ userId, courseId: stored.id, updatedAt: now })
        await this.enqueue(userId, 'pushSavedCourse', { userId, course: stored, savedAt: now })
      },
    )
    notifyOutboxWrite()
    return stored
  }

  /**
   * Drop it from THIS user's library. Tombstone and removal are one
   * transaction, so no crash or interleaved flush can drop the course locally
   * with nothing queued; queued saves for it are purged first so a late flush
   * can't run a push after the tombstone and resurrect the row (the same
   * ordering discipline as outbox.purgePendingFor).
   */
  async remove(userId: string, courseId: string): Promise<void> {
    const removedAt = new Date().toISOString()
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        await this.purgeQueuedSaves(userId, courseId)
        await this.enqueue(userId, 'deleteSavedCourse', { userId, courseId, removedAt })
        await this.dropMembership(userId, courseId)
      },
    )
    notifyOutboxWrite()
  }

  /**
   * Pull-side restore of one saved course. Never enqueues (it applies remote
   * state), and never re-stamps the card — a restore is not an edit, and
   * bumping revision/updatedAt here would make every restore win the next LWW
   * round against a real one.
   */
  async applyRemoteSave(userId: string, course: Course, savedAt: string): Promise<void> {
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        // An un-flushed local removal outranks this (older) remote row: without
        // the check, a pull racing the flush re-adds the course the user just
        // removed, and the flush then deletes it remotely — split brain.
        const pending = await this.db.outbox
          .filter(
            (i) =>
              i.kind === 'deleteSavedCourse' &&
              (i.payload as DeleteSavedCoursePayload).userId === userId &&
              (i.payload as DeleteSavedCoursePayload).courseId === course.id,
          )
          .count()
        if (pending > 0) return

        const localCard = await this.db.courses.get(course.id)
        if (!localCard || epoch(localCard.updatedAt) < epoch(course.updatedAt)) {
          await this.db.courses.put(course)
        }
        const membership = await this.db.saved_courses.get([userId, course.id])
        if (membership && epoch(membership.updatedAt) >= epoch(savedAt)) return
        await this.db.saved_courses.put({ userId, courseId: course.id, updatedAt: savedAt })
      },
    )
  }

  /**
   * Honour a removal made on another device — unless this one has since saved
   * the course AGAIN. A membership newer than the tombstone is newer intent,
   * and its queued push will out-date the tombstone server-side too.
   */
  async applyRemoteRemoval(userId: string, courseId: string, deletedAt: string): Promise<void> {
    await this.db.transaction('rw', this.db.courses, this.db.saved_courses, async () => {
      const membership = await this.db.saved_courses.get([userId, courseId])
      if (!membership || epoch(membership.updatedAt) > epoch(deletedAt)) return
      await this.dropMembership(userId, courseId)
    })
  }

  /**
   * Claim-on-login: re-key the guest library to the account and queue each
   * course's push. Claiming is the user acting now ("Add to account"), so the
   * membership clock is stamped fresh — it must out-date any tombstone the
   * account carries from another device. Returns how many were claimed.
   */
  async claim(userId: string): Promise<number> {
    let count = 0
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        const guest = await this.db.saved_courses.where('userId').equals(LOCAL_USER).toArray()
        const now = new Date().toISOString()
        for (const s of guest) {
          await this.db.saved_courses.delete([LOCAL_USER, s.courseId])
          await this.db.saved_courses.put({ userId, courseId: s.courseId, updatedAt: now })
          const card = await this.db.courses.get(s.courseId)
          if (card) {
            await this.enqueue(userId, 'pushSavedCourse', { userId, course: card, savedAt: now })
          }
        }
        count = guest.length
      },
    )
    notifyOutboxWrite()
    return count
  }

  /** In-transaction enqueue. Guests sync nothing, so their ops never queue —
   *  the gate lives HERE so no call site can forget it. */
  private async enqueue(
    userId: string,
    kind: 'pushSavedCourse' | 'deleteSavedCourse',
    payload: PushSavedCoursePayload | DeleteSavedCoursePayload,
  ): Promise<void> {
    if (userId === LOCAL_USER) return
    await this.db.outbox.put({
      id: newId(),
      kind,
      payload,
      createdAt: new Date().toISOString(),
      attempts: 0,
    })
  }

  /**
   * Remove one user's membership; when the last membership on this device
   * goes, the cached card goes too. Without the GC, `db.courses` grows without
   * bound (every fork's original, every removed course), and on iOS it's the
   * origin quota that decides when IndexedDB — including a live round's event
   * log — gets evicted. The card stays re-findable via search, and round
   * snapshots are frozen copies (invariant #4) either way.
   */
  private async dropMembership(userId: string, courseId: string): Promise<void> {
    await this.db.saved_courses.delete([userId, courseId])
    const remaining = await this.db.saved_courses.where('courseId').equals(courseId).count()
    if (remaining === 0) await this.db.courses.delete(courseId)
  }

  private async purgeQueuedSaves(userId: string, courseId: string): Promise<void> {
    const stale = await this.db.outbox
      .filter(
        (i) =>
          i.kind === 'pushSavedCourse' &&
          (i.payload as PushSavedCoursePayload).userId === userId &&
          (i.payload as PushSavedCoursePayload).course.id === courseId,
      )
      .primaryKeys()
    await this.db.outbox.bulkDelete(stale)
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

import Dexie from 'dexie'
import type { Course, Player, Round } from '../engine/core/types'
import {
  db as defaultDb,
  savedCourseOp,
  type DeleteSavedCoursePayload,
  type GolfDB,
  type PushCoursePayload,
  type PushSavedCoursePayload,
} from './schema'
import { LOCAL_USER, isLocallyMintedId, newId } from './ids'
import { epoch } from './clock'
import { notifyOutboxWrite } from './outboxSignal'

/**
 * Does this user own this card — i.e. does an edit update it in place, or fork
 * it (MAI-78)? Ownership is `createdBy`, never `source`: an imported copy of
 * another golfer's course is `source:'user'` but still theirs, and the server
 * refuses updates to rows you didn't create.
 *
 * Legacy cards predate `createdBy`. `source:'user'` USUALLY meant "authored on
 * this device" — except that main's editor rewrote every edited card to
 * 'user', including API imports. A card genuinely authored here got its id
 * from `newId()` (UUIDv7, invariant #8), so a provider id (`gca:9`, a v4
 * uuid) cannot be ours and forks instead of pushing onto a shared row RLS
 * refuses. Residual: a pre-branch EDIT of another golfer's library course
 * keeps their v7 uuid and still misreads as yours — that push dies quietly in
 * the outbox exactly as it does on main, and self-heals the first time the
 * card round-trips through the library (imports stamp `createdBy`).
 */
export function ownsCourse(course: Course, userId: string): boolean {
  if (course.createdBy !== undefined) return course.createdBy === userId
  return course.source === 'user' && isLocallyMintedId(course.id)
}

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
    let stored!: Course
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        stored = await this.writeSave(userId, course)
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
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        await this.writeRemoval(userId, courseId)
      },
    )
    notifyOutboxWrite()
  }

  /**
   * Save a card this user AUTHORS — brand-new, or their own updated in place —
   * and queue its shared-library publish in the same transaction. The plain
   * save() exists for importers, which must never republish someone else's
   * course; this split is what lets the publish ride inside the transaction
   * here, so a crash between "saved locally" and "queued the publish" can't
   * leave the user's correction on their phone with the shared row silently
   * stale forever (the same guarantee fork() makes).
   */
  async saveAuthored(userId: string, course: Course): Promise<Course> {
    let stored!: Course
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        stored = await this.writeSave(userId, course)
        await this.enqueue(userId, 'pushCourse', { userId, course: stored })
      },
    )
    notifyOutboxWrite()
    return stored
  }

  /**
   * Replace a card the user doesn't own with their corrected version (MAI-78):
   * save the fork and retire the original's membership in ONE transaction, so
   * a crash can never leave both rows in the library with the fork already
   * queued — nobody wants two entries for the same place in their own list.
   * The original's card is GC'd if nothing else on the device references it.
   * A fork of a fork carries `sourceId` = its immediate parent, not the chain
   * root — deliberate: every published fork carries its own source_id, so the
   * provenance chain stays walkable link by link.
   */
  async fork(userId: string, originalId: string, course: Course): Promise<Course> {
    let stored!: Course
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        stored = await this.writeSave(userId, course)
        // the fork is always publishable (source:'user', authored by this
        // user), and publishing inside the transaction means a crash can't
        // land the fork locally while losing its shared-library publish
        await this.enqueue(userId, 'pushCourse', { userId, course: stored })
        await this.writeRemoval(userId, originalId)
      },
    )
    notifyOutboxWrite()
    return stored
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
        // Ops at the retry cap don't count: they will never flush, and a dead
        // tombstone must not veto this course's restoration forever.
        const pending = await this.db.outbox
          .filter((i) => {
            const op = savedCourseOp(i)
            return (
              op?.kind === 'deleteSavedCourse' &&
              i.attempts < 10 &&
              op.userId === userId &&
              op.courseId === course.id
            )
          })
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
   * course's push, re-stamping guest authorship first. Claiming is the user
   * acting now ("Add to account"), so the membership clock is stamped fresh —
   * it must out-date any tombstone the account carries from another device.
   * Returns how many memberships were claimed.
   *
   * One transaction, authorship BEFORE membership: the membership push
   * snapshots the card into its payload, so the card must already carry the
   * account's `createdBy` when it's frozen. Re-stamping afterwards (the
   * previous shape) pushed '@local' authorship to the server, and the user's
   * other devices then treated their own course as someone else's and forked
   * it on edit — and a crash between the two steps zeroed the claim counts,
   * so the prompt never re-offered.
   */
  async claim(userId: string): Promise<number> {
    let count = 0
    await this.db.transaction(
      'rw',
      this.db.courses,
      this.db.saved_courses,
      this.db.outbox,
      async () => {
        // Cards this device authored while signed out (legacy ones carry no
        // createdBy at all) become the account's, and publish to the shared
        // library — RLS pins created_by to the caller, so this is also what
        // makes the insert pass. Cards another signed-in user authored on
        // this device are not ours to publish and keep their stamp. The
        // ownership test is ownsCourse-as-guest, NOT a bare createdBy check:
        // a raw undefined-means-mine filter re-admits exactly the population
        // ownsCourse exists to exclude (API imports the pre-createdBy editor
        // re-stamped to source:'user'), stamps them createdBy here, and from
        // then on every edit takes the in-place path and pushes onto a shared
        // row RLS refuses — the permanent silent failure, minted at claim.
        const authored = await this.db.courses
          .filter((c) => c.source === 'user' && ownsCourse(c, LOCAL_USER))
          .toArray()
        for (const c of authored) {
          const restamped: Course = { ...c, createdBy: userId }
          await this.db.courses.put(restamped)
          await this.enqueue(userId, 'pushCourse', { userId, course: restamped })
        }

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

  /** In-transaction write behind save() and fork(). */
  private async writeSave(userId: string, course: Course): Promise<Course> {
    const now = new Date().toISOString()
    const stored: Course = { ...course, updatedAt: now, revision: course.revision + 1 }
    // a fresh save supersedes a removal still queued on this device — purging
    // it here also clears a dead (retry-capped) tombstone that would
    // otherwise veto this course's pulls forever
    await this.purgeQueuedOps('deleteSavedCourse', userId, stored.id)
    await this.db.courses.put(stored)
    await this.db.saved_courses.put({ userId, courseId: stored.id, updatedAt: now })
    await this.enqueue(userId, 'pushSavedCourse', { userId, course: stored, savedAt: now })
    return stored
  }

  /** In-transaction write behind remove() and fork(). */
  private async writeRemoval(userId: string, courseId: string): Promise<void> {
    const removedAt = new Date().toISOString()
    await this.purgeQueuedOps('pushSavedCourse', userId, courseId)
    await this.enqueue(userId, 'deleteSavedCourse', { userId, courseId, removedAt })
    await this.dropMembership(userId, courseId)
  }

  /** In-transaction enqueue. Guests sync nothing, so their ops never queue —
   *  the gate lives HERE so no call site can forget it. */
  private async enqueue(
    userId: string,
    kind: 'pushSavedCourse' | 'deleteSavedCourse' | 'pushCourse',
    payload: PushSavedCoursePayload | DeleteSavedCoursePayload | PushCoursePayload,
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

  private async purgeQueuedOps(
    kind: 'pushSavedCourse' | 'deleteSavedCourse',
    userId: string,
    courseId: string,
  ): Promise<void> {
    const stale = await this.db.outbox
      .filter((i) => {
        const op = savedCourseOp(i)
        return op?.kind === kind && op.userId === userId && op.courseId === courseId
      })
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

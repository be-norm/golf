import Dexie, { type Table } from 'dexie'
import type { RoundEvent } from '../engine/core/events'
import type { Course, Player, Round } from '../engine/core/types'
import { LOCAL_USER } from './ids'

export interface OutboxItem {
  id: string
  /** Owner-scoped cloud sync ops; each payload carries its own userId. */
  kind:
    | 'pushRound'
    | 'pushPlayer'
    | 'deleteRound'
    | 'deletePlayer'
    | 'pushCourse'
    | 'pushSavedCourse'
    | 'deleteSavedCourse'
  payload: unknown
  createdAt: string
  attempts: number
}

/** Declared here (not outbox.ts) because CourseRepo writes these rows itself,
 *  in the same transaction as the membership row they describe. */
export interface PushSavedCoursePayload {
  userId: string
  course: Course
  /** The MEMBERSHIP clock — when this user saved it, not when the card last
   *  changed. Every LWW decision about the library compares this. */
  savedAt: string
}
export interface DeleteSavedCoursePayload {
  userId: string
  courseId: string
  /** When the user removed it — NOT when the flush happens to run. An offline
   *  removal can flush after a newer re-save from another device, and a
   *  flush-time stamp would let Monday's removal kill Tuesday's save. */
  removedAt: string
}
/** Publish a user-authored card to the shared `courses` library. Declared here
 *  because CourseRepo enqueues these too (fork/claim publish in the same
 *  transaction as the membership they ride with); outbox.ts sends them. */
export interface PushCoursePayload {
  userId: string
  course: Course
}

/**
 * What a queued saved-course op is about, or undefined for other kinds.
 * The ONE place that knows these payload shapes: every purge and pending-op
 * check filters through it (CourseRepo.purgeQueuedOps, applyRemoteSave's
 * tombstone veto), so a payload change cannot silently blind one of them — a
 * purge that stops matching is exactly how a stale push survives to
 * resurrect a removed course.
 */
export function savedCourseOp(
  item: OutboxItem,
): { kind: 'pushSavedCourse' | 'deleteSavedCourse'; userId: string; courseId: string } | undefined {
  if (item.kind === 'pushSavedCourse') {
    const p = item.payload as PushSavedCoursePayload
    return { kind: item.kind, userId: p.userId, courseId: p.course.id }
  }
  if (item.kind === 'deleteSavedCourse') {
    const p = item.payload as DeleteSavedCoursePayload
    return { kind: item.kind, userId: p.userId, courseId: p.courseId }
  }
  return undefined
}

export interface MetaEntry {
  key: string
  value: string
}

/**
 * One user keeping one course. THE library is this table, not `courses`.
 *
 * `courses` is shared course DATA — the same scorecard serves everyone who
 * plays there, so it carries no owner and never has. Which courses are YOURS is
 * a different fact, and an owned one: it has to follow you between devices, and
 * it must not leak to whoever signs in on your phone next. Conflating the two
 * is what made the first attempt at MAI-76 upload one person's library into
 * another person's account.
 */
export interface SavedCourse {
  userId: string
  courseId: string
  /** when this user saved it — the LWW clock for membership, not for the card */
  updatedAt: string
}

export class GolfDB extends Dexie {
  courses!: Table<Course, string>
  players!: Table<Player, string>
  rounds!: Table<Round, string>
  round_events!: Table<RoundEvent, [string, number]>
  outbox!: Table<OutboxItem, string>
  meta!: Table<MetaEntry, string>
  saved_courses!: Table<SavedCourse, [string, string]>

  constructor(name = 'golf') {
    super(name)
    this.version(1).stores({
      courses: 'id, name, updatedAt',
      players: 'id, name',
      rounds: 'id, status, startedAt',
      round_events: '[roundId+seq], id, roundId',
      outbox: 'id, createdAt',
      meta: 'key',
    })
    // v2: owner partitioning. Add `[userId+…]` compound indexes to the two
    // ownable tables and backfill existing rows to the guest sentinel so they
    // stay visible signed-out (and can be claimed on first sign-in). Only the
    // changed tables are re-declared; Dexie inherits the rest from v1.
    this.version(2)
      .stores({
        players: 'id, name, [userId+name]',
        rounds: 'id, status, startedAt, [userId+startedAt]',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Player>('players')
          .toCollection()
          .modify((p) => {
            p.userId ??= LOCAL_USER
          })
        await tx
          .table<Round>('rounds')
          .toCollection()
          .modify((r) => {
            r.userId ??= LOCAL_USER
          })
      })
    // v3: the saved library becomes owned (MAI-76). Membership moves out of
    // "the card is in `courses`" and into its own table so it can be scoped to
    // a user and synced. Existing cards backfill to the guest sentinel — this
    // device cannot know WHO saved them — and ride the claim prompt (which
    // counts courses) into whichever account explicitly accepts them. There
    // is deliberately NO silent adoption of the pre-upgrade library: an
    // automatic claim stamps fresh membership clocks over the account's
    // tombstones and resurrects courses removed on other devices, with no
    // consent shown. Ben pre-approved dropping it ("I can easily just add
    // back my courses") and the prompt covers the same migration, opted-in.
    this.version(3)
      .stores({ saved_courses: '[userId+courseId], userId, courseId' })
      .upgrade(async (tx) => {
        const ids = (await tx.table('courses').toCollection().primaryKeys()) as string[]
        const now = new Date().toISOString()
        await tx
          .table<SavedCourse>('saved_courses')
          .bulkPut(ids.map((id) => ({ userId: LOCAL_USER, courseId: id, updatedAt: now })))
      })
  }
}

export const db = new GolfDB()

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
    // "it's in `courses`" and into its own table, so it can be scoped to a user
    // and synced. Existing rows backfill to the guest sentinel — the same move
    // v2 made for rounds and players, and for the same reason: this device
    // cannot know WHO saved them, so they stay visible signed-out and the
    // claim prompt offers to move them into the account.
    this.version(3)
      .stores({ saved_courses: '[userId+courseId], userId, courseId' })
      .upgrade(async (tx) => {
        const courses = await tx.table<Course>('courses').toArray()
        const now = new Date().toISOString()
        await tx.table<SavedCourse>('saved_courses').bulkPut(
          courses.map((c) => ({ userId: LOCAL_USER, courseId: c.id, updatedAt: now })),
        )
      })
  }
}

export const db = new GolfDB()

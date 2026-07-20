import Dexie, { type Table } from 'dexie'
import type { RoundEvent } from '../engine/core/events'
import type { Course, Player, Round } from '../engine/core/types'
import { LOCAL_USER } from './ids'

export interface OutboxItem {
  id: string
  /** Owner-scoped cloud sync ops; each payload carries its own userId. */
  kind: 'pushRound' | 'pushPlayer' | 'deleteRound' | 'deletePlayer'
  payload: unknown
  createdAt: string
  attempts: number
}

export interface MetaEntry {
  key: string
  value: string
}

export class GolfDB extends Dexie {
  courses!: Table<Course, string>
  players!: Table<Player, string>
  rounds!: Table<Round, string>
  round_events!: Table<RoundEvent, [string, number]>
  outbox!: Table<OutboxItem, string>
  meta!: Table<MetaEntry, string>

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
  }
}

export const db = new GolfDB()

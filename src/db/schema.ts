import Dexie, { type Table } from 'dexie'
import type { RoundEvent } from '../engine/core/events'
import type { Course, Player, Round } from '../engine/core/types'

export interface OutboxItem {
  id: string
  kind: 'archiveRound' | 'upsertCourse'
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
  }
}

export const db = new GolfDB()

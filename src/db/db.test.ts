import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import '../engine/games/index'
import { deriveRound } from '../engine/catalog'
import { makePlayers, makeRound } from '../engine/test/harness'
import type { Course, Round, RoundStatus } from '../engine/core/types'
import { EventStore } from './eventStore'
import { LOCAL_USER, newId, resetDeviceIdCache } from './ids'
import { CourseRepo, PlayerRepo, RoundRepo } from './repos'
import { GolfDB } from './schema'
import { pruneSeededCourses } from './seed'

let testDbCounter = 0
let currentDbName = ''

/** Dexie captures the IDB factory at import time, so isolation comes from unique DB names. */
function freshDb(): GolfDB {
  resetDeviceIdCache()
  currentDbName = `golf-test-${++testDbCounter}`
  return new GolfDB(currentDbName)
}

describe('EventStore', () => {
  let db: GolfDB

  beforeEach(() => {
    db = freshDb()
  })

  it('assigns monotonic seq across separate appends', async () => {
    const store = new EventStore(db)
    const [e1] = await store.append('r1', [
      { type: 'score/set', playerId: 'p1', hole: 1, gross: 4 },
    ])
    const more = await store.append('r1', [
      { type: 'score/set', playerId: 'p2', hole: 1, gross: 5 },
      { type: 'score/set', playerId: 'p1', hole: 2, gross: 3 },
    ])
    expect(e1!.seq).toBe(1)
    expect(more.map((e) => e.seq)).toEqual([2, 3])
  })

  it('keeps per-round sequences independent', async () => {
    const store = new EventStore(db)
    await store.append('r1', [{ type: 'score/set', playerId: 'p1', hole: 1, gross: 4 }])
    const [e] = await store.append('r2', [
      { type: 'score/set', playerId: 'p1', hole: 1, gross: 4 },
    ])
    expect(e!.seq).toBe(1)
  })

  it('serializes concurrent appends without seq collisions', async () => {
    const store = new EventStore(db)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.append('r1', [{ type: 'score/set', playerId: `p${i}`, hole: 1, gross: 4 }]),
      ),
    )
    const seqs = results.flat().map((e) => e.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const stored = await store.list('r1')
    expect(stored).toHaveLength(10)
    expect(stored.map((e) => e.seq)).toEqual(seqs)
  })

  it('rejects invalid drafts', async () => {
    const store = new EventStore(db)
    await expect(
      store.append('r1', [{ type: 'score/set', playerId: 'p1', hole: 99, gross: 4 }]),
    ).rejects.toThrow()
  })

  it('round state survives a reload (fresh DB connection, same storage)', async () => {
    const store = new EventStore(db)
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    await db.rounds.put(round)
    await store.append(round.id, [
      { type: 'score/set', playerId: 'p-a', hole: 1, gross: 3 },
      { type: 'score/set', playerId: 'p-b', hole: 1, gross: 4 },
    ])
    const before = deriveRound(round, await store.list(round.id))

    db.close()
    const db2 = new GolfDB(currentDbName) // same backing storage, fresh connection
    const store2 = new EventStore(db2)
    const reloadedRound = await db2.rounds.get(round.id)
    const after = deriveRound(reloadedRound!, await store2.list(round.id))

    expect(after.derivations.get('game-1')!.settlement).toEqual(
      before.derivations.get('game-1')!.settlement,
    )
    expect(after.derivations.get('game-1')!.settlement.perPlayerCents).toEqual({
      'p-a': 100,
      'p-b': -100,
    })
  })
})

const U1 = 'user-1'
const U2 = 'user-2'

function roundRow(userId: string, status: RoundStatus, startedAt: string): Round {
  return {
    id: newId(),
    courseId: 'c',
    courseSnapshot: { id: 'c' } as Round['courseSnapshot'],
    teeSetId: 't',
    holes: 'full18',
    players: [],
    games: [],
    status,
    startedAt,
    updatedAt: startedAt,
    deviceId: '',
    schemaVersion: 1,
    userId,
  }
}

describe('PlayerRepo', () => {
  it('remembers index + course handicap a player teed off with', async () => {
    const repo = new PlayerRepo(freshDb())
    const ben = await repo.upsertByName(U1, 'Ben')
    await repo.rememberHandicap(ben.id, 7.4, 8)

    const again = await repo.upsertByName(U1, 'Ben')
    expect(again.id).toBe(ben.id)
    expect(again.handicapIndex).toBe(7.4)
    expect(again.lastCourseHandicap).toBe(8)
  })

  it('isolates the roster by userId', async () => {
    const repo = new PlayerRepo(freshDb())
    const ben1 = await repo.upsertByName(U1, 'Ben')
    const ben2 = await repo.upsertByName(U2, 'Ben')
    expect(ben1.id).not.toBe(ben2.id)
    // same (owner, name) reuses; different owner is a distinct row
    expect((await repo.upsertByName(U1, 'Ben')).id).toBe(ben1.id)
    expect(await repo.list(U1)).toHaveLength(1)
    expect(await repo.list(U2)).toHaveLength(1)
  })

  it('creates, updates, and deletes a roster player', async () => {
    const repo = new PlayerRepo(freshDb())
    const p = await repo.create(U1, 'Rob', 8.1)
    expect(p.handicapIndex).toBe(8.1)
    expect(p.userId).toBe(U1)
    await repo.update(p.id, { name: 'Robert', handicapIndex: 9 })
    const updated = await repo.get(p.id)
    expect(updated?.name).toBe('Robert')
    expect(updated?.handicapIndex).toBe(9)
    await repo.delete(p.id)
    expect(await repo.get(p.id)).toBeUndefined()
    expect(await repo.list(U1)).toHaveLength(0)
  })
})

describe('RoundRepo', () => {
  it('scopes listRecent + liveRound by userId', async () => {
    const repo = new RoundRepo(freshDb())
    await repo.put(roundRow(U1, 'live', '2026-01-01T00:00:00Z'))
    await repo.put(roundRow(U1, 'completed', '2026-01-02T00:00:00Z'))
    await repo.put(roundRow(U2, 'live', '2026-01-03T00:00:00Z'))

    expect(await repo.listRecent(U1)).toHaveLength(2)
    expect(await repo.listRecent(U2)).toHaveLength(1)
    // most-recent first within the owner
    expect((await repo.listRecent(U1))[0]!.startedAt).toBe('2026-01-02T00:00:00Z')

    expect((await repo.liveRound(U1))?.userId).toBe(U1)
    expect((await repo.liveRound(U2))?.userId).toBe(U2)
    // no userId → any live round on the device (UpdateToast suppression)
    expect(await repo.liveRound()).toBeDefined()
  })

  it('adjusts a course handicap only while the event log is empty', async () => {
    const db = freshDb()
    const repo = new RoundRepo(db)
    const store = new EventStore(db)
    const r = { ...roundRow(U1, 'live', '2026-01-01T00:00:00Z'), players: makePlayers([{ name: 'Bogey', ch: 18 }]) }
    await repo.put(r)

    expect(await repo.setCourseHandicap(r.id, 'p-bogey', 10)).toBe(true)
    expect((await repo.get(r.id))!.players[0]!.courseHandicap).toBe(10)

    // once a score exists the handicap is settled money — the write must lose,
    // not silently re-derive every hole already played (CLAUDE.md invariant #2)
    await store.append(r.id, [{ type: 'score/set', playerId: 'p-bogey', hole: 1, gross: 5 }])
    expect(await repo.setCourseHandicap(r.id, 'p-bogey', 2)).toBe(false)
    expect((await repo.get(r.id))!.players[0]!.courseHandicap).toBe(10)

    expect(await repo.setCourseHandicap('no-such-round', 'p-bogey', 4)).toBe(false)
  })

  it('hard-deletes a round and its event log in one transaction', async () => {
    const db = freshDb()
    const repo = new RoundRepo(db)
    const store = new EventStore(db)
    const r = roundRow(U1, 'completed', '2026-01-01T00:00:00Z')
    await repo.put(r)
    await store.append(r.id, [{ type: 'score/set', playerId: 'p1', hole: 1, gross: 4 }])
    expect(await store.list(r.id)).toHaveLength(1)

    await repo.delete(r.id)
    expect(await repo.get(r.id)).toBeUndefined()
    expect(await store.list(r.id)).toHaveLength(0)
  })
})

describe('v1 → v2 migration', () => {
  it('backfills userId to the guest sentinel for pre-auth rows', async () => {
    const name = `golf-mig-${++testDbCounter}`
    const v1 = new Dexie(name)
    v1.version(1).stores({
      courses: 'id, name, updatedAt',
      players: 'id, name',
      rounds: 'id, status, startedAt',
      round_events: '[roundId+seq], id, roundId',
      outbox: 'id, createdAt',
      meta: 'key',
    })
    await v1.open()
    await v1.table('players').put({ id: 'p1', name: 'Ben', updatedAt: 't' })
    await v1.table('rounds').put({ id: 'r1', status: 'completed', startedAt: 't' })
    v1.close()

    const db = new GolfDB(name)
    await db.open() // triggers the 1 → 2 upgrade
    expect((await db.players.get('p1'))?.userId).toBe(LOCAL_USER)
    expect((await db.rounds.get('r1'))?.userId).toBe(LOCAL_USER)
    // backfilled rows are now visible through the owner-scoped indexes
    expect(await new PlayerRepo(db).list(LOCAL_USER)).toHaveLength(1)
    expect(await new RoundRepo(db).listRecent(LOCAL_USER)).toHaveLength(1)
    db.close()
  })
})

function makeCourse(id: string, source: Course['source']): Course {
  return {
    id,
    name: `Course ${id}`,
    holeCount: 18,
    holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 })),
    teeSets: [{ id: 'tee-white', name: 'White', rating: 70, slope: 120 }],
    source,
    updatedAt: '2026-07-20T00:00:00.000Z',
    revision: 0,
  }
}

describe('CourseRepo', () => {
  it('saves, reads, and deletes a course from the library', async () => {
    const repo = new CourseRepo(freshDb())
    await repo.put(makeCourse('c1', 'user'))
    await repo.put(makeCourse('c2', 'remote'))
    expect(await repo.get('c1')).toBeDefined()
    expect(await repo.list()).toHaveLength(2)

    await repo.delete('c1')
    expect(await repo.get('c1')).toBeUndefined()
    expect((await repo.list()).map((c) => c.id)).toEqual(['c2'])
  })
})

describe('pruneSeededCourses', () => {
  it('removes pristine seed courses, keeps user/remote, and is a one-shot', async () => {
    const db = freshDb()
    await db.courses.bulkPut([
      makeCourse('seed-1', 'seed'),
      makeCourse('seed-2', 'seed'),
      makeCourse('picked', 'remote'), // cached from search
      makeCourse('mine', 'user'), // hand-created (or an edited seed)
    ])

    await pruneSeededCourses(db)
    const after = await db.courses.toArray()
    expect(after.map((c) => c.id).sort()).toEqual(['mine', 'picked'])

    // gated by a meta flag: a later stray seed row isn't re-pruned
    await db.courses.put(makeCourse('seed-late', 'seed'))
    await pruneSeededCourses(db)
    expect(await db.courses.get('seed-late')).toBeDefined()
  })
})

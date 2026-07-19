import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import '../engine/games/index'
import { deriveRound } from '../engine/catalog'
import { makePlayers, makeRound } from '../engine/test/harness'
import { EventStore } from './eventStore'
import { resetDeviceIdCache } from './ids'
import { GolfDB } from './schema'
import { seedCourses } from './seed'

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

describe('PlayerRepo', () => {
  it('remembers index + course handicap a player teed off with', async () => {
    const db = freshDb()
    const { PlayerRepo } = await import('./repos')
    const repo = new PlayerRepo(db)
    const ben = await repo.upsertByName('Ben')
    await repo.rememberHandicap(ben.id, 7.4, 8)

    const again = await repo.upsertByName('Ben')
    expect(again.id).toBe(ben.id)
    expect(again.handicapIndex).toBe(7.4)
    expect(again.lastCourseHandicap).toBe(8)
  })
})

describe('seedCourses', () => {
  it('is idempotent and never clobbers user edits', async () => {
    const db = freshDb()
    await seedCourses(db)
    const first = await db.courses.toArray()
    expect(first.length).toBeGreaterThan(0)

    // user edits a seeded course
    const edited = { ...first[0]!, name: 'My Edited Course', source: 'user' as const }
    await db.courses.put(edited)

    // re-seed (e.g. after SEED_VERSION bump) must not clobber it
    await db.meta.delete('seedVersion')
    await seedCourses(db)
    const after = await db.courses.get(edited.id)
    expect(after?.name).toBe('My Edited Course')
  })
})

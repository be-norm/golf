import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import '../engine/games/index'
import { deriveRound } from '../engine/catalog'
import { makePlayers, makeRound } from '../engine/test/harness'
import type { Course, Round, RoundStatus } from '../engine/core/types'
import { EventStore } from './eventStore'
import { LOCAL_USER, newId, resetDeviceIdCache } from './ids'
import { CourseRepo, ownsCourse, PlayerRepo, RoundRepo } from './repos'
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

describe('→ v3 migration (saved library becomes owned, MAI-76)', () => {
  function v1Db(name: string): Dexie {
    const v1 = new Dexie(name)
    v1.version(1).stores({
      courses: 'id, name, updatedAt',
      players: 'id, name',
      rounds: 'id, status, startedAt',
      round_events: '[roundId+seq], id, roundId',
      outbox: 'id, createdAt',
      meta: 'key',
    })
    return v1
  }

  it('backfills membership for existing cards to the guest sentinel', async () => {
    const name = `golf-mig-${++testDbCounter}`
    const v1 = v1Db(name)
    await v1.open()
    await v1.table('courses').put(makeCourse('c-pre', 'remote'))
    v1.close()

    const db = new GolfDB(name)
    await db.open()
    // the device can't know WHO saved it, so it lands guest and rides the
    // claim prompt (which counts courses) — deliberately no silent adoption
    expect(await db.saved_courses.get([LOCAL_USER, 'c-pre'])).toBeDefined()
    expect(await new CourseRepo(db).list(LOCAL_USER)).toHaveLength(1)
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
  const A = 'user-a'
  const B = 'user-b'

  /**
   * The consent property (MAI-76). Course data is shared, but "these are MY
   * courses" is owned — a friend signing in on your phone must not see, or
   * later upload, your library.
   */
  it('scopes the library per user on a shared device', async () => {
    const repo = new CourseRepo(freshDb())
    await repo.save(A, makeCourse('mine', 'user'))
    await repo.save(B, makeCourse('theirs', 'user'))

    expect((await repo.list(A)).map((c) => c.id)).toEqual(['mine'])
    expect((await repo.list(B)).map((c) => c.id)).toEqual(['theirs'])
    // reads-by-id stay unscoped — the id is the capability
    expect(await repo.get('theirs')).toBeDefined()
  })

  it('two users keep the same course; one removing it leaves the other, and the card', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(A, makeCourse('shared', 'remote'))
    await repo.save(B, makeCourse('shared', 'remote'))

    await repo.remove(A, 'shared')
    expect(await repo.list(A)).toHaveLength(0)
    expect((await repo.list(B)).map((c) => c.id)).toEqual(['shared'])
    expect(await repo.get('shared')).toBeDefined()
  })

  it('GCs the cached card when the LAST membership on the device goes', async () => {
    const repo = new CourseRepo(freshDb())
    await repo.save(A, makeCourse('c1', 'remote'))
    await repo.remove(A, 'c1')
    // no library references it any more — an unbounded courses cache is what
    // eventually triggers the iOS quota eviction that takes live rounds along
    expect(await repo.get('c1')).toBeUndefined()
  })

  /**
   * THE regression from attempt two: membership wrote fine, and the push was
   * left to call sites that forgot. Now the outbox op is written in the same
   * transaction as the membership row, so it cannot be forgotten.
   */
  it('save enqueues the membership push atomically, carrying the MEMBERSHIP clock', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(A, makeCourse('c1', 'remote'))

    const ops = await db.outbox.toArray()
    expect(ops.map((o) => o.kind)).toEqual(['pushSavedCourse'])
    const payload = ops[0]!.payload as { userId: string; course: Course; savedAt: string }
    expect(payload.userId).toBe(A)
    expect(payload.course.id).toBe('c1')
    // savedAt is when THIS USER saved it — pushing the card's own stamp
    // instead was the wrong-clock finding from the last review
    const membership = await db.saved_courses.get([A, 'c1'])
    expect(payload.savedAt).toBe(membership!.updatedAt)
  })

  it('remove purges queued saves and queues the tombstone in one transaction', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(A, makeCourse('c1', 'remote'))
    await repo.remove(A, 'c1')

    // the queued push is gone (it could flush after the tombstone and
    // resurrect the row) and only the tombstone remains
    const ops = await db.outbox.toArray()
    expect(ops.map((o) => o.kind)).toEqual(['deleteSavedCourse'])
  })

  it('guests enqueue nothing — their library stays local until claimed', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(LOCAL_USER, makeCourse('c1', 'user'))
    await repo.remove(LOCAL_USER, 'c1')
    expect(await db.outbox.count()).toBe(0)
  })

  it('applyRemote* never enqueue — they ARE the sync', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.applyRemoteSave(A, makeCourse('c1', 'remote'), '2026-08-01T00:00:00.000Z')
    expect(await db.saved_courses.get([A, 'c1'])).toBeDefined()
    await repo.applyRemoteRemoval(A, 'c1', '2026-08-02T00:00:00.000Z')
    expect(await db.saved_courses.get([A, 'c1'])).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  it('a tombstone loses to a membership saved after it (LWW)', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.applyRemoteSave(A, makeCourse('c1', 'remote'), '2026-08-03T00:00:00.000Z')
    await repo.applyRemoteRemoval(A, 'c1', '2026-08-02T00:00:00.000Z')
    expect(await db.saved_courses.get([A, 'c1'])).toBeDefined()
  })

  /**
   * Timestamps cross two encodings: local stamps end `Z`, Postgres returns
   * `+00:00`. The SAME instant must compare equal — a string comparison calls
   * `…Z` newer than `…+00:00` and would keep a membership a simultaneous
   * removal should take (a review finding on the last attempt).
   */
  it('compares timestamps as instants across encodings', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.applyRemoteSave(A, makeCourse('c1', 'remote'), '2026-08-01T12:00:01.500Z')
    await repo.applyRemoteRemoval(A, 'c1', '2026-08-01T12:00:01.500000+00:00')
    expect(await db.saved_courses.get([A, 'c1'])).toBeUndefined()
  })

  it('applyRemoteSave defers to a pending local tombstone (pull racing a removal)', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(A, makeCourse('c1', 'remote'))
    await repo.remove(A, 'c1')
    // the tombstone hasn't flushed; the server still has the old live row
    await repo.applyRemoteSave(A, makeCourse('c1', 'remote'), '2026-08-01T00:00:00.000Z')
    expect(await db.saved_courses.get([A, 'c1'])).toBeUndefined()
  })

  it('applyRemoteSave keeps a newer local card over an older remote copy', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    const local = await repo.save(A, { ...makeCourse('c1', 'user'), name: 'Fixed SIs' })
    await repo.applyRemoteSave(
      A,
      { ...makeCourse('c1', 'user'), name: 'Stale', updatedAt: '2020-01-01T00:00:00.000Z' },
      '2020-01-01T00:00:00.000Z',
    )
    expect((await repo.get('c1'))?.name).toBe(local.name)
  })

  it('claim re-keys the guest library to the account and queues its pushes', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(LOCAL_USER, makeCourse('c1', 'remote'))
    expect(await repo.claim(A)).toBe(1)

    expect(await db.saved_courses.get([LOCAL_USER, 'c1'])).toBeUndefined()
    expect(await db.saved_courses.get([A, 'c1'])).toBeDefined()
    const ops = await db.outbox.toArray()
    expect(ops.map((o) => o.kind)).toEqual(['pushSavedCourse'])
    expect((ops[0]!.payload as { userId: string }).userId).toBe(A)
  })

  it('claim re-stamps guest authorship BEFORE freezing push payloads', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(LOCAL_USER, { ...makeCourse('c1', 'user'), createdBy: LOCAL_USER })
    await repo.claim(A)

    // one transaction, authorship first: a payload frozen with '@local' made
    // the user's OTHER devices fork their own course on edit (review finding)
    const ops = await db.outbox.toArray()
    const membership = ops.find((o) => o.kind === 'pushSavedCourse')!
    expect((membership.payload as { course: Course }).course.createdBy).toBe(A)
    const publish = ops.find((o) => o.kind === 'pushCourse')!
    expect((publish.payload as { course: Course }).course.createdBy).toBe(A)
    expect((await db.courses.get('c1'))?.createdBy).toBe(A)
  })

  it('fork lands the new card and retires the original in ONE transaction', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(A, { ...makeCourse('orig', 'remote') })
    await db.outbox.clear()

    const fork = await repo.fork(A, 'orig', {
      ...makeCourse('fork-1', 'user'),
      createdBy: A,
      sourceId: 'orig',
    })

    expect(fork.id).toBe('fork-1')
    expect((await repo.list(A)).map((c) => c.id)).toEqual(['fork-1'])
    // the original's card is GC'd (nothing references it), and its tombstone
    // is queued together with the fork's membership push AND its shared-
    // library publish — a crash can't leave the library holding both rows,
    // or a saved fork that never publishes
    expect(await repo.get('orig')).toBeUndefined()
    const kinds = (await db.outbox.toArray()).map((o) => o.kind).sort()
    expect(kinds).toEqual(['deleteSavedCourse', 'pushCourse', 'pushSavedCourse'])
  })

  it('a fresh save supersedes a removal still queued on this device', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await repo.save(A, makeCourse('c1', 'remote'))
    await repo.remove(A, 'c1')
    await repo.save(A, makeCourse('c1', 'remote'))

    // the tombstone is purged rather than racing the new push to the server —
    // the newest local intent is the only thing left to flush
    const ops = await db.outbox.toArray()
    expect(ops.map((o) => o.kind)).toEqual(['pushSavedCourse'])
  })

  it('a retry-capped tombstone no longer vetoes the course coming back', async () => {
    const db = freshDb()
    const repo = new CourseRepo(db)
    await db.outbox.put({
      id: 'dead-op',
      kind: 'deleteSavedCourse',
      payload: { userId: A, courseId: 'c1', removedAt: '2026-08-01T00:00:00.000Z' },
      createdAt: '2026-08-01T00:00:00.000Z',
      attempts: 10, // permanently failed — will never flush
    })
    await repo.applyRemoteSave(A, makeCourse('c1', 'remote'), '2026-08-02T00:00:00.000Z')
    // an op that can never flush must not suppress this course forever
    expect(await db.saved_courses.get([A, 'c1'])).toBeDefined()
  })
})

describe('ownsCourse (the MAI-78 fork-vs-update decision)', () => {
  const base = makeCourse('11111111-2222-7333-8444-555555555555', 'user')

  it('keys on createdBy when present', () => {
    expect(ownsCourse({ ...base, createdBy: 'me' }, 'me')).toBe(true)
    expect(ownsCourse({ ...base, createdBy: 'someone-else' }, 'me')).toBe(false)
    // the guest sentinel is an identity like any other — signing in does not
    // make unclaimed guest cards yours
    expect(ownsCourse({ ...base, createdBy: LOCAL_USER }, 'me')).toBe(false)
    expect(ownsCourse({ ...base, createdBy: LOCAL_USER }, LOCAL_USER)).toBe(true)
  })

  it('an orphaned author (account deleted) is never yours', () => {
    expect(ownsCourse({ ...base, createdBy: '@orphaned' }, 'me')).toBe(false)
  })

  it('legacy source:user cards are yours only with a locally-minted (v7) id', () => {
    // authored here pre-createdBy: newId() has only ever minted UUIDv7
    expect(ownsCourse(base, 'me')).toBe(true)
    // main's editor rewrote EDITED API imports to source:'user' too — their
    // provider ids give them away, and treating them as yours pushes onto a
    // shared row RLS refuses (the exact MAI-78 failure, review finding)
    expect(ownsCourse({ ...base, id: 'gca:9' }, 'me')).toBe(false)
    expect(ownsCourse({ ...base, id: '11111111-2222-4333-8444-555555555555' }, 'me')).toBe(false)
  })

  it('non-user sources are never yours without createdBy', () => {
    expect(ownsCourse(makeCourse('11111111-2222-7333-8444-555555555555', 'remote'), 'me')).toBe(
      false,
    )
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

    // boot order isn't guaranteed: adoption may already have claimed a seed's
    // membership and queued its push — prune must take those with the card, or
    // the flushed push re-adds the seed to the account's library on next pull
    await db.saved_courses.put({ userId: 'user-a', courseId: 'seed-1', updatedAt: 't' })
    await db.outbox.put({
      id: newId(),
      kind: 'pushSavedCourse',
      payload: { userId: 'user-a', course: makeCourse('seed-1', 'seed'), savedAt: 't' },
      createdAt: 't',
      attempts: 0,
    })

    await pruneSeededCourses(db)
    const after = await db.courses.toArray()
    expect(after.map((c) => c.id).sort()).toEqual(['mine', 'picked'])
    expect(await db.saved_courses.where('courseId').equals('seed-1').count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)

    // gated by a meta flag: a later stray seed row isn't re-pruned
    await db.courses.put(makeCourse('seed-late', 'seed'))
    await pruneSeededCourses(db)
    expect(await db.courses.get('seed-late')).toBeDefined()
  })
})

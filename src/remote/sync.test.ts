import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Course, Round } from '../engine/core/types'
import { db } from '../db/schema'
import { LOCAL_USER, newId } from '../db/ids'
import { roundRepo } from '../db/repos'

// In-memory Supabase double supporting exactly the chains outbox/sync use:
//   from(t).upsert(v, {onConflict})           → merge by conflict cols
//   from(t).update(p).eq(c,v).eq(c,v)         → patch matching rows
//   from(t).select('…').eq('user_id', uid)    → filtered rows
const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const tables: { round_archives: Row[]; players: Row[]; saved_courses: Row[] } = {
    round_archives: [],
    players: [],
    saved_courses: [],
  }
  function from(table: string) {
    const rows =
      table === 'players'
        ? tables.players
        : table === 'saved_courses'
          ? tables.saved_courses
          : tables.round_archives
    return {
      upsert(values: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
        const cols = (opts?.onConflict ?? 'id').split(',')
        // saved_courses pushes the whole library in one call
        for (const v of Array.isArray(values) ? values : [values]) {
          const i = rows.findIndex((r) => cols.every((c) => r[c] === v[c]))
          if (i >= 0) rows[i] = { ...rows[i], ...v } // merge keeps unset cols (e.g. deleted_at)
          else rows.push({ ...v })
        }
        return Promise.resolve({ error: null })
      },
      update(patch: Record<string, unknown>) {
        const filters: [string, unknown][] = []
        const b = {
          eq(c: string, v: unknown) {
            filters.push([c, v])
            return b
          },
          then(res: (r: { error: null }) => void) {
            for (const r of rows) if (filters.every(([c, v]) => r[c] === v)) Object.assign(r, patch)
            res({ error: null })
          },
        }
        return b
      },
      select(cols?: string) {
        void cols
        const filters: [string, unknown][] = []
        const b = {
          eq(c: string, v: unknown) {
            filters.push([c, v])
            return b
          },
          then(res: (r: { data: Record<string, unknown>[]; error: null }) => void) {
            res({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null })
          },
        }
        return b
      },
    }
  }
  return {
    tables,
    from,
    reset() {
      tables.round_archives = []
      tables.players = []
      tables.saved_courses = []
    },
  }
})

vi.mock('./supabase', () => ({ supabase: { from: fake.from } }))

const {
  enqueuePushRound,
  enqueueDeleteRound,
  enqueuePushSavedCourse,
  enqueueDeleteSavedCourse,
  flushOutbox,
} = await import('./outbox')
const { pull, syncNow, claimLocalData, countLocalGuestData } = await import('./sync')

const U = 'user-1'
function setOnline(v: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })
}

// Deterministically drive the outbox to empty. Enqueue fires a best-effort
// flush; under full-suite load its fake-indexeddb ops can outlast a single
// macrotask, so loop flush-then-check rather than waiting a fixed tick.
async function drain() {
  for (let i = 0; i < 50; i++) {
    await flushOutbox()
    if ((await db.outbox.count()) === 0) return
    await new Promise((r) => setTimeout(r, 0))
  }
}

function round(userId: string, status: Round['status'], id: string, updatedAt: string): Round {
  return {
    id,
    courseId: 'c',
    courseSnapshot: { id: 'c' } as Round['courseSnapshot'],
    teeSetId: 't',
    holes: 'full18',
    players: [],
    games: [],
    status,
    startedAt: updatedAt,
    updatedAt,
    deviceId: '',
    schemaVersion: 1,
    userId,
  }
}

beforeEach(async () => {
  fake.reset()
  setOnline(true)
  await Promise.all([
    db.rounds.clear(),
    db.players.clear(),
    db.round_events.clear(),
    db.outbox.clear(),
    db.courses.clear(),
    db.saved_courses.clear(),
  ])
})

describe('push', () => {
  it('is idempotent — one canonical row per (owner, round)', async () => {
    const r = round(U, 'completed', 'r1', '2026-01-01T00:00:00Z')
    await enqueuePushRound(U, r)
    await drain()
    expect(fake.tables.round_archives).toHaveLength(1)

    await enqueuePushRound(U, r)
    await drain()
    expect(fake.tables.round_archives).toHaveLength(1)
    expect(fake.tables.round_archives[0]!.round_id).toBe('r1')
  })
})

describe('pull', () => {
  it('restores newer remote rounds and keeps newer local (LWW)', async () => {
    const r = round(U, 'completed', 'r1', '2026-02-01T00:00:00Z')
    fake.tables.round_archives.push({
      id: 'r1',
      user_id: U,
      round_id: 'r1',
      device_id: 'd',
      data: { round: r, events: [] },
      updated_at: r.updatedAt,
    })
    await pull(U)
    expect((await roundRepo.get('r1'))?.updatedAt).toBe('2026-02-01T00:00:00Z')

    // local now strictly newer than the (unchanged, older) remote → keep local
    await db.rounds.put({ ...r, updatedAt: '2026-03-01T00:00:00Z' })
    await pull(U)
    expect((await roundRepo.get('r1'))?.updatedAt).toBe('2026-03-01T00:00:00Z')
  })

  it('coerces a numeric handicap (PostgREST returns numeric as a string)', async () => {
    fake.tables.players.push({
      id: 'p1',
      user_id: U,
      name: 'Ben',
      handicap_index: '12.4', // numeric-as-string, as the wire actually delivers it
      last_course_handicap: 8,
      updated_at: '2026-01-01T00:00:00Z',
    })
    await pull(U)
    const p = await db.players.get('p1')
    expect(p?.handicapIndex).toBe(12.4)
    expect(typeof p?.handicapIndex).toBe('number')
  })

  it('applies a tombstone by deleting the local round', async () => {
    await db.rounds.put(round(U, 'completed', 'r1', '2026-01-01T00:00:00Z'))
    fake.tables.round_archives.push({
      id: 'r1',
      user_id: U,
      round_id: 'r1',
      device_id: 'd',
      data: {},
      updated_at: 't',
      deleted_at: '2026-01-02T00:00:00Z',
    })
    await pull(U)
    expect(await roundRepo.get('r1')).toBeUndefined()
  })
})

describe('delete safety', () => {
  it('purges a queued push when its delete is enqueued (no resurrection)', async () => {
    setOnline(false) // keep items queued so we can inspect the outbox
    const r = round(U, 'completed', 'r1', 't')
    await enqueuePushRound(U, r)
    expect((await db.outbox.toArray()).filter((i) => i.kind === 'pushRound')).toHaveLength(1)

    await enqueueDeleteRound(U, 'r1')
    const items = await db.outbox.toArray()
    expect(items.filter((i) => i.kind === 'pushRound')).toHaveLength(0)
    expect(items.filter((i) => i.kind === 'deleteRound')).toHaveLength(1)
  })

  it('a stray push never clears an existing tombstone', async () => {
    const r = round(U, 'completed', 'r1', 't')
    fake.tables.round_archives.push({
      id: 'r1',
      user_id: U,
      round_id: 'r1',
      device_id: 'd',
      data: {},
      updated_at: 't',
      deleted_at: 'DEAD',
    })
    await db.outbox.put({
      id: newId(),
      kind: 'pushRound',
      payload: { userId: U, round: r, events: [] },
      createdAt: 't',
      attempts: 0,
    })
    await drain()
    expect(fake.tables.round_archives.find((x) => x.round_id === 'r1')?.deleted_at).toBe('DEAD')
  })
})

describe('claim', () => {
  it('rewrites guest data to the owner and pushes completed rounds + roster', async () => {
    await db.rounds.put(round(LOCAL_USER, 'completed', 'gr1', 'g1'))
    await db.rounds.put(round(LOCAL_USER, 'live', 'gr2', 'g2'))
    await db.players.put({ id: 'gp1', userId: LOCAL_USER, name: 'Ben', updatedAt: 'g' })

    // courses counted too — the prompt must name everything it will claim
    expect(await countLocalGuestData()).toEqual({ rounds: 2, players: 1, courses: 0 })

    const res = await claimLocalData(U)
    await drain()
    expect(res).toEqual({ rounds: 2, players: 1 })

    expect((await roundRepo.get('gr1'))?.userId).toBe(U)
    expect((await db.players.get('gp1'))?.userId).toBe(U)
    expect(await countLocalGuestData()).toEqual({ rounds: 0, players: 0, courses: 0 })

    // only the completed guest round is pushed; the live one stays local
    expect(fake.tables.round_archives.map((r) => r.round_id)).toEqual(['gr1'])
    expect(fake.tables.players.map((p) => p.id)).toEqual(['gp1'])
  })
})

/**
 * The saved library is user data, not device data (MAI-76). Saving a course
 * used to mean saving it on THAT PHONE: `pull` restored rounds and players and
 * nothing else, so clearing storage brought the rounds back to an empty course
 * list.
 */
describe('saved courses', () => {
  const course = (
    id: string,
    name: string,
    updatedAt: string,
    source: Course['source'] = 'remote',
  ): Course => ({
    id,
    name,
    holeCount: 18,
    holes: [],
    teeSets: [],
    source,
    updatedAt,
    revision: 1,
  })

  async function saveAndPush(userId: string, c: Course) {
    await db.courses.put(c)
    await db.saved_courses.put({ userId, courseId: c.id, updatedAt: c.updatedAt })
    await enqueuePushSavedCourse(userId, c)
    await drain()
  }

  it('restores the library on a device that has never seen it', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))

    // the storage-cleared / new-phone case
    await Promise.all([db.courses.clear(), db.saved_courses.clear()])
    await pull(U)

    expect((await db.saved_courses.toArray()).map((s) => s.courseId)).toEqual(['c1'])
    expect((await db.courses.get('c1'))?.name).toBe('Broadmoor')
  })

  it('carries the full scorecard, so a course missing from the shared library still restores', async () => {
    const scanned = {
      ...course('c-scan', 'Muni Nobody Has', '2026-08-01T00:00:00Z', 'user'),
      holes: [{ number: 1, par: 4, strokeIndex: 1 }],
      teeSets: [{ id: 't', name: 'White', rating: 70, slope: 120 }],
    }
    await saveAndPush(U, scanned)
    await Promise.all([db.courses.clear(), db.saved_courses.clear()])
    await pull(U)

    const restored = await db.courses.get('c-scan')
    expect(restored?.holes).toHaveLength(1)
    expect(restored?.teeSets[0]?.name).toBe('White')
  })

  it('a non-uuid provider id round-trips (GolfCourseAPI mints `gca:` ids)', async () => {
    await saveAndPush(U, course('gca:9', 'Namespaced', '2026-08-01T00:00:00Z'))
    await Promise.all([db.courses.clear(), db.saved_courses.clear()])
    await pull(U)
    expect((await db.saved_courses.toArray()).map((s) => s.courseId)).toEqual(['gca:9'])
  })

  it('a removal propagates instead of the course coming back', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await db.saved_courses.delete([U, 'c1'])
    await enqueueDeleteSavedCourse(U, 'c1')
    await drain()

    await pull(U)
    expect(await db.saved_courses.get([U, 'c1'])).toBeUndefined()
  })

  /**
   * The multi-device case the whole feature exists for: a device that missed
   * the removal must not hand the course back to everyone.
   */
  it('a device that missed the removal does not resurrect the course', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await enqueueDeleteSavedCourse(U, 'c1')
    await drain()

    // this device still has membership locally and now syncs
    await syncNow(U)

    expect(await db.saved_courses.get([U, 'c1'])).toBeUndefined()
    const row = fake.tables.saved_courses.find((r) => r.course_id === 'c1')
    expect(row?.deleted_at).toBeTruthy()
  })

  it('re-saving a course after removing it beats the tombstone', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await enqueueDeleteSavedCourse(U, 'c1')
    await drain()

    // changed their mind: a newer save than the deletion
    await saveAndPush(U, course('c1', 'Broadmoor', '2099-01-01T00:00:00Z'))
    await pull(U)

    expect(await db.saved_courses.get([U, 'c1'])).toBeDefined()
  })

  it('one user removing a shared course leaves another user\'s copy alone', async () => {
    await db.courses.put(course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await db.saved_courses.bulkPut([
      { userId: U, courseId: 'c1', updatedAt: '2026-08-01T00:00:00Z' },
      { userId: 'other', courseId: 'c1', updatedAt: '2026-08-01T00:00:00Z' },
    ])
    await enqueuePushSavedCourse(U, course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await drain()
    await enqueueDeleteSavedCourse(U, 'c1')
    await drain()
    await pull(U)

    expect(await db.saved_courses.get([U, 'c1'])).toBeUndefined()
    expect(await db.saved_courses.get(['other', 'c1'])).toBeDefined()
  })

  it('stays local for a guest — nothing is pushed while signed out', async () => {
    await db.courses.put(course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await db.saved_courses.put({ userId: LOCAL_USER, courseId: 'c1', updatedAt: '2026-08-01T00:00:00Z' })
    await syncNow(LOCAL_USER)
    expect(fake.tables.saved_courses).toHaveLength(0)
  })

  it('claiming guest data re-keys the library to the account and pushes it', async () => {
    await db.courses.put(course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await db.saved_courses.put({ userId: LOCAL_USER, courseId: 'c1', updatedAt: '2026-08-01T00:00:00Z' })
    await claimLocalData(U)
    await drain()

    expect(await db.saved_courses.get([LOCAL_USER, 'c1'])).toBeUndefined()
    expect(await db.saved_courses.get([U, 'c1'])).toBeDefined()
    expect(fake.tables.saved_courses.map((r) => r.course_id)).toEqual(['c1'])
  })
})

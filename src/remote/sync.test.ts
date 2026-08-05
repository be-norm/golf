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
  enqueueDeleteSavedCourse,
  flushOutbox,
} = await import('./outbox')
const { pull, pushSavedCourses, claimLocalData, countLocalGuestData } = await import('./sync')

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

    expect(await countLocalGuestData()).toEqual({ rounds: 2, players: 1 })

    const res = await claimLocalData(U)
    await drain()
    expect(res).toEqual({ rounds: 2, players: 1 })

    expect((await roundRepo.get('gr1'))?.userId).toBe(U)
    expect((await db.players.get('gp1'))?.userId).toBe(U)
    expect(await countLocalGuestData()).toEqual({ rounds: 0, players: 0 })

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
  const course = (id: string, name: string, updatedAt: string, source: Course['source'] = 'remote') => ({
    id,
    name,
    holeCount: 18 as const,
    holes: [],
    teeSets: [],
    source,
    updatedAt,
    revision: 1,
  })

  it('restores the library on a device that has never seen it', async () => {
    await db.courses.bulkPut([course('c1', 'Broadmoor', '2026-08-01T00:00:00Z')])
    await pushSavedCourses(U)

    // the storage-cleared / new-phone case: local is empty, the account is not
    await db.courses.clear()
    await pull(U)

    expect((await db.courses.toArray()).map((c) => c.name)).toEqual(['Broadmoor'])
  })

  it('carries the full scorecard, so a course missing from the shared library still restores', async () => {
    // scanned by hand and never published — nothing in `courses` to point at,
    // which is why saved_courses copies the data rather than holding an FK
    const scanned = {
      ...course('c-scan', 'Muni Nobody Has', '2026-08-01T00:00:00Z', 'user'),
      holes: [{ number: 1, par: 4, strokeIndex: 1 }],
      teeSets: [{ id: 't', name: 'White', rating: 70, slope: 120 }],
    }
    await db.courses.put(scanned)
    await pushSavedCourses(U)
    await db.courses.clear()
    await pull(U)

    const restored = await db.courses.get('c-scan')
    expect(restored?.holes).toHaveLength(1)
    expect(restored?.teeSets[0]?.name).toBe('White')
  })

  it('a removal propagates instead of the course coming back', async () => {
    await db.courses.put(course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await pushSavedCourses(U)

    // remove it here, exactly as the editor does
    await db.courses.delete('c1')
    await enqueueDeleteSavedCourse(U, 'c1')
    await drain()

    await pull(U)
    expect(await db.courses.get('c1')).toBeUndefined()
  })

  it('keeps a newer local edit over an older remote copy (LWW)', async () => {
    await db.courses.put(course('c1', 'Old Name', '2026-08-01T00:00:00Z'))
    await pushSavedCourses(U)

    await db.courses.put(course('c1', 'Corrected Name', '2026-08-02T00:00:00Z'))
    await pull(U)

    expect((await db.courses.get('c1'))?.name).toBe('Corrected Name')
  })

  it('stays local for a guest — nothing is pushed while signed out', async () => {
    await db.courses.put(course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await pushSavedCourses(LOCAL_USER)
    expect(fake.tables.saved_courses).toHaveLength(0)
  })

  it('claiming guest data takes the library with it', async () => {
    await db.courses.put(course('c1', 'Broadmoor', '2026-08-01T00:00:00Z'))
    await claimLocalData(U)
    expect(fake.tables.saved_courses.map((r) => r.course_id)).toEqual(['c1'])
  })
})

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Round } from '../engine/core/types'
import { db } from '../db/schema'
import { LOCAL_USER, newId } from '../db/ids'
import { roundRepo } from '../db/repos'

// In-memory Supabase double supporting exactly the chains outbox/sync use:
//   from(t).upsert(v, {onConflict})           → merge by conflict cols
//   from(t).update(p).eq(c,v).eq(c,v)         → patch matching rows
//   from(t).select('…').eq('user_id', uid)    → filtered rows
const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const tables: { round_archives: Row[]; players: Row[] } = { round_archives: [], players: [] }
  function from(table: string) {
    const rows = table === 'players' ? tables.players : tables.round_archives
    return {
      upsert(values: Record<string, unknown>, opts?: { onConflict?: string }) {
        const cols = (opts?.onConflict ?? 'id').split(',')
        const i = rows.findIndex((r) => cols.every((c) => r[c] === values[c]))
        if (i >= 0) rows[i] = { ...rows[i], ...values } // merge keeps unset cols (e.g. deleted_at)
        else rows.push({ ...values })
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
    },
  }
})

vi.mock('./supabase', () => ({ supabase: { from: fake.from } }))

const {
  enqueuePushRound,
  enqueueDeleteRound,
  flushOutbox,
} = await import('./outbox')
const { pull, claimLocalData, countLocalGuestData } = await import('./sync')

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
  await Promise.all([db.rounds.clear(), db.players.clear(), db.round_events.clear(), db.outbox.clear()])
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

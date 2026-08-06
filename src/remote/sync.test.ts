import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Course, Round } from '../engine/core/types'
import { db } from '../db/schema'
import { LOCAL_USER, newId } from '../db/ids'
import { courseRepo, roundRepo } from '../db/repos'

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
      upsert(
        values: Record<string, unknown>,
        opts?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) {
        const cols = (opts?.onConflict ?? 'id').split(',')
        const i = rows.findIndex((r) => cols.every((c) => r[c] === values[c]))
        if (i >= 0) {
          // resolution=ignore-duplicates leaves the existing row untouched
          if (!opts?.ignoreDuplicates) rows[i] = { ...rows[i], ...values } // merge keeps unset cols (e.g. deleted_at)
        } else rows.push({ ...values })
        return Promise.resolve({ error: null })
      },
      update(patch: Record<string, unknown>) {
        const filters: [string, unknown][] = []
        const lte: [string, string][] = []
        const b = {
          eq(c: string, v: unknown) {
            filters.push([c, v])
            return b
          },
          lte(c: string, v: unknown) {
            lte.push([c, v as string])
            return b
          },
          then(res: (r: { error: null }) => void) {
            for (const r of rows) {
              if (
                filters.every(([c, v]) => r[c] === v) &&
                // timestamptz comparison, as Postgres would do it
                lte.every(([c, v]) => Date.parse(r[c] as string) <= Date.parse(v))
              ) {
                Object.assign(r, patch)
              }
            }
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
    signedIn: true,
    // whose session the flush runs under — ops for anyone else must wait
    sessionUserId: 'user-1',
    reset() {
      tables.round_archives = []
      tables.players = []
      tables.saved_courses = []
      this.signedIn = true
      this.sessionUserId = 'user-1'
    },
  }
})

// flushOutbox refuses to run signed-out (owner-scoped ops can't succeed as
// anon, and a 0-row tombstone UPDATE would read as success) — the fake is
// permanently signed in unless a test overrides it.
vi.mock('./supabase', () => ({
  supabase: {
    from: fake.from,
    auth: {
      getSession: () =>
        Promise.resolve({
          data: { session: fake.signedIn ? { user: { id: fake.sessionUserId } } : null },
        }),
    },
  },
}))

const {
  enqueuePushRound,
  enqueueDeleteRound,
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
    db.meta.clear(),
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
    expect(res).toEqual({ rounds: 2, players: 1, courses: 0 })

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
 * nothing else, so clearing storage brought the round history back to an empty
 * course list. These tests are all multi-device: "another device" is simulated
 * by clearing the local Dexie tables while the fake server keeps its rows.
 */
describe('saved courses', () => {
  const course = (
    id: string,
    name: string,
    source: Course['source'] = 'remote',
    extra: Partial<Course> = {},
  ): Course => ({
    id,
    name,
    holeCount: 18,
    holes: [],
    teeSets: [],
    source,
    updatedAt: '2026-08-01T00:00:00.000Z',
    revision: 0,
    ...extra,
  })

  /** Save through the one write path and flush — what a real device does. */
  async function saveAndPush(userId: string, c: Course): Promise<Course> {
    const stored = await courseRepo.save(userId, c)
    await drain()
    return stored
  }

  /** Simulate signing in on a different (or storage-cleared) device. */
  async function freshDevice() {
    await Promise.all([db.courses.clear(), db.saved_courses.clear(), db.outbox.clear()])
  }

  it('restores the library — with full scorecards — on a device that has never seen it', async () => {
    await saveAndPush(U, {
      ...course('c-scan', 'Muni Nobody Has', 'user'),
      holes: [{ number: 1, par: 4, strokeIndex: 1 }],
      teeSets: [{ id: 't', name: 'White', rating: 70, slope: 120 }],
    })

    await freshDevice()
    await pull(U)

    // the card came from saved_courses.data itself — this course exists in no
    // shared library (scanned cards never do), so a foreign key would have
    // had nothing to restore from
    const restored = await db.courses.get('c-scan')
    expect(restored?.holes).toHaveLength(1)
    expect(restored?.teeSets[0]?.name).toBe('White')
    expect(await db.saved_courses.get([U, 'c-scan'])).toBeDefined()
  })

  it('round-trips a non-uuid provider id (GolfCourseAPI mints `gca:` ids)', async () => {
    // the REAL guard is saved_courses.course_id being text — a uuid column
    // rejected `gca:9` and, pushed as one array upsert, silently killed the
    // entire library's sync (attempt one); this pins the id arriving verbatim
    await saveAndPush(U, course('gca:9', 'Namespaced'))
    expect(fake.tables.saved_courses.map((r) => r.course_id)).toEqual(['gca:9'])

    await freshDevice()
    await pull(U)
    expect((await courseRepo.list(U)).map((c) => c.id)).toEqual(['gca:9'])
  })

  it('pushes the MEMBERSHIP clock, not the card’s own stamp', async () => {
    await courseRepo.save(LOCAL_USER, course('c1', 'Broadmoor'))
    // age the CARD: last edited long ago — but the user claims it TODAY, and
    // it is the claim that must win LWW against e.g. an old tombstone. The
    // last attempt pushed the card's stamp as the membership clock, so every
    // LWW decision downstream compared the wrong event.
    await db.courses.update('c1', { updatedAt: '2020-01-01T00:00:00.000Z' })
    await claimLocalData(U)
    await drain()

    const row = fake.tables.saved_courses[0]!
    expect(row.updated_at).not.toBe('2020-01-01T00:00:00.000Z')
    // …while the card inside `data` keeps its own, older stamp
    expect((row.data as Course).updatedAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('a removal propagates to a device that missed it', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor'))
    // device B learns about the course
    await freshDevice()
    await pull(U)
    expect(await db.saved_courses.get([U, 'c1'])).toBeDefined()

    // device A (simulated by direct repo calls) removes it; B still has it
    await courseRepo.remove(U, 'c1')
    await drain()
    await db.saved_courses.put({ userId: U, courseId: 'c1', updatedAt: '2026-08-01T00:00:00.000Z' })
    await db.courses.put(course('c1', 'Broadmoor'))

    await syncNow(U)
    expect(await db.saved_courses.get([U, 'c1'])).toBeUndefined()
    // the tombstone row stays server-side for the NEXT stale device
    expect(fake.tables.saved_courses[0]!.deleted_at).toBeTruthy()
  })

  /**
   * The forever-tombstone defect from the last review: the tombstone gate
   * compared against LOCAL membership, which a fresh device doesn't have, so
   * remove-then-re-save stayed dead on every other device forever. The gate is
   * now deleted_at >= updated_at on the row itself.
   */
  it('re-saving after a removal beats the tombstone — including on a fresh device', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor'))
    await courseRepo.remove(U, 'c1')
    await drain()

    // changed their mind. The pause matters: a tombstone row has
    // deleted_at == updated_at, so LWW ties go to the removal — the re-save
    // must actually be LATER, which outside a test it always is.
    await new Promise((r) => setTimeout(r, 5))
    await saveAndPush(U, course('c1', 'Broadmoor'))

    await freshDevice()
    await pull(U)
    expect(await db.saved_courses.get([U, 'c1'])).toBeDefined()
  })

  it('a plain tombstone stays dead on a fresh device', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor'))
    await courseRepo.remove(U, 'c1')
    await drain()

    await freshDevice()
    await pull(U)
    expect(await db.saved_courses.get([U, 'c1'])).toBeUndefined()
  })

  it('a pull racing an un-flushed removal does not resurrect the course', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor'))
    await courseRepo.remove(U, 'c1') // tombstone queued, NOT flushed
    await pull(U) // server still shows the course as live

    expect(await db.saved_courses.get([U, 'c1'])).toBeUndefined()
    await drain()
    await pull(U)
    expect(await db.saved_courses.get([U, 'c1'])).toBeUndefined()
  })

  it('an offline removal that flushes late does not kill a NEWER save from another device', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor'))
    // removal queued while offline — it will flush LATER than it happened
    await courseRepo.remove(U, 'c1')

    // meanwhile another device re-saves the course, after the removal
    await new Promise((r) => setTimeout(r, 5))
    Object.assign(fake.tables.saved_courses[0]!, { updated_at: new Date().toISOString() })

    await syncNow(U)

    // the tombstone carries the REMOVAL time and is lte-gated, so it matched
    // nothing (stamping it at flush time was a review finding: Monday's
    // removal, flushed Wednesday, would have killed Tuesday's save) — and the
    // pull hands the newer save back to this device
    expect(fake.tables.saved_courses[0]!.deleted_at).toBeFalsy()
    expect(await db.saved_courses.get([U, 'c1'])).toBeDefined()
  })

  it('two users keep the same course independently', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor'))
    // the second account pushes under ITS OWN session, as it would on-device
    fake.sessionUserId = 'user-2'
    await saveAndPush('user-2', course('c1', 'Broadmoor'))
    fake.sessionUserId = U
    await courseRepo.remove(U, 'c1')
    await drain()

    const rows = fake.tables.saved_courses
    expect(rows.find((r) => r.user_id === U)!.deleted_at).toBeTruthy()
    expect(rows.find((r) => r.user_id === 'user-2')!.deleted_at).toBeFalsy()
  })

  it("another account's queued ops wait — they are not burned under the wrong session", async () => {
    await saveAndPush(U, course('c1', 'Broadmoor'))
    await courseRepo.remove(U, 'c1') // tombstone queued for U

    // a different account signs in on this phone before the flush lands.
    // Under their session RLS filters U's rows, the UPDATE would match
    // nothing, read as success, and destroy the removal — so the op must
    // simply wait, with no attempt burned.
    fake.sessionUserId = 'someone-else'
    await flushOutbox()
    const queued = await db.outbox.toArray()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.attempts).toBe(0)
    expect(fake.tables.saved_courses[0]!.deleted_at).toBeFalsy()

    fake.sessionUserId = U
    await drain()
    expect(await db.outbox.count()).toBe(0)
    expect(fake.tables.saved_courses[0]!.deleted_at).toBeTruthy()
  })

  it('stays local for a guest — nothing is pushed while signed out', async () => {
    await courseRepo.save(LOCAL_USER, course('c1', 'Broadmoor'))
    await drain()
    await syncNow(LOCAL_USER)
    expect(fake.tables.saved_courses).toHaveLength(0)
  })

  it('claiming guest data re-keys the library to the account and pushes it', async () => {
    await courseRepo.save(LOCAL_USER, course('c1', 'Broadmoor'))
    expect(await countLocalGuestData()).toEqual({ rounds: 0, players: 0, courses: 1 })

    const res = await claimLocalData(U)
    await drain()

    expect(res.courses).toBe(1)
    expect(await db.saved_courses.get([LOCAL_USER, 'c1'])).toBeUndefined()
    expect(await db.saved_courses.get([U, 'c1'])).toBeDefined()
    expect(fake.tables.saved_courses.map((r) => r.course_id)).toEqual(['c1'])
  })

  it('claim publishes guest-authored cards under the account, not other users’ cards', async () => {
    // guest-authored cards carry the sentinel (the editor stamps activeUserId)
    await courseRepo.save(
      LOCAL_USER,
      course('mine', 'Scanned Muni', 'user', { createdBy: LOCAL_USER }),
    )
    await db.courses.put(course('theirs', 'Their Fork', 'user', { createdBy: 'someone-else' }))

    await claimLocalData(U)
    await drain()

    expect((await db.courses.get('mine'))?.createdBy).toBe(U)
    expect((await db.courses.get('theirs'))?.createdBy).toBe('someone-else')
    // the authorship travels INSIDE the pushed card too: re-stamping after
    // the payload snapshot shipped '@local' to the server, and the user's
    // other devices then forked their own course on edit (review finding)
    const pushed = fake.tables.saved_courses.find((r) => r.course_id === 'mine')!
    expect((pushed.data as Course).createdBy).toBe(U)
  })

  it('a stale queued push flushing late cannot rewind a newer save or revive a tombstone flip', async () => {
    // the course was removed, then deliberately re-saved — row is LIVE
    await saveAndPush(U, course('c1', 'Broadmoor'))
    await courseRepo.remove(U, 'c1')
    await drain()
    await new Promise((r) => setTimeout(r, 5))
    const fresh = await saveAndPush(U, course('c1', 'Broadmoor'))

    // another device's push from BEFORE all of that finally flushes
    await db.outbox.put({
      id: newId(),
      kind: 'pushSavedCourse',
      payload: {
        userId: U,
        course: { ...course('c1', 'Stale Name'), updatedAt: '2020-01-01T00:00:00.000Z' },
        savedAt: '2020-01-01T00:00:00.000Z',
      },
      createdAt: '2020-01-01T00:00:00.000Z',
      attempts: 0,
    })
    await drain()

    // ungated, this rewound updated_at below the standing deleted_at — the
    // row read as REMOVED again and the data regressed to the stale card
    const row = fake.tables.saved_courses[0]!
    expect(row.updated_at).toBe(fresh.updatedAt)
    expect((row.data as Course).name).toBe('Broadmoor')
    expect(Date.parse(row.deleted_at as string)).toBeLessThan(Date.parse(row.updated_at as string))
  })

  it('does not flush while signed out — a tombstone must wait, not be destroyed', async () => {
    await saveAndPush(U, course('c1', 'Broadmoor'))
    await courseRepo.remove(U, 'c1')

    // signed out: RLS would filter every row, the UPDATE would match nothing,
    // and "success" would destroy the removal — so the flush must not run
    fake.signedIn = false
    await flushOutbox()
    expect(await db.outbox.count()).toBe(1)
    expect(fake.tables.saved_courses[0]!.deleted_at).toBeFalsy()

    fake.signedIn = true
    await drain()
    expect(await db.outbox.count()).toBe(0)
    expect(fake.tables.saved_courses[0]!.deleted_at).toBeTruthy()
  })
})

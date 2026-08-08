import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { Course } from '../engine/core/types'

// Importing the module pulls in ./supabase (createClient at load) — stub it so
// the test doesn't need real env. `from()` supports the two chains this module
// uses: select().eq().single() (importFromLibrary, row set per test) and
// select().or().order().order().limit() (librarySearch, recording the .or()
// argument so the quoting test can inspect it).
const remote = vi.hoisted(() => ({
  courseRow: null as { data: unknown; created_by: string | null } | null,
  lastOr: null as string | null,
}))
vi.mock('./supabase', () => ({
  supabase: {
    from: () => {
      const chain = {
        eq: () => ({
          single: () =>
            Promise.resolve(
              remote.courseRow
                ? { data: remote.courseRow, error: null }
                : { data: null, error: { message: 'not found' } },
            ),
        }),
        or: (arg: string) => {
          remote.lastOr = arg
          return chain
        },
        order: () => chain,
        limit: () => Promise.resolve({ data: [], error: null }),
      }
      return { select: () => chain }
    },
  },
}))

import {
  golfApiName,
  groupCourseHits,
  importCourseHit,
  isDoubledNine,
  mergeCourseHits,
  searchCourses,
  type CourseSearchHit,
} from './courseSearch'
import { db } from '../db/schema'
import { LOCAL_USER, ORPHANED_AUTHOR } from '../db/ids'

describe('isDoubledNine (GolfCourseAPI 9-hole stored as 18)', () => {
  const nine = [281, 355, 139, 298, 208, 436, 342, 162, 361].map((yardage) => ({ par: 4, yardage }))
  it('detects the nine played twice (front == back)', () => {
    expect(isDoubledNine([...nine, ...nine])).toBe(true)
  })
  it('is false for a genuine 18 with distinct nines', () => {
    const rows = Array.from({ length: 18 }, (_, i) => ({ par: 4, yardage: 300 + i }))
    expect(isDoubledNine(rows)).toBe(false)
  })
  it('is false when not exactly 18 rows', () => {
    expect(isDoubledNine(nine)).toBe(false)
  })
})

describe('golfApiName', () => {
  it('uses a single name when club == course', () => {
    expect(golfApiName('Penmar Municipal Golf Course', 'Penmar Municipal Golf Course')).toBe(
      'Penmar Municipal Golf Course',
    )
  })
  it('joins club and course when they differ', () => {
    expect(golfApiName('Broadmoor', 'East Course')).toBe('Broadmoor — East Course')
  })
  it('falls back to whichever side is present', () => {
    expect(golfApiName(undefined, 'X')).toBe('X')
    expect(golfApiName('Y', undefined)).toBe('Y')
    expect(golfApiName('', '  ')).toBe('')
  })
})

const hit = (
  id: string,
  name: string,
  location: string,
  origin: CourseSearchHit['origin'],
  source?: CourseSearchHit['source'],
  extra: { createdBy?: string; updatedAt?: string } = {},
): CourseSearchHit => ({ id, name, location, origin, source, ...extra })

/** a golfer's published version of a course (MAI-78 fork) */
const community = (id: string, name: string, location: string, createdBy: string, updatedAt: string) =>
  hit(id, name, location, 'library', 'user', { createdBy, updatedAt })

describe('mergeCourseHits (flatten + precedence)', () => {
  it('dedupes by id, keeping the higher-precedence source', () => {
    const merged = mergeCourseHits({
      library: [hit('dup', 'A', 'X', 'library')],
      golfcourseapi: [hit('dup', 'B', 'Y', 'golfcourseapi')],
      opengolfapi: [],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0]!.origin).toBe('library')
  })

  it('orders library, then GolfCourseAPI, then OpenGolfAPI', () => {
    const merged = mergeCourseHits({
      library: [hit('lib-1', 'A', 'X', 'library')],
      golfcourseapi: [hit('gca:1', 'B', 'Y', 'golfcourseapi')],
      opengolfapi: [hit('og-1', 'C', 'Z', 'opengolfapi')],
    })
    expect(merged.map((h) => h.origin)).toEqual(['library', 'golfcourseapi', 'opengolfapi'])
  })

  it('no longer drops a same-name hit — that dropped the golfer fork MAI-79 exists to offer', () => {
    // the API card and a golfer's correction of it share a normalized
    // name+location; the old first-wins key dedupe deleted the correction here
    const merged = mergeCourseHits({
      library: [
        hit('lib-api', 'Broadmoor Country Club', 'Indianapolis, IN', 'library', 'remote'),
        community('lib-fork', 'Broadmoor Country Club', 'Indianapolis, IN', 'ann', '2026-07-12T12:00:00.000Z'),
      ],
      golfcourseapi: [],
      opengolfapi: [],
    })
    expect(merged).toHaveLength(2)
  })
})

describe('groupCourseHits (one result per place, versions on demand — MAI-79)', () => {
  const ME = 'me-uid'

  it('offers the library card and its golfer fork as two versions of one result', () => {
    const groups = groupCourseHits(
      mergeCourseHits({
        library: [community('lib-1', 'Broadmoor Country Club', 'Indianapolis, IN', 'ann', '2026-07-12T12:00:00.000Z')],
        golfcourseapi: [hit('gca:9', 'Broadmoor Country Club', 'Indianapolis, IN', 'golfcourseapi')],
        opengolfapi: [hit('og-1', 'Broadmoor Country Club', 'Indianapolis, IN', 'opengolfapi')],
      }),
      ME,
    )
    expect(groups).toHaveLength(1)
    // the two API rows are the same card off different shelves — one version,
    // library precedence… except there is no library API row here, so gca wins
    expect(groups[0]!.versions.map((v) => [v.kind, v.id])).toEqual([
      ['community', 'lib-1'],
      ['api', 'gca:9'],
    ])
    // the collapsed row reads the top-ranked version's name/location
    expect(groups[0]!.name).toBe('Broadmoor Country Club')
    expect(groups[0]!.location).toBe('Indianapolis, IN')
  })

  it('collapses the two API directories into ONE api version, keeping precedence', () => {
    // different punctuation/casing/spacing must still normalize to one course
    const groups = groupCourseHits(
      mergeCourseHits({
        library: [],
        golfcourseapi: [hit('gca:1', 'Penmar Golf Course', 'Venice, CA', 'golfcourseapi')],
        opengolfapi: [hit('og-2', 'Penmar  golf course', 'venice, ca', 'opengolfapi')],
      }),
      ME,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.versions).toHaveLength(1)
    expect(groups[0]!.versions[0]!.kind).toBe('api')
    expect(groups[0]!.versions[0]!.id).toBe('gca:1')
  })

  it('prefers the library copy of an API card over both live directories', () => {
    const groups = groupCourseHits(
      mergeCourseHits({
        library: [hit('lib-1', 'Penmar Golf Course', 'Venice, CA', 'library', 'remote')],
        golfcourseapi: [hit('gca:1', 'Penmar Golf Course', 'Venice, CA', 'golfcourseapi')],
        opengolfapi: [hit('og-2', 'Penmar Golf Course', 'Venice, CA', 'opengolfapi')],
      }),
      ME,
    )
    expect(groups[0]!.versions).toHaveLength(1)
    expect(groups[0]!.versions[0]!.id).toBe('lib-1')
  })

  it('ranks MY version first even when a stranger published a newer one', () => {
    const groups = groupCourseHits(
      [
        community('theirs', 'Penmar', 'Venice, CA', 'ann', '2026-08-01T12:00:00.000Z'),
        community('mine', 'Penmar', 'Venice, CA', ME, '2026-01-01T12:00:00.000Z'),
        hit('gca:1', 'Penmar', 'Venice, CA', 'golfcourseapi'),
      ],
      ME,
    )
    expect(groups[0]!.versions.map((v) => v.id)).toEqual(['mine', 'theirs', 'gca:1'])
    expect(groups[0]!.versions[0]!.mine).toBe(true)
    expect(groups[0]!.versions[1]!.mine).toBe(false)
    // the collapsed row takes its label from the version it's offering
    expect(groups[0]!.name).toBe('Penmar')
  })

  it("orders other golfers' versions newest first, breaking ties on id", () => {
    const groups = groupCourseHits(
      [
        community('c', 'Penmar', 'Venice, CA', 'ann', '2026-01-01T12:00:00.000Z'),
        community('b', 'Penmar', 'Venice, CA', 'bob', '2026-06-01T12:00:00.000Z'),
        community('a', 'Penmar', 'Venice, CA', 'cal', '2026-06-01T12:00:00.000Z'),
      ],
      ME,
    )
    // b and a share an instant, so the id tie-break decides — and decides the
    // same way every time, which is what "the same search twice" requires
    expect(groups[0]!.versions.map((v) => v.id)).toEqual(['a', 'b', 'c'])
  })

  it('compares stamps as instants, not strings (Z vs +00:00)', () => {
    // the same moment, written both ways: local stamps end Z, Postgres returns
    // +00:00, and a string sort would put the offset form first every time
    const groups = groupCourseHits(
      [
        community('older', 'Penmar', 'Venice, CA', 'ann', '2026-01-01T00:00:00+00:00'),
        community('newer', 'Penmar', 'Venice, CA', 'bob', '2026-06-01T00:00:00.000Z'),
      ],
      ME,
    )
    expect(groups[0]!.versions.map((v) => v.id)).toEqual(['newer', 'older'])
  })

  it('sorts an undated version last rather than putting NaN in the comparator', () => {
    const groups = groupCourseHits(
      [
        hit('undated', 'Penmar', 'Venice, CA', 'library', 'user', { createdBy: 'ann' }),
        community('dated', 'Penmar', 'Venice, CA', 'bob', '2026-06-01T12:00:00.000Z'),
      ],
      ME,
    )
    expect(groups[0]!.versions.map((v) => v.id)).toEqual(['dated', 'undated'])
  })

  it('keeps genuinely different courses in the same town apart', () => {
    const groups = groupCourseHits(
      [
        hit('lib-1', 'Pebble Beach', 'Pebble Beach, CA', 'library'),
        hit('gca:2', 'Spyglass Hill', 'Pebble Beach, CA', 'golfcourseapi'),
      ],
      ME,
    )
    expect(groups).toHaveLength(2)
  })

  it('keeps the same course name in different towns apart', () => {
    const groups = groupCourseHits(
      [
        hit('a', 'Municipal Golf Course', 'Carmel, IN', 'library'),
        hit('b', 'Municipal Golf Course', 'Carmel, CA', 'library'),
      ],
      ME,
    )
    expect(groups).toHaveLength(2)
  })

  it('never groups location-less hits — a bare name is not evidence of one place', () => {
    // merging two real courses is the worse failure (MAI-79), and without a
    // town every "Municipal" on earth would fuse into a single row
    const groups = groupCourseHits(
      [hit('a', 'Municipal', '', 'library'), hit('b', 'Municipal', '', 'library')],
      ME,
    )
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.key)).toEqual(['id:a', 'id:b'])
  })

  it('makes a version state its own name when it differs from the group label', () => {
    // the key ignores punctuation, so these group — and the row has to say
    // which card it is rather than silently claiming the group's label
    const groups = groupCourseHits(
      [
        hit('api', 'Penmar Golf Course', 'Venice, CA', 'library', 'remote'),
        community('fork', 'Penmar  Golf-Course', 'Venice, CA', 'ann', '2026-06-01T12:00:00.000Z'),
      ],
      ME,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.name).toBe('Penmar  Golf-Course')
    expect(groups[0]!.versions.map((v) => v.name)).toEqual([
      'Penmar  Golf-Course',
      'Penmar Golf Course',
    ])
  })

  it('caps at 20 groups, in first-appearance order', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      hit(`og-${i}`, `Course ${i}`, 'Town, ST', 'opengolfapi'),
    )
    const groups = groupCourseHits(many, ME)
    expect(groups).toHaveLength(20)
    expect(groups[0]!.name).toBe('Course 0')
    expect(groups[19]!.name).toBe('Course 19')
  })

  it('owns nothing as a guest, and never calls an unauthored card mine', () => {
    const groups = groupCourseHits(
      [
        community('theirs', 'Penmar', 'Venice, CA', 'ann', '2026-06-01T12:00:00.000Z'),
        // author deleted their account: created_by is null → undefined here.
        // Without the non-empty guard this would match a viewer of undefined.
        hit('orphan', 'Penmar', 'Venice, CA', 'library', 'user'),
        hit('gca:1', 'Penmar', 'Venice, CA', 'golfcourseapi'),
      ],
      LOCAL_USER,
    )
    expect(groups[0]!.versions.every((v) => !v.mine)).toBe(true)
  })

  it('is idempotent — the same hits group identically twice', () => {
    const hits = [
      community('b', 'Penmar', 'Venice, CA', 'ann', '2026-06-01T12:00:00.000Z'),
      hit('gca:1', 'Penmar', 'Venice, CA', 'golfcourseapi'),
      hit('lib-2', 'Rancho Park', 'Los Angeles, CA', 'library'),
    ]
    expect(groupCourseHits(hits, ME)).toEqual(groupCourseHits(hits, ME))
  })
})

/**
 * Search→add is the primary way a course enters the library, and BOTH failed
 * attempts at MAI-76 shipped with these paths not syncing (membership written,
 * push forgotten — or neither). The enqueue now lives inside courseRepo.save,
 * so importing at all is what makes it sync; this pins that.
 */
describe('importCourseHit (library origin)', () => {
  it('records membership AND queues its push', async () => {
    await Promise.all([db.courses.clear(), db.saved_courses.clear(), db.outbox.clear()])
    const published: Course = {
      id: 'lib-1',
      name: 'Broadmoor Country Club',
      holeCount: 18,
      holes: [],
      teeSets: [],
      source: 'user',
      updatedAt: '2026-08-01T00:00:00.000Z',
      revision: 3,
    }
    remote.courseRow = { data: published, created_by: 'author-uid' }

    const course = await importCourseHit('user-1', {
      id: 'lib-1',
      name: 'Broadmoor Country Club',
      location: 'Indianapolis, IN',
      origin: 'library',
      source: 'user',
    })

    expect(await db.saved_courses.get(['user-1', 'lib-1'])).toBeDefined()
    expect((await db.outbox.toArray()).map((o) => o.kind)).toEqual(['pushSavedCourse'])
    // provenance survives the import (the MAI-77 mark must not flip on save)…
    expect(course.source).toBe('user')
    // …and ownership travels separately: this is the author's course, so an
    // edit here forks instead of pushing onto a row RLS refuses (MAI-78)
    expect(course.createdBy).toBe('author-uid')
  })

  it('marks a golfer course whose author deleted their account as orphaned, not mine', async () => {
    await Promise.all([db.courses.clear(), db.saved_courses.clear(), db.outbox.clear()])
    const published: Course = {
      id: 'lib-orphan',
      name: 'Orphaned Muni',
      holeCount: 18,
      holes: [],
      teeSets: [],
      source: 'user',
      updatedAt: '2026-08-01T00:00:00.000Z',
      revision: 1,
    }
    // courses.created_by is `on delete set null` — the author is gone
    remote.courseRow = { data: published, created_by: null }

    const course = await importCourseHit('user-1', {
      id: 'lib-orphan',
      name: 'Orphaned Muni',
      location: '',
      origin: 'library',
      source: 'user',
    })

    // NOT undefined: on a source:'user' card, undefined means "legacy card
    // authored on this device — yours", and an orphan misread as yours would
    // update in place and push onto a NULL-created_by row RLS refuses forever
    expect(course.createdBy).toBe(ORPHANED_AUTHOR)
    expect(course.createdBy).not.toBe('user-1')
  })

  it('throws (and saves nothing) when the library row is gone', async () => {
    await Promise.all([db.courses.clear(), db.saved_courses.clear(), db.outbox.clear()])
    remote.courseRow = null
    await expect(
      importCourseHit('user-1', {
        id: 'lib-gone',
        name: 'X',
        location: '',
        origin: 'library',
      }),
    ).rejects.toThrow()
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('librarySearch query quoting', () => {
  it('quotes the pattern so City, ST punctuation cannot corrupt the .or() filter', async () => {
    // PostgREST parses .or() as a logic tree: an unquoted comma splits the
    // pattern into a bogus extra condition and the library results silently
    // vanish (reproduced live with 'Carmel, IN' — the app's own display
    // format). Both live APIs are stubbed offline so only librarySearch runs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    try {
      await searchCourses('Carmel, IN', LOCAL_USER)
      expect(remote.lastOr).toBe('name.ilike."%Carmel, IN%",location.ilike."%Carmel, IN%"')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

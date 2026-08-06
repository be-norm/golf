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
  importCourseHit,
  isDoubledNine,
  mergeCourseHits,
  searchCourses,
  type CourseSearchHit,
} from './courseSearch'
import { db } from '../db/schema'
import { ORPHANED_AUTHOR } from '../db/ids'

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
): CourseSearchHit => ({ id, name, location, origin, source })

describe('mergeCourseHits (dedup + precedence)', () => {
  it('keeps the library copy over both APIs for the same course', () => {
    const merged = mergeCourseHits({
      library: [hit('lib-1', 'Broadmoor Country Club', 'Indianapolis, IN', 'library', 'user')],
      golfcourseapi: [hit('gca:9', 'Broadmoor Country Club', 'Indianapolis, IN', 'golfcourseapi')],
      opengolfapi: [hit('og-1', 'Broadmoor Country Club', 'Indianapolis, IN', 'opengolfapi')],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0]!.origin).toBe('library')
    expect(merged[0]!.source).toBe('user')
  })

  it('collapses the two APIs by normalized name+location, GolfCourseAPI winning', () => {
    // different punctuation/casing/spacing must still normalize to one course
    const merged = mergeCourseHits({
      library: [],
      golfcourseapi: [hit('gca:1', 'Penmar Golf Course', 'Venice, CA', 'golfcourseapi')],
      opengolfapi: [hit('og-2', 'Penmar  golf course', 'venice, ca', 'opengolfapi')],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0]!.origin).toBe('golfcourseapi')
  })

  it('keeps genuinely different courses in the same town', () => {
    const merged = mergeCourseHits({
      library: [hit('lib-1', 'Pebble Beach', 'Pebble Beach, CA', 'library')],
      golfcourseapi: [hit('gca:2', 'Spyglass Hill', 'Pebble Beach, CA', 'golfcourseapi')],
      opengolfapi: [],
    })
    expect(merged).toHaveLength(2)
  })

  it('dedupes by id too, keeping the higher-precedence source', () => {
    const merged = mergeCourseHits({
      library: [hit('dup', 'A', 'X', 'library')],
      golfcourseapi: [hit('dup', 'B', 'Y', 'golfcourseapi')],
      opengolfapi: [],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0]!.origin).toBe('library')
  })

  it('caps the merged list at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      hit(`og-${i}`, `Course ${i}`, 'Town, ST', 'opengolfapi'),
    )
    expect(mergeCourseHits({ library: [], golfcourseapi: [], opengolfapi: many })).toHaveLength(20)
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
      await searchCourses('Carmel, IN')
      expect(remote.lastOr).toBe('name.ilike."%Carmel, IN%",location.ilike."%Carmel, IN%"')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

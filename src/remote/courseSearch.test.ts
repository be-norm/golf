import { describe, expect, it, vi } from 'vitest'

// mergeCourseHits is pure, but importing the module pulls in ./supabase
// (createClient at load) — stub it so the test doesn't need real env.
vi.mock('./supabase', () => ({ supabase: {} }))

import { golfApiName, isDoubledNine, mergeCourseHits, type CourseSearchHit } from './courseSearch'

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

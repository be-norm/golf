import type { Course } from '../engine/core/types'
import { db as defaultDb, type GolfDB } from './schema'
import templatePar72 from '../../data/courses/template-par-72.json'

/** Bump when bundled courses change to re-run the seed. */
export const SEED_VERSION = 1

export const bundledCourses: Course[] = [templatePar72 as Course]

/**
 * Load bundled courses into Dexie on first run (idempotent).
 * Never overwrites a course the user has edited (source !== 'seed').
 */
export async function seedCourses(db: GolfDB = defaultDb): Promise<void> {
  const seeded = await db.meta.get('seedVersion')
  if (seeded && Number(seeded.value) >= SEED_VERSION) return

  await db.transaction('rw', db.courses, db.meta, async () => {
    for (const course of bundledCourses) {
      const existing = await db.courses.get(course.id)
      if (existing && existing.source !== 'seed') continue
      await db.courses.put(course)
    }
    await db.meta.put({ key: 'seedVersion', value: String(SEED_VERSION) })
  })
}

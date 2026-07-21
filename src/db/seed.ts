import { db as defaultDb, type GolfDB } from './schema'

/**
 * Courses are opt-in — nothing is pre-saved. A course is cached into the local
 * library only when the user picks it from search (importCourseHit) or creates
 * one. This one-time cleanup removes the previously auto-seeded "standard"
 * courses (including the "Template — Par 72" demo) from existing devices, but
 * only pristine seeds (`source === 'seed'`): a seed the user edited became
 * `user`/`remote` and is kept. Idempotent via a meta flag. Past rounds are
 * unaffected — each freezes its own `courseSnapshot` (invariant #4).
 */
export async function pruneSeededCourses(db: GolfDB = defaultDb): Promise<void> {
  if (await db.meta.get('coursesDeseeded')) return
  await db.transaction('rw', db.courses, db.meta, async () => {
    const seededIds = await db.courses.filter((c) => c.source === 'seed').primaryKeys()
    await db.courses.bulkDelete(seededIds)
    await db.meta.put({ key: 'coursesDeseeded', value: '1' })
  })
}

import { db as defaultDb, type GolfDB, type PushSavedCoursePayload } from './schema'

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
  await db.transaction('rw', [db.courses, db.saved_courses, db.outbox, db.meta], async () => {
    const seededIds = (await db.courses
      .filter((c) => c.source === 'seed')
      .primaryKeys()) as string[]
    await db.courses.bulkDelete(seededIds)
    // A device pruning and upgrading to v3 in the same boot backfilled guest
    // membership for these cards moments ago — drop it with them, for EVERY
    // owner: boot order against adoptDeviceLibrary isn't guaranteed, so a
    // signed-in launch may already have claimed them.
    for (const id of seededIds) {
      await db.saved_courses.where('courseId').equals(id).delete()
    }
    // …and if adoption already queued their pushes, purge those too, or a
    // flushed push re-adds the seed to the account's library on the next pull.
    const stale = await db.outbox
      .filter(
        (i) =>
          i.kind === 'pushSavedCourse' &&
          seededIds.includes((i.payload as PushSavedCoursePayload).course.id),
      )
      .primaryKeys()
    await db.outbox.bulkDelete(stale)
    await db.meta.put({ key: 'coursesDeseeded', value: '1' })
  })
}

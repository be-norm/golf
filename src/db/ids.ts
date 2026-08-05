import { uuidv7 } from 'uuidv7'
import type { GolfDB } from './schema'

/**
 * Owner partition key for signed-out ("guest") data. A stable string, NOT
 * undefined — IndexedDB omits undefined-keyed rows from compound indexes, so
 * guest rows must carry a real value to appear in `[userId+...]` queries. Can
 * never collide with a 36-char Supabase auth uid.
 */
export const LOCAL_USER = '@local'

/**
 * `Course.createdBy` marker for a library course whose author deleted their
 * account (`courses.created_by` is `on delete set null`). Distinct from
 * `undefined`, which on a source:'user' card means "authored on this device
 * before createdBy existed — yours": an orphan is NOT yours, and editing it
 * must fork (MAI-78), because the server row's NULL created_by fails the
 * update RLS for everyone.
 */
export const ORPHANED_AUTHOR = '@orphaned'

export function newId(): string {
  return uuidv7()
}

let cachedDeviceId: string | undefined

/** Stable per-install device id, minted on first use. */
export async function getDeviceId(db: GolfDB): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId
  const existing = await db.meta.get('deviceId')
  if (existing) {
    cachedDeviceId = existing.value
    return existing.value
  }
  const id = uuidv7()
  await db.meta.put({ key: 'deviceId', value: id })
  cachedDeviceId = id
  return id
}

/** Test-only: reset module cache between fresh databases. */
export function resetDeviceIdCache(): void {
  cachedDeviceId = undefined
}

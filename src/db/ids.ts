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

/**
 * True for ids this app minted (`newId` — always UUIDv7, invariant #7).
 * Provider ids differ: GolfCourseAPI mints `gca:9`, OpenGolfAPI ships v4
 * UUIDs. This is what lets the legacy-ownership heuristic (`ownsCourse`,
 * MAI-78) tell "authored on this device before `createdBy` existed — yours"
 * from "an API import the pre-createdBy editor re-stamped to source:'user'" —
 * both carry `createdBy: undefined`, but only the former may update in place;
 * treating the latter as yours pushes edits onto shared rows RLS refuses,
 * silently, forever.
 */
export function isLocallyMintedId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
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

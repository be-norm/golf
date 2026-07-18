import { uuidv7 } from 'uuidv7'
import type { GolfDB } from './schema'

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

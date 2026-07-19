import { db } from '../db/schema'
import { getDeviceId, newId } from '../db/ids'
import { eventStore } from '../db/eventStore'
import type { Round } from '../engine/core/types'
import { supabase } from './supabase'

/**
 * Best-effort round backup: enqueue locally, flush opportunistically.
 * The app must behave identically with Supabase unreachable.
 */
export async function enqueueRoundArchive(round: Round): Promise<void> {
  const events = await eventStore.list(round.id)
  await db.outbox.put({
    id: newId(),
    kind: 'archiveRound',
    payload: { round, events },
    createdAt: new Date().toISOString(),
    attempts: 0,
  })
  void flushOutbox()
}

let flushing = false

export async function flushOutbox(): Promise<void> {
  if (flushing || !navigator.onLine) return
  flushing = true
  try {
    const items = await db.outbox.orderBy('createdAt').toArray()
    const deviceId = await getDeviceId(db)
    for (const item of items) {
      if (item.kind !== 'archiveRound') continue
      // give up quietly after repeated permanent failures — archiving is
      // best-effort and must not churn the network forever
      if (item.attempts >= 10) continue
      const { round } = item.payload as { round: Round }
      // upsert-ignore makes a lost response idempotent: if the row landed but
      // the ack didn't, the retry succeeds instead of duplicate-keying forever
      const { error } = await supabase.from('round_archives').upsert(
        {
          id: item.id,
          round_id: round.id,
          device_id: deviceId,
          data: item.payload,
        },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      if (error) {
        await db.outbox.update(item.id, { attempts: item.attempts + 1 })
      } else {
        await db.outbox.delete(item.id)
      }
    }
  } catch {
    // fully silent: archiving is opportunistic
  } finally {
    flushing = false
  }
}

export function registerOutboxFlush(): void {
  window.addEventListener('online', () => void flushOutbox())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushOutbox()
  })
  void flushOutbox()
}

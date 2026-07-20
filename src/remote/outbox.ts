import { db } from '../db/schema'
import type { OutboxItem } from '../db/schema'
import { getDeviceId, newId } from '../db/ids'
import { eventStore } from '../db/eventStore'
import type { Player, Round } from '../engine/core/types'
import type { RoundEvent } from '../engine/core/events'
import { supabase } from './supabase'

/**
 * Owner-scoped cloud sync, best-effort. Every mutation is enqueued locally and
 * flushed opportunistically; the app behaves identically with Supabase
 * unreachable. Pushes only happen for signed-in owners (guest data stays local
 * until claimed). Each payload carries its own userId so the flusher never
 * needs the live session.
 */

interface PushRoundPayload {
  userId: string
  round: Round
  events: RoundEvent[]
}
interface PushPlayerPayload {
  userId: string
  player: Player
}
interface DeleteRoundPayload {
  userId: string
  roundId: string
}
interface DeletePlayerPayload {
  userId: string
  playerId: string
}

export async function enqueuePushRound(userId: string, round: Round): Promise<void> {
  const events = await eventStore.list(round.id)
  await put('pushRound', { userId, round, events })
}

export async function enqueuePushPlayer(userId: string, player: Player): Promise<void> {
  await put('pushPlayer', { userId, player })
}

export async function enqueueDeleteRound(userId: string, roundId: string): Promise<void> {
  await purgePendingFor(roundId)
  await put('deleteRound', { userId, roundId })
}

export async function enqueueDeletePlayer(userId: string, playerId: string): Promise<void> {
  await purgePendingFor(playerId)
  await put('deletePlayer', { userId, playerId })
}

async function put(kind: OutboxItem['kind'], payload: unknown): Promise<void> {
  await db.outbox.put({
    id: newId(),
    kind,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  })
  void flushOutbox()
}

/**
 * Drop queued pushes for an entity before enqueuing its delete, so a retried
 * push can't run after the tombstone and resurrect the row. (The push upsert
 * also never writes deleted_at, so it can't clear an existing tombstone.)
 */
async function purgePendingFor(entityId: string): Promise<void> {
  const stale = await db.outbox
    .filter((item) => {
      if (item.kind === 'pushRound') return (item.payload as PushRoundPayload).round.id === entityId
      if (item.kind === 'pushPlayer')
        return (item.payload as PushPlayerPayload).player.id === entityId
      return false
    })
    .toArray()
  await db.outbox.bulkDelete(stale.map((s) => s.id))
}

let flushing = false

export async function flushOutbox(): Promise<void> {
  if (flushing || !navigator.onLine) return
  flushing = true
  try {
    const items = await db.outbox.orderBy('createdAt').toArray()
    const deviceId = await getDeviceId(db)
    for (const item of items) {
      // give up quietly after repeated permanent failures — sync is best-effort
      if (item.attempts >= 10) continue
      const ok = await send(item, deviceId)
      if (ok) await db.outbox.delete(item.id)
      else await db.outbox.update(item.id, { attempts: item.attempts + 1 })
    }
  } catch {
    // fully silent: sync is opportunistic
  } finally {
    flushing = false
  }
}

async function send(item: OutboxItem, deviceId: string): Promise<boolean> {
  const now = new Date().toISOString()
  switch (item.kind) {
    case 'pushRound': {
      const { userId, round, events } = item.payload as PushRoundPayload
      // one canonical row per (owner, round) — (user_id, round_id) is the PK.
      // deleted_at is deliberately omitted so a re-push never un-tombstones.
      const { error } = await supabase.from('round_archives').upsert(
        {
          user_id: userId,
          round_id: round.id,
          device_id: deviceId,
          data: { round, events },
          updated_at: round.updatedAt,
        },
        { onConflict: 'user_id,round_id' },
      )
      return !error
    }
    case 'pushPlayer': {
      const { userId, player } = item.payload as PushPlayerPayload
      const { error } = await supabase.from('players').upsert(
        {
          id: player.id,
          user_id: userId,
          name: player.name,
          handicap_index: player.handicapIndex ?? null,
          last_course_handicap: player.lastCourseHandicap ?? null,
          updated_at: player.updatedAt,
        },
        { onConflict: 'id' },
      )
      return !error
    }
    case 'deleteRound': {
      const { userId, roundId } = item.payload as DeleteRoundPayload
      const { error } = await supabase
        .from('round_archives')
        .update({ deleted_at: now, updated_at: now })
        .eq('user_id', userId)
        .eq('round_id', roundId)
      return !error
    }
    case 'deletePlayer': {
      const { userId, playerId } = item.payload as DeletePlayerPayload
      const { error } = await supabase
        .from('players')
        .update({ deleted_at: now, updated_at: now })
        .eq('user_id', userId)
        .eq('id', playerId)
      return !error
    }
    default:
      // Drop legacy/unknown kinds (e.g. pre-auth 'archiveRound' items) instead
      // of retrying them into permanent dead rows.
      return true
  }
}

export function registerOutboxFlush(): void {
  window.addEventListener('online', () => void flushOutbox())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushOutbox()
  })
  void flushOutbox()
}

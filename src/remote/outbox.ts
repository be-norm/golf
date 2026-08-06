import { db } from '../db/schema'
import type {
  DeleteSavedCoursePayload,
  OutboxItem,
  PushCoursePayload,
  PushSavedCoursePayload,
} from '../db/schema'
import { setOutboxNotifier } from '../db/outboxSignal'
import { getDeviceId, newId } from '../db/ids'
import { eventStore } from '../db/eventStore'
import type { Course, Player, Round } from '../engine/core/types'
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

/**
 * Publish a user-authored course to the shared library so every user can find
 * it. Only ever called for source:'user' courses owned by a signed-in user;
 * RLS pins the row's created_by to the caller.
 */
export async function enqueuePushCourse(userId: string, course: Course): Promise<void> {
  await put('pushCourse', { userId, course })
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

let inFlight: Promise<void> | null = null
let rerun = false

/**
 * Re-entrant calls join the in-flight run and flag a follow-up pass, so an op
 * enqueued mid-flush is picked up instead of silently missed until the next
 * external trigger — and `await flushOutbox()` genuinely waits, which is what
 * makes syncNow's flush-before-pull an ordering rather than a hope (a pull
 * overlapping an un-awaited flush could fetch pre-tombstone rows and
 * transiently resurrect a course the user just removed).
 */
export function flushOutbox(): Promise<void> {
  if (inFlight) {
    rerun = true
    return inFlight
  }
  inFlight = drainQueue().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function drainQueue(): Promise<void> {
  try {
    do {
      rerun = false
      if (!navigator.onLine) return
      // Every op is owner-scoped, so flushing signed-out can't succeed — and
      // it's worse than useless: RLS filters every row for anon, a tombstone
      // UPDATE then matches nothing, reads as success, and the removal is
      // destroyed. Wait for a session instead of burning the ops.
      const { data } = await supabase.auth.getSession()
      const uid = data.session?.user?.id
      if (!uid) return
      const items = await db.outbox.orderBy('createdAt').toArray()
      const deviceId = await getDeviceId(db)
      for (const item of items) {
        // give up quietly after repeated permanent failures — sync is best-effort
        if (item.attempts >= 10) continue
        // Only the owner's session may flush an op: under anyone else's, RLS
        // filters their rows and a tombstone UPDATE "succeeds" against
        // nothing — the signed-out trap one account deeper. A foreign op
        // waits (no attempt burned) for its owner to sign back in;
        // wipeUserData drops it if that account is deleted on this device.
        const owner = (item.payload as { userId?: string })?.userId
        if (owner !== undefined && owner !== uid) continue
        const ok = await send(item, deviceId)
        if (ok) await db.outbox.delete(item.id)
        else await db.outbox.update(item.id, { attempts: item.attempts + 1 })
      }
    } while (rerun)
  } catch {
    // fully silent: sync is opportunistic
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
          ghin_number: player.ghinNumber ?? null,
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
    case 'pushSavedCourse': {
      const { userId, course, savedAt } = item.payload as PushSavedCoursePayload
      // updated_at is the MEMBERSHIP clock — when this user saved it — never
      // the card's own updatedAt (the card travels inside `data` with its own
      // stamp; conflating the two was a review finding on the last attempt).
      // deleted_at is deliberately omitted, exactly as round_archives does it:
      // a re-push never clears a tombstone; a re-save with a newer updated_at
      // simply out-dates it and pull treats the row as live again.
      //
      // Two steps because the write must be staleness-gated like the delete
      // below, and a plain upsert can't be: a stale queued push flushing late
      // (device offline for days) would rewind updated_at/data below a newer
      // save from another device — and a rewound updated_at under a standing
      // deleted_at reads as REMOVED, splitting the brain across devices.
      // Step 1 creates the row iff absent; step 2 applies the write iff not
      // older than what's there. A newer concurrent write between the two
      // simply wins step 2, which is the correct outcome.
      //
      // ACCEPTED tradeoff: the gate rides the membership clock alone, so a
      // legitimately-fresh membership (a claim) carrying an old card copy can
      // regress the server's `data` to that copy. Gating `data` on the card's
      // own clock would take a second conditional update (or an RPC) per
      // push; active devices are protected by pull's card-clock LWW either
      // way, so only a fresh-device restore sees the older card — which is
      // the copy the claiming user actually had. Revisit as an RPC if a
      // multi-user reality ever makes this bite.
      const inserted = await supabase.from('saved_courses').upsert(
        { user_id: userId, course_id: course.id, data: course, updated_at: savedAt },
        { onConflict: 'user_id,course_id', ignoreDuplicates: true },
      )
      if (inserted.error) return false
      const updated = await supabase
        .from('saved_courses')
        .update({ data: course, updated_at: savedAt })
        .eq('user_id', userId)
        .eq('course_id', course.id)
        .lte('updated_at', savedAt)
      return !updated.error
    }
    case 'deleteSavedCourse': {
      const { userId, courseId, removedAt } = item.payload as DeleteSavedCoursePayload
      // Tombstone rather than delete, so a device that was offline learns the
      // course was removed instead of pushing it back on its next sync.
      // Stamped with when the USER removed it, not when this flush runs, and
      // gated on lte: if the server row's updated_at is already newer, another
      // device re-saved the course AFTER this removal — the removal is stale
      // news and must leave the row alone. (For rounds/players a flush-time
      // stamp is harmless because their tombstones are forever; here the
      // deleted_at/updated_at ordering decides liveness, so the clock is
      // load-bearing.)
      const { error } = await supabase
        .from('saved_courses')
        .update({ deleted_at: removedAt, updated_at: removedAt })
        .eq('user_id', userId)
        .eq('course_id', courseId)
        .lte('updated_at', removedAt)
      return !error
    }
    case 'pushCourse': {
      const { userId, course } = item.payload as PushCoursePayload
      // Shared, publicly-readable library row. created_by = the owner (RLS
      // pins it); source/status forced to what the insert policy allows.
      // source_id carries the fork's origin (MAI-78): a correction of an
      // ODbL-derived card must publish with its provenance chain intact, not
      // as an unattributed original.
      const { error } = await supabase.from('courses').upsert(
        {
          id: course.id,
          name: course.name,
          location: course.location ?? null,
          hole_count: course.holeCount,
          data: course,
          status: 'published',
          source: 'user',
          source_id: course.sourceId ?? null,
          created_by: userId,
          revision: course.revision,
          updated_at: course.updatedAt,
        },
        { onConflict: 'id' },
      )
      return !error
    }
    default:
      // Drop legacy/unknown kinds (e.g. pre-auth 'archiveRound' items) instead
      // of retrying them into permanent dead rows.
      return true
  }
}

export function registerOutboxFlush(): void {
  // CourseRepo writes outbox rows inside its own transactions (atomic with the
  // membership they describe) and signals here for the flush, so the db layer
  // never imports the network stack.
  setOutboxNotifier(() => void flushOutbox())
  window.addEventListener('online', () => void flushOutbox())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushOutbox()
  })
  void flushOutbox()
}

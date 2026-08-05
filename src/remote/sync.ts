import Dexie from 'dexie'
import { ADOPT_LIBRARY_KEY, db } from '../db/schema'
import { LOCAL_USER } from '../db/ids'
import { courseRepo, roundRepo, playerRepo } from '../db/repos'
import type { Course, Player, Round } from '../engine/core/types'
import type { RoundEvent } from '../engine/core/events'
import { supabase } from './supabase'
import { enqueuePushCourse, enqueuePushPlayer, enqueuePushRound, flushOutbox } from './outbox'

/**
 * Owner-scoped cloud restore. Snapshot model: each completed round is a
 * self-contained {round, events} blob in round_archives; the roster mirrors to
 * a players table; the saved course library mirrors to saved_courses, each row
 * carrying the course's own card so it restores whether or not that course
 * exists in the shared library (most saved courses don't — live-API imports are
 * never published there). Pull is additive + last-write-wins by updatedAt, and
 * honors soft-delete tombstones. Live rounds are never pushed or pulled — they
 * finish on the device that started them. All best-effort/silent, like
 * flushOutbox.
 */

/** Flush pending pushes, then restore anything newer from the cloud. */
export async function syncNow(userId: string): Promise<void> {
  if (userId === LOCAL_USER) return
  await flushOutbox()
  await pull(userId)
}

export async function pull(userId: string): Promise<void> {
  if (userId === LOCAL_USER || !navigator.onLine) return
  try {
    const [archivesRes, playersRes, coursesRes] = await Promise.all([
      supabase
        .from('round_archives')
        .select('round_id, data, updated_at, deleted_at')
        .eq('user_id', userId),
      supabase.from('players').select('*').eq('user_id', userId),
      supabase
        .from('saved_courses')
        .select('course_id, data, updated_at, deleted_at')
        .eq('user_id', userId),
    ])

    for (const row of archivesRes.data ?? []) {
      if (row.deleted_at) await roundRepo.delete(row.round_id as string)
      else await applyRemoteRound(userId, row.data as { round: Round; events: RoundEvent[] })
    }
    for (const row of playersRes.data ?? []) {
      if (row.deleted_at) await playerRepo.delete(row.id as string)
      else await applyRemotePlayer(userId, row)
    }
    for (const row of coursesRes.data ?? []) {
      const deletedAt = row.deleted_at as string | null
      // "Removed" is deleted_at >= updated_at, compared as instants: a re-push
      // rewrites updated_at but deliberately never clears deleted_at, so a
      // tombstone OUT-DATED by a later re-save means the course is live again.
      // (Gating on local membership instead was the last review's forever-
      // tombstone bug — a fresh device has no local membership to compare, so
      // a remove-then-re-save stayed dead on every other device.)
      if (deletedAt && Date.parse(deletedAt) >= Date.parse(row.updated_at as string)) {
        await courseRepo.applyRemoteRemoval(userId, row.course_id as string, deletedAt)
      } else {
        await courseRepo.applyRemoteSave(userId, row.data as Course, row.updated_at as string)
      }
    }
  } catch {
    // opportunistic — offline or transient failure just means no restore now
  }
}

async function applyRemoteRound(
  userId: string,
  data: { round: Round; events: RoundEvent[] },
): Promise<void> {
  const round = { ...data.round, userId }
  const local = await roundRepo.get(round.id)
  if (local && local.updatedAt >= round.updatedAt) return // local same-or-newer → keep
  await db.transaction('rw', db.rounds, db.round_events, async () => {
    await db.rounds.put(round)
    // Only replace the event log when the snapshot actually carries events —
    // never wipe a local log because a malformed remote row had events: [].
    if (data.events?.length) {
      await db.round_events.where('roundId').equals(round.id).delete()
      await db.round_events.bulkPut(data.events)
    }
  })
}

async function applyRemotePlayer(userId: string, row: Record<string, unknown>): Promise<void> {
  // Postgres `numeric` comes back from PostgREST as a STRING — coerce or the
  // handicap becomes a string and breaks course-handicap math on this device.
  const remote: Player = {
    id: row.id as string,
    userId,
    name: row.name as string,
    handicapIndex: row.handicap_index == null ? undefined : Number(row.handicap_index),
    lastCourseHandicap: row.last_course_handicap == null ? undefined : Number(row.last_course_handicap),
    ghinNumber: row.ghin_number == null ? undefined : String(row.ghin_number),
    updatedAt: row.updated_at as string,
  }
  const local = await playerRepo.get(remote.id)
  if (local && local.updatedAt >= remote.updatedAt) return
  await db.players.put(remote)
}

/**
 * Claim signed-out ("guest") data into the account: rewrite the sentinel owner
 * to the auth uid in one transaction (round_events follow by roundId, no
 * rewrite needed), then enqueue pushes for the roster + completed rounds.
 * Returns how much was claimed so the UI can confirm it.
 */
export async function claimLocalData(
  userId: string,
): Promise<{ rounds: number; players: number; courses: number }> {
  const claimed = await db.transaction('rw', db.rounds, db.players, async () => {
    const rounds = await db.rounds
      .where('[userId+startedAt]')
      .between([LOCAL_USER, Dexie.minKey], [LOCAL_USER, Dexie.maxKey])
      .toArray()
    const players = await db.players
      .where('[userId+name]')
      .between([LOCAL_USER, Dexie.minKey], [LOCAL_USER, Dexie.maxKey])
      .toArray()
    for (const r of rounds) await db.rounds.update(r.id, { userId })
    for (const p of players) await db.players.update(p.id, { userId })
    return { rounds, players }
  })

  for (const p of claimed.players) await enqueuePushPlayer(userId, { ...p, userId })
  for (const r of claimed.rounds) {
    if (r.status === 'completed') await enqueuePushRound(userId, { ...r, userId })
  }

  // The saved library claims like rounds and players do — membership is owned
  // data (MAI-76). The repo re-keys guest rows to the account and queues each
  // course's push in one transaction.
  const courses = await courseRepo.claim(userId)

  // Authorship follows too. Guest-authored cards carry the sentinel (legacy
  // ones carry nothing); re-stamp them to the account and publish, so a course
  // scanned while signed out finally reaches the shared library — and the
  // insert passes RLS, which pins created_by to the caller. Cards another
  // signed-in user authored on this device are NOT ours to publish.
  const authored = await db.courses
    .filter(
      (c) => c.source === 'user' && (c.createdBy === undefined || c.createdBy === LOCAL_USER),
    )
    .toArray()
  for (const c of authored) {
    await db.courses.update(c.id, { createdBy: userId })
    await enqueuePushCourse(userId, { ...c, createdBy: userId })
  }

  return { rounds: claimed.rounds.length, players: claimed.players.length, courses }
}

/** How many guest rows exist locally — drives the claim prompt. */
export async function countLocalGuestData(): Promise<{
  rounds: number
  players: number
  courses: number
}> {
  await adoptionSettled
  const rounds = await db.rounds
    .where('[userId+startedAt]')
    .between([LOCAL_USER, Dexie.minKey], [LOCAL_USER, Dexie.maxKey])
    .count()
  const players = await db.players
    .where('[userId+name]')
    .between([LOCAL_USER, Dexie.minKey], [LOCAL_USER, Dexie.maxKey])
    .count()
  // counted too, or the prompt would offer to move "local data" while silently
  // claiming a library it never mentioned — the opposite of opt-in
  const courses = await courseRepo.countMemberships(LOCAL_USER)
  return { rounds, players, courses }
}

/**
 * One-shot adoption of the pre-MAI-76 library. The Dexie v3 upgrade backfills
 * existing cards to the guest sentinel and arms a meta flag; whoever the FIRST
 * post-upgrade launch resolves as consumes it. Signed in → those courses were
 * demonstrably saved by this account (they predate the feature, not the
 * login), so they're claimed and pushed. Guest → they stay guest and ride the
 * claim prompt's explicit opt-in like any other guest data. Either way the
 * flag dies here: left armed, some future sign-in would silently absorb a
 * DIFFERENT person's library, which is the consent bug this feature fixes.
 */
/** Lets countLocalGuestData order itself after a concurrent adoption: the
 *  claim prompt must not offer courses that adoption is about to take anyway
 *  ("Not now" could then decline a library the sheet had already named). */
let adoptionSettled: Promise<void> = Promise.resolve()

export function adoptDeviceLibrary(userId: string): Promise<void> {
  adoptionSettled = (async () => {
    const pending = await db.meta.get(ADOPT_LIBRARY_KEY)
    if (!pending) return
    await db.meta.delete(ADOPT_LIBRARY_KEY)
    if (userId !== LOCAL_USER) await courseRepo.claim(userId)
  })()
  return adoptionSettled
}

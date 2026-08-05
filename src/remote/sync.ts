import Dexie from 'dexie'
import { db } from '../db/schema'
import { LOCAL_USER } from '../db/ids'
import { roundRepo, playerRepo } from '../db/repos'
import type { Course, Player, Round } from '../engine/core/types'
import type { RoundEvent } from '../engine/core/events'
import { supabase } from './supabase'
import { enqueuePushCourse, enqueuePushPlayer, enqueuePushRound, flushOutbox } from './outbox'

/**
 * Owner-scoped cloud restore. Snapshot model: each completed round is a
 * self-contained {round, events} blob in round_archives; the roster mirrors to
 * a players table; the saved course library mirrors to saved_courses, carrying
 * each course's own data so it restores whether or not that course exists in
 * the shared library. Pull is additive + last-write-wins by updatedAt, and
 * honors soft-delete tombstones. Live rounds are never pushed or pulled — they
 * finish on the device that started them. All best-effort/silent, like
 * flushOutbox.
 */

/** Flush pending pushes, then restore anything newer from the cloud. */
export async function syncNow(userId: string): Promise<void> {
  if (userId === LOCAL_USER) return
  // ORDER IS LOAD-BEARING, and it is pull-then-push for the library.
  //
  // `pushSavedCourses` re-asserts the whole local set, so a device that still
  // holds a course someone deleted elsewhere would clear its tombstone and
  // resurrect it for everyone. Pulling first makes that device honour the
  // tombstone and drop the course locally, so the push that follows no longer
  // contains it. (A removal made on THIS device is tombstoned by flushOutbox
  // and survives its own pull — see applyRemoteCourseTombstone.)
  await flushOutbox()
  await pull(userId)
  await pushSavedCourses(userId)
}

/**
 * Reconcile the saved course library UP, as a set.
 *
 * Saves aren't events here. A course enters the library from four different
 * call sites (search import, scan, manual build, editor save), none of which
 * has the signed-in user to hand — threading one through all four is four
 * chances to forget, and forgetting means a course that silently never syncs.
 * Uploading the set instead makes "it is in my library" the whole condition,
 * so a save cannot be missed. Libraries are a handful of rows and the upsert is
 * idempotent, so re-sending is cheap.
 *
 * REMOVALS still need the outbox (`enqueueDeleteSavedCourse`): a course that is
 * gone locally leaves nothing here to reconcile, and without a tombstone the
 * next pull would hand it straight back.
 */
export async function pushSavedCourses(userId: string): Promise<void> {
  if (userId === LOCAL_USER || !navigator.onLine) return
  try {
    const courses = await db.courses.toArray()
    if (courses.length === 0) return
    await supabase.from('saved_courses').upsert(
      courses.map((c) => ({
        user_id: userId,
        course_id: c.id,
        data: c,
        updated_at: c.updatedAt,
        // Safe to clear a tombstone here ONLY because pull ran first: anything
        // still local after that is either untouched or a genuine re-save, both
        // of which should be live again.
        deleted_at: null,
      })),
      { onConflict: 'user_id,course_id' },
    )
  } catch {
    // opportunistic, exactly like pull — a failed push retries next sync
  }
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
      if (row.deleted_at) {
        await applyRemoteCourseTombstone(row.course_id as string, row.updated_at as string)
      } else await applyRemoteCourse(row.data as Course)
    }
  } catch {
    // opportunistic — offline or transient failure just means no restore now
  }
}

/**
 * Courses are NOT owner-partitioned (the library is shared — CLAUDE.md), so
 * this writes the row as-is rather than stamping a userId onto it. Goes through
 * db.courses directly, not courseRepo.put, which re-stamps `updatedAt` and
 * bumps `revision` — that would make every restore look like a local edit and
 * win the next last-write-wins comparison against the real one.
 */
async function applyRemoteCourse(course: Course): Promise<void> {
  const local = await db.courses.get(course.id)
  if (local && local.updatedAt >= course.updatedAt) return
  await db.courses.put(course)
}

/**
 * Honour a removal made on another device — unless this one has since SAVED the
 * course again, which is a newer intent than the deletion and must survive.
 * Same last-write-wins rule the rest of pull uses, with the tombstone's
 * timestamp standing in for the row's.
 */
async function applyRemoteCourseTombstone(courseId: string, deletedAt: string): Promise<void> {
  const local = await db.courses.get(courseId)
  if (local && local.updatedAt > deletedAt) return
  await db.courses.delete(courseId)
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
export async function claimLocalData(userId: string): Promise<{ rounds: number; players: number }> {
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

  // Courses aren't owner-partitioned (they're a shared library), so there's no
  // guest sentinel to rewrite — just publish the ones this device authored so
  // they reach the account (and every other user). Best-effort, same as above.
  const userCourses = await db.courses.filter((c) => c.source === 'user').toArray()
  for (const c of userCourses) await enqueuePushCourse(userId, c)

  // ...and claim the LIBRARY itself, not just authorship. Courses saved while
  // signed out are the user's saved courses too; without this they'd stay on
  // this device only and vanish with its storage (MAI-76).
  await pushSavedCourses(userId)

  return { rounds: claimed.rounds.length, players: claimed.players.length }
}

/** How many guest rows exist locally — drives the claim prompt. */
export async function countLocalGuestData(): Promise<{ rounds: number; players: number }> {
  const rounds = await db.rounds
    .where('[userId+startedAt]')
    .between([LOCAL_USER, Dexie.minKey], [LOCAL_USER, Dexie.maxKey])
    .count()
  const players = await db.players
    .where('[userId+name]')
    .between([LOCAL_USER, Dexie.minKey], [LOCAL_USER, Dexie.maxKey])
    .count()
  return { rounds, players }
}

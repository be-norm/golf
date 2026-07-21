import Dexie from 'dexie'
import { db } from '../db/schema'
import { LOCAL_USER } from '../db/ids'
import { roundRepo, playerRepo } from '../db/repos'
import type { Player, Round } from '../engine/core/types'
import type { RoundEvent } from '../engine/core/events'
import { supabase } from './supabase'
import { enqueuePushCourse, enqueuePushPlayer, enqueuePushRound, flushOutbox } from './outbox'

/**
 * Owner-scoped cloud restore. Snapshot model: each completed round is a
 * self-contained {round, events} blob in round_archives; the roster mirrors to
 * a players table. Pull is additive + last-write-wins by updatedAt, and honors
 * soft-delete tombstones. Live rounds are never pushed or pulled — they finish
 * on the device that started them. All best-effort/silent, like flushOutbox.
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
    const [archivesRes, playersRes] = await Promise.all([
      supabase
        .from('round_archives')
        .select('round_id, data, updated_at, deleted_at')
        .eq('user_id', userId),
      supabase.from('players').select('*').eq('user_id', userId),
    ])

    for (const row of archivesRes.data ?? []) {
      if (row.deleted_at) await roundRepo.delete(row.round_id as string)
      else await applyRemoteRound(userId, row.data as { round: Round; events: RoundEvent[] })
    }
    for (const row of playersRes.data ?? []) {
      if (row.deleted_at) await playerRepo.delete(row.id as string)
      else await applyRemotePlayer(userId, row)
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

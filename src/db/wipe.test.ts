import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Player, Round } from '../engine/core/types'
import { makeCourse, makePlayers, makeRound } from '../engine/test/harness'
import { EventStore } from './eventStore'
import { LOCAL_USER, newId, resetDeviceIdCache } from './ids'
import { GolfDB } from './schema'
import { wipeUserData } from './wipe'

const UID = 'uid-owner'
const OTHER = 'uid-someone-else'

let counter = 0
function freshDb(): GolfDB {
  resetDeviceIdCache()
  return new GolfDB(`golf-wipe-test-${++counter}`)
}

async function seedRound(db: GolfDB, userId: string): Promise<Round> {
  const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
  const base = makeRound({
    players,
    games: [{ type: 'skins', config: { stakeCents: 500, carry: true } }],
  })
  const round: Round = { ...base, id: newId(), userId }
  await db.rounds.put(round)
  await new EventStore(db).append(round.id, [
    { type: 'score/set', playerId: players[0]!.playerId, hole: 1, gross: 4 },
    { type: 'score/set', playerId: players[1]!.playerId, hole: 1, gross: 5 },
  ])
  return round
}

async function seedPlayer(db: GolfDB, userId: string, name: string): Promise<void> {
  await db.players.put({
    id: newId(),
    userId,
    name,
    updatedAt: new Date().toISOString(),
  } as Player)
}

describe('wipeUserData', () => {
  let db: GolfDB

  beforeEach(() => {
    db = freshDb()
  })

  it('removes the owner’s rounds and their event logs', async () => {
    const mine = await seedRound(db, UID)
    await wipeUserData(UID, db)

    expect(await db.rounds.get(mine.id)).toBeUndefined()
    // The log must go with the round — orphaned events would replay into a
    // round that no longer exists if an id were ever reused.
    expect(await db.round_events.where('roundId').equals(mine.id).count()).toBe(0)
  })

  it('leaves guest data alone — it was never part of the account', async () => {
    const guestRound = await seedRound(db, LOCAL_USER)
    await seedPlayer(db, LOCAL_USER, 'Guest Greg')
    await seedRound(db, UID)

    await wipeUserData(UID, db)

    expect(await db.rounds.get(guestRound.id)).toBeDefined()
    expect(await db.players.where('userId').equals(LOCAL_USER).count()).toBe(1)
    expect(await db.round_events.where('roundId').equals(guestRound.id).count()).toBe(2)
  })

  it('leaves another signed-in user’s rows alone', async () => {
    const theirs = await seedRound(db, OTHER)
    await seedPlayer(db, OTHER, 'Other Olivia')
    await seedRound(db, UID)
    await seedPlayer(db, UID, 'Mine Mike')

    await wipeUserData(UID, db)

    expect(await db.rounds.get(theirs.id)).toBeDefined()
    expect(await db.players.where('userId').equals(OTHER).count()).toBe(1)
    expect(await db.players.where('userId').equals(UID).count()).toBe(0)
    expect(await db.rounds.where('userId').equals(UID).count()).toBe(0)
  })

  it('drops the owner’s library; cards survive only while something still references them', async () => {
    const base = makeCourse([4, 4, 5], [2, 1, 3])
    await db.courses.bulkPut([
      { ...base, id: 'course-shared' },
      { ...base, id: 'course-only-mine' },
    ])
    await db.saved_courses.bulkPut([
      { userId: UID, courseId: 'course-shared', updatedAt: 't' },
      { userId: LOCAL_USER, courseId: 'course-shared', updatedAt: 't' },
      { userId: UID, courseId: 'course-only-mine', updatedAt: 't' },
    ])

    await wipeUserData(UID, db)

    // the deleted account's membership is gone (it cascades away server-side,
    // and leaving it would show their library to whoever signs in next)…
    expect(await db.saved_courses.where('userId').equals(UID).count()).toBe(0)
    // …the guest's copy of the shared card survives, card and all…
    expect(await db.saved_courses.get([LOCAL_USER, 'course-shared'])).toBeDefined()
    expect(await db.courses.get('course-shared')).toBeDefined()
    // …and a card only the deleted account referenced is GC'd with it
    expect(await db.courses.get('course-only-mine')).toBeUndefined()
  })

  it('drops queued outbox ops for the deleted user, keeping everyone else’s', async () => {
    const now = new Date().toISOString()
    await db.outbox.bulkPut([
      { id: newId(), kind: 'pushRound', payload: { userId: UID }, createdAt: now, attempts: 0 },
      { id: newId(), kind: 'deleteRound', payload: { userId: UID }, createdAt: now, attempts: 0 },
      { id: newId(), kind: 'pushPlayer', payload: { userId: OTHER }, createdAt: now, attempts: 0 },
    ])

    await wipeUserData(UID, db)

    // Ops aimed at a deleted account can never succeed; leaving them would
    // retry forever and stall everything queued behind them.
    const left = await db.outbox.toArray()
    expect(left).toHaveLength(1)
    expect((left[0]!.payload as { userId: string }).userId).toBe(OTHER)
  })

  it('is a no-op for a user with nothing stored', async () => {
    await seedRound(db, OTHER)
    await expect(wipeUserData('uid-never-used', db)).resolves.toBeUndefined()
    expect(await db.rounds.count()).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { eventHole } from './ledger'
import { eventDraftSchema, type RoundEvent } from './core/events'

/**
 * `buildHoleLedger` replays the log prefix by prefix, and `eventHole` is what
 * decides which prefixes an event belongs to. Its filter keeps NULL in ALL of
 * them — correctly, for round-level events like completion.
 *
 * So an event that IS about a hole and answers null leaks backwards: hole 18's
 * fact would be visible while replaying hole 1, and the money that depends on
 * it would land on the wrong row. `score/putts` was exactly that case, inert
 * only because nothing reads putts yet — by the time Snake did, it would have
 * looked like Snake's bug.
 *
 * This guards the CLASS rather than that one case: it reads the event
 * vocabulary itself, so the next hole-scoped kind added without teaching
 * `eventHole` about it fails here, by name, the day it is written.
 */
describe('eventHole covers every hole-scoped event kind', () => {
  /** Members of the draft schema that carry a `hole` — read from the schema,
   *  not from a list a person has to remember to update. */
  const holeCarrying = eventDraftSchema.options
    .filter((o) => 'hole' in o.shape)
    .map((o) => (o.shape.type as { value: string }).value)

  it('finds the hole-scoped kinds to check at all', () => {
    // if this ever empties, every assertion below passes vacuously
    expect(holeCarrying.length).toBeGreaterThanOrEqual(3)
    expect(holeCarrying).toContain('score/putts')
  })

  for (const type of holeCarrying) {
    it(`attributes ${type} to its own hole`, () => {
      const event = {
        type,
        playerId: 'p-a',
        hole: 7,
        // harmless extras: each kind ignores the fields it doesn't declare
        gross: 4,
        putts: 2,
        id: 'e1',
        roundId: 'r1',
        seq: 1,
        at: '2026-07-18T12:00:00.000Z',
        deviceId: 'd',
      } as unknown as RoundEvent
      expect(eventHole(event)).toBe(7)
    })
  }

  it('leaves genuinely round-level events unattributed', () => {
    const base = { id: 'e1', roundId: 'r1', seq: 1, at: '2026-07-18T12:00:00.000Z', deviceId: 'd' }
    expect(eventHole({ ...base, type: 'round/completed' } as RoundEvent)).toBeNull()
    expect(eventHole({ ...base, type: 'round/reopened' } as RoundEvent)).toBeNull()
    // a retraction belongs wherever its TARGET does, which the retraction pass
    // has already resolved by the time the ledger replays — so null is right
    expect(
      eventHole({ ...base, type: 'meta/retract', targetEventId: 'x' } as RoundEvent),
    ).toBeNull()
  })

  it('reads a game event’s hole out of its payload', () => {
    const base = { id: 'e1', roundId: 'r1', seq: 1, at: '2026-07-18T12:00:00.000Z', deviceId: 'd' }
    expect(
      eventHole({ ...base, type: 'game/event', gameId: 'g', kind: 'ctp/award', data: { hole: 4 } } as RoundEvent),
    ).toBe(4)
    // a payload without one is round-level by construction — see Award.data
    expect(
      eventHole({ ...base, type: 'game/event', gameId: 'g', kind: 'x', data: {} } as RoundEvent),
    ).toBeNull()
  })
})

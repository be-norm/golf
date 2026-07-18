import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import '../games/index'
import { deriveRound } from '../catalog'
import { EventLog, makePlayers, makeRound } from '../test/harness'
import { assertZeroSum, minimalTransfers } from './money'
import type { RoundEvent } from './events'
import { effectiveEvents } from './replay'

const playerNames = ['A', 'B', 'C', 'D'] as const

function arbitraryRoundAndEvents() {
  return fc
    .record({
      playerCount: fc.integer({ min: 2, max: 4 }),
      handicaps: fc.array(fc.integer({ min: -3, max: 24 }), { minLength: 4, maxLength: 4 }),
      net: fc.boolean(),
      carryover: fc.boolean(),
      autoPress: fc.boolean(),
      // per hole per player: gross score or null (unscored)
      scores: fc.array(
        fc.array(fc.option(fc.integer({ min: 1, max: 12 }), { nil: null }), {
          minLength: 4,
          maxLength: 4,
        }),
        { minLength: 1, maxLength: 18 },
      ),
      // wolf pick seed per hole: 0-2 partner index, 3 lone, 4 blind, 5 no pick yet
      pickSeeds: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 18, maxLength: 18 }),
    })
    .map(({ playerCount, handicaps, net, carryover, autoPress, scores, pickSeeds }) => {
      const players = makePlayers(
        playerNames.slice(0, playerCount).map((name, i) => ({ name, ch: handicaps[i]! })),
      )
      const ids = players.map((p) => p.playerId)
      const handicap = net
        ? ({ mode: 'net', allowancePct: 100, reference: 'offLow' } as const)
        : ({ mode: 'gross', allowancePct: 100, reference: 'absolute' } as const)

      const games: Parameters<typeof makeRound>[0]['games'] = [
        { type: 'skins', config: { stakeCents: 100, carryover }, handicap },
      ]
      if (playerCount === 2 || playerCount === 4) {
        games.push({
          type: 'nassau',
          config: {
            stakeCents: 500,
            teams: playerCount === 4 ? { a: [ids[0]!, ids[1]!], b: [ids[2]!, ids[3]!] } : null,
            autoPress,
          },
          handicap,
        })
      }
      if (playerCount === 4) {
        games.push({
          type: 'vegas',
          config: {
            pointCents: 10,
            teams: { a: [ids[0]!, ids[2]!], b: [ids[1]!, ids[3]!] },
            birdieFlip: true,
            eagleDouble: true,
          },
          handicap,
        })
        games.push({ type: 'wolf', config: { pointCents: 100, rotation: [...ids] }, handicap })
      }

      const round = makeRound({ players, holes: 'full18', games })
      const wolfGameId = round.games.find((g) => g.type === 'wolf')?.gameId
      const log = new EventLog()
      scores.forEach((byPlayer, holeIdx) => {
        players.forEach((p, pi) => {
          const gross = byPlayer[pi]
          if (gross !== null && gross !== undefined) {
            log.append({ type: 'score/set', playerId: p.playerId, hole: holeIdx + 1, gross })
          }
        })
        if (wolfGameId) {
          const seed = pickSeeds[holeIdx]!
          if (seed < 5) {
            const wolfId = ids[holeIdx % 4]!
            const others = ids.filter((id) => id !== wolfId)
            const choice = seed < 3 ? others[seed]! : seed === 3 ? 'lone' : 'blind'
            log.append({
              type: 'game/event',
              gameId: wolfGameId,
              kind: 'wolf/pick',
              data: { hole: holeIdx + 1, choice },
            })
          }
        }
      })
      return { round, log }
    })
}

describe('replay invariants (fast-check)', () => {
  it('settlements are always zero-sum', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), ({ round, log }) => {
        const { derivations } = deriveRound(round, log.events)
        for (const d of derivations.values()) assertZeroSum(d.settlement)
      }),
    )
  })

  it('replay is deterministic: same events, same result', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), ({ round, log }) => {
        const a = deriveRound(round, log.events)
        const b = deriveRound(round, [...log.events])
        expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
          [...b.derivations.values()].map((d) => d.settlement),
        )
      }),
    )
  })

  it('retract(e) is equivalent to a log that never contained e', () => {
    fc.assert(
      fc.property(
        arbitraryRoundAndEvents().filter(({ log }) => log.events.length > 0),
        fc.nat(),
        ({ round, log }, pick) => {
          const target = log.events[pick % log.events.length]!
          const withRetract: RoundEvent[] = [
            ...log.events,
            {
              type: 'meta/retract',
              targetEventId: target.id,
              id: 'evt-retract',
              roundId: round.id,
              seq: log.events.length + 1,
              at: '2026-07-18T12:00:00.000Z',
              deviceId: 'device-test',
            },
          ]
          const without = log.events.filter((e) => e.id !== target.id)
          const a = deriveRound(round, withRetract)
          const b = deriveRound(round, without)
          expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
            [...b.derivations.values()].map((d) => d.settlement),
          )
        },
      ),
    )
  })

  it('correction equivalence: a corrected score equals having entered it right initially', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), fc.integer({ min: 1, max: 12 }), ({ round, log }, corrected) => {
        const scoreEvents = log.events.filter((e) => e.type === 'score/set')
        if (scoreEvents.length === 0) return
        const target = scoreEvents[0]!
        const correctionLog = new EventLog()
        for (const e of log.events) {
          if (e.type !== 'score/set') continue
          correctionLog.append({ type: 'score/set', playerId: e.playerId, hole: e.hole, gross: e.gross })
        }
        correctionLog.append({
          type: 'score/set',
          playerId: target.playerId,
          hole: target.hole,
          gross: corrected,
        })

        const directLog = new EventLog()
        for (const e of log.events) {
          if (e.type !== 'score/set') continue
          directLog.append(
            e.id === target.id
              ? { type: 'score/set', playerId: e.playerId, hole: e.hole, gross: corrected }
              : { type: 'score/set', playerId: e.playerId, hole: e.hole, gross: e.gross },
          )
        }

        const a = deriveRound(round, correctionLog.events)
        const b = deriveRound(round, directLog.events)
        expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
          [...b.derivations.values()].map((d) => d.settlement),
        )
      }),
    )
  })
})

describe('effectiveEvents', () => {
  it('drops retracted events and retracts themselves', () => {
    const log = new EventLog()
    const e1 = log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    log.append({ type: 'score/set', playerId: 'p-b', hole: 1, gross: 5 })
    log.append({ type: 'meta/retract', targetEventId: e1.id })
    const effective = effectiveEvents(log.events)
    expect(effective).toHaveLength(1)
    expect(effective[0]).toMatchObject({ playerId: 'p-b' })
  })
})

describe('minimalTransfers', () => {
  it('settles a zero-sum balance with minimal greedy transfers', () => {
    const transfers = minimalTransfers({ a: 800, b: -400, c: 400, d: -800 })
    const net: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 }
    for (const t of transfers) {
      net[t.fromPlayerId]! -= t.cents
      net[t.toPlayerId]! += t.cents
    }
    expect(net).toEqual({ a: 800, b: -400, c: 400, d: -800 })
    expect(transfers.length).toBeLessThanOrEqual(3)
  })
})

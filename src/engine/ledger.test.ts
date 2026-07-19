import { describe, expect, it } from 'vitest'
import './games/index'
import { deriveRound } from './catalog'
import { buildHoleLedger } from './ledger'
import { EventLog, makePlayers, makeRound } from './test/harness'

describe('buildHoleLedger', () => {
  it('attributes a banked skins carry to the hole where it was won', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    // h1 tie (carry 1), h2 tie (carry 2), h3 A wins 3 skins
    log.scoreByHole(round, { A: [4, 4, 3], B: [4, 4, 4] }, [1, 2, 3])
    const { ctx, derivations } = deriveRound(round, log.events)
    const ledger = buildHoleLedger(round, log.events, ctx.holesPlayed, derivations)
    const skins = ledger.get('game-1')!

    expect(skins[0]).toMatchObject({ hole: 1, deltas: [] })
    expect(skins[0]!.summary[0]).toContain('carried')
    expect(skins[2]!.hole).toBe(3)
    expect(skins[2]!.deltas).toEqual([
      { playerId: 'p-a', cents: 300 },
      { playerId: 'p-b', cents: -300 },
    ])
    expect(skins[2]!.runningCents).toEqual({ 'p-a': 300, 'p-b': -300 })
  })

  it('nassau money moves only when a bet closes; holes narrate the bet scores', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
      ],
    })
    const log = new EventLog()
    // h1: A wins · h2: halved · h3: A wins — nothing locks mid-round
    log.scoreByHole(round, { A: [4, 4, 4], B: [5, 4, 5] }, [1, 2, 3])
    const mid = deriveRound(round, log.events)
    const midLedger = buildHoleLedger(round, log.events, mid.ctx.holesPlayed, mid.derivations)
    const midRows = midLedger.get('game-1')!
    expect(midRows[0]!.summary[0]).toBe('A wins the hole')
    expect(midRows[0]!.summary[1]).toContain('F9 A ↑1')
    expect(midRows.every((r) => r.deltas.length === 0)).toBe(true)

    // finishing the round closes the bet — money lands on the last PLAYED
    // hole's row (never on an unplayed hole finalized by completion)
    log.append({ type: 'round/completed' })
    const done = deriveRound(round, log.events)
    const ledger = buildHoleLedger(round, log.events, done.ctx.holesPlayed, done.derivations)
    const rows = ledger.get('game-1')!
    const closing = rows[rows.length - 1]!
    expect(closing.hole).toBe(3)
    expect(closing.summary.some((s) => s.includes('closes'))).toBe(true)
    expect(closing.deltas).toEqual([
      { playerId: 'p-a', cents: 500 },
      { playerId: 'p-b', cents: -500 },
    ])
  })

  it('wolf: silent before any scores, attributes point-money on decided holes', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    const emptyLog = new EventLog()
    const { ctx: emptyCtx, derivations: emptyDerivations } = deriveRound(round, emptyLog.events)
    const emptyLedger = buildHoleLedger(round, emptyLog.events, emptyCtx.holesPlayed, emptyDerivations)
    // wolf announces "Wolf: A" for every pending hole — none of that belongs here
    expect(emptyLedger.get('game-1')).toEqual([])

    const log = new EventLog()
    log.append({ type: 'game/event', gameId: 'game-1', kind: 'wolf/pick', data: { hole: 1, choice: 'p-b' } })
    log.scoreByHole(round, { A: [4], B: [5], C: [5], D: [5] }, [1])
    const { ctx, derivations } = deriveRound(round, log.events)
    const ledger = buildHoleLedger(round, log.events, ctx.holesPlayed, derivations)
    const wolf = ledger.get('game-1')!
    expect(wolf).toHaveLength(1)
    expect(wolf[0]!.hole).toBe(1)
    // A+2 B+2 points → pairwise money: A/B +$4, C/D −$4
    expect(wolf[0]!.deltas).toEqual([
      { playerId: 'p-a', cents: 400 },
      { playerId: 'p-b', cents: 400 },
      { playerId: 'p-c', cents: -400 },
      { playerId: 'p-d', cents: -400 },
    ])
  })

  it('vegas: pushes show with no deltas, decided holes attribute team money', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
      holes: 'front9',
      games: [
        {
          type: 'vegas',
          config: {
            pointCents: 10,
            teams: { a: ['p-a', 'p-b'], b: ['p-c', 'p-d'] },
            birdieFlip: true,
            eagleDouble: true,
          },
        },
      ],
    })
    const log = new EventLog()
    // h1: 45 v 45 push · h2: 44 v 45 → team A +1 pt
    log.scoreByHole(round, { A: [4, 4], B: [5, 4], C: [4, 4], D: [5, 5] }, [1, 2])
    const { ctx, derivations } = deriveRound(round, log.events)
    const vegas = buildHoleLedger(round, log.events, ctx.holesPlayed, derivations).get('game-1')!
    expect(vegas).toHaveLength(2)
    expect(vegas[0]!.summary[0]).toContain('push')
    expect(vegas[0]!.deltas).toEqual([])
    expect(vegas[1]!.deltas).toEqual([
      { playerId: 'p-a', cents: 10 },
      { playerId: 'p-b', cents: 10 },
      { playerId: 'p-c', cents: -10 },
      { playerId: 'p-d', cents: -10 },
    ])
  })

  it('respects retractions in prefixes (corrected hole re-attributes cleanly)', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [3], B: [4] }, [1])
    const bad = log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 5 })
    log.append({ type: 'meta/retract', targetEventId: bad.id })
    const { ctx, derivations } = deriveRound(round, log.events)
    const ledger = buildHoleLedger(round, log.events, ctx.holesPlayed, derivations)
    expect(ledger.get('game-1')![0]!.deltas).toEqual([
      { playerId: 'p-a', cents: 100 },
      { playerId: 'p-b', cents: -100 },
    ])
  })
})

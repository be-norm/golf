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

  it('shows nassau money moving only when a bet flips', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
      ],
    })
    const log = new EventLog()
    // h1: A wins (front+overall flip to A: +$10) · h2: halved (no move) ·
    // h3: A wins again (still up: no money move)
    log.scoreByHole(round, { A: [4, 4, 4], B: [5, 4, 5] }, [1, 2, 3])
    const { ctx, derivations } = deriveRound(round, log.events)
    const ledger = buildHoleLedger(round, log.events, ctx.holesPlayed, derivations)
    const nassau = ledger.get('game-1')!

    expect(nassau[0]!.deltas).toEqual([
      { playerId: 'p-a', cents: 1000 },
      { playerId: 'p-b', cents: -1000 },
    ])
    expect(nassau[1]!.summary[0]).toBe('Halved')
    expect(nassau[1]!.deltas).toEqual([])
    expect(nassau[2]!.deltas).toEqual([])
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

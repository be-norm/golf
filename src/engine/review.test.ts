import { describe, expect, it } from 'vitest'
import './games/index'
import { deriveRound } from './catalog'
import { buildHoleLedger } from './ledger'
import { pairFlipped, pairNormal } from './games/vegas/engine'
import { EventLog, makePlayers, makeRound } from './test/harness'

/** Regression suite from the full-app architecture review. */
describe('code-review regressions', () => {
  it('9 holes of an 18-hole course allocate HALF the course handicap', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A', ch: 0 }, { name: 'B', ch: 10 }]),
      holes: 'front9', // default harness course is 18 holes
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: true },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    const { ctx } = deriveRound(round, [])
    const total = ctx.holesPlayed.reduce((a, h) => a + ctx.strokesFor('game-1', 'p-b', h), 0)
    expect(total).toBe(5) // half of 10, not 10 strokes crammed into 9 holes

    // a TRUE 9-hole course keeps its (9-hole-rated) course handicap as-is
    const nineHole = makeRound({
      course: (() => {
        const c = makeRound({ players: makePlayers([{ name: 'X' }]), games: [] }).courseSnapshot
        return { ...c, holeCount: 9 as const, holes: c.holes.slice(0, 9) }
      })(),
      players: makePlayers([{ name: 'A', ch: 0 }, { name: 'B', ch: 10 }]),
      holes: 'front9',
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: true },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    const { ctx: ctx9 } = deriveRound(nineHole, [])
    const total9 = ctx9.holesPlayed.reduce((a, h) => a + ctx9.strokesFor('game-1', 'p-b', h), 0)
    expect(total9).toBe(10)
  })

  it('duplicate manual nassau presses collapse to one bet', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: Array(18).fill(4),
      B: [5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    })
    // same press declared twice (double-tap / re-imported duplicate)
    for (let i = 0; i < 2; i++) {
      log.append({
        type: 'game/event',
        gameId: 'game-1',
        kind: 'nassau/press',
        data: { hole: 4, segment: 'front' },
      })
    }
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    // F +3, press@4 push (0 diff over h4-9? A won h1-3 only → press diff 0)…
    // the point: exactly ONE press bet exists
    expect(d.detailLines!.filter((l) => l.label.startsWith('Press')).length).toBe(1)
  })

  it('vegas pairing survives net scores ≤ 0 and softens double-10s', () => {
    expect(pairNormal(-1, 4)).toBe(14) // clamped to 1 & 4
    expect(pairNormal(0, 4)).toBe(14)
    expect(pairNormal(10, 11)).toBe(1011) // softer of 1011/1110
    expect(pairFlipped(10, 11)).toBe(1110)
  })

  it('wolf treats an invalid partner pick as pending, never NaN', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
      holes: 'front9',
      games: [{ type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } }],
    })
    const log = new EventLog()
    // partner = the wolf themselves (degenerate) — must not compute
    log.append({ type: 'game/event', gameId: 'game-1', kind: 'wolf/pick', data: { hole: 1, choice: 'p-a' } })
    log.scoreByHole(round, { A: [3], B: [5], C: [5], D: [5] }, [1])
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(Object.values(d.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
    // the pick prompt re-appears so the group can re-declare
    expect(d.requiredInputs().some((i) => i.hole === 1)).toBe(true)
  })

  it('malformed game-event payloads are dropped, not blind-cast', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
      holes: 'front9',
      games: [{ type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } }],
    })
    const log = new EventLog()
    log.append({ type: 'game/event', gameId: 'game-1', kind: 'wolf/pick', data: {} })
    log.append({ type: 'game/event', gameId: 'game-1', kind: 'not-a-kind', data: { hole: 1 } })
    log.scoreByHole(round, { A: [4], B: [5], C: [5], D: [5] }, [1])
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    // both events inert: hole still pending on its pick
    expect(d.requiredInputs().some((i) => i.hole === 1)).toBe(true)
  })

  it('a completed round STATUS does not leak completion into ledger prefixes', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      holes: 'front9',
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 4, 4], B: [5, 4, 5] }, [1, 2, 3])
    log.append({ type: 'round/completed' })
    // the app also flips the status flag when finishing — prefixes must not
    // treat every hole as finalized because of it
    const completedRound = { ...round, status: 'completed' as const }
    const { ctx, derivations } = deriveRound(completedRound, log.events)
    const rows = buildHoleLedger(completedRound, log.events, ctx.holesPlayed, derivations).get(
      'game-1',
    )!
    // money locks once (at the last played hole), not on hole 1's prefix
    expect(rows[0]!.deltas).toEqual([])
    const closing = rows[rows.length - 1]!
    expect(closing.hole).toBe(3)
    expect(closing.deltas.length).toBeGreaterThan(0)
  })
})

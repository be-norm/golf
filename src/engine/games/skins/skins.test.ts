import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { EventLog, makeCourse, makePlayers, makeRound } from '../../test/harness'
import type { SkinsDerivation } from './engine'

function skinsOf(round: ReturnType<typeof makeRound>, log: EventLog): SkinsDerivation {
  const { derivations } = deriveRound(round, log.events)
  return derivations.get(round.games[0]!.gameId) as SkinsDerivation
}

describe('skins — golden fixtures (hand-verified)', () => {
  /**
   * F1: 4 players, GROSS skins, $1, carryover on, front 9.
   * H1 A wins 1 · H2 tie (carry 1) · H3 tie (carry 2) · H4 C wins 3 ·
   * H5 tie (carry 1) · H6 tie (carry 2) · H7 A wins 3 · H8 B wins 1 · H9 tie (dies).
   * Skins: A4 B1 C3 D0 → at $1/skin: A +$8, B -$4, C +$4, D -$8.
   */
  it('F1: gross skins with carryovers, 4 players', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [4, 4, 5, 6, 4, 5, 3, 5, 4],
      B: [5, 4, 4, 5, 4, 5, 4, 4, 4],
      C: [5, 5, 4, 4, 4, 5, 4, 5, 4],
      D: [5, 6, 5, 5, 4, 5, 4, 5, 4],
    })
    const skins = skinsOf(round, log)

    expect(skins.settlement.perPlayerCents).toEqual({
      'p-a': 800,
      'p-b': -400,
      'p-c': 400,
      'p-d': -800,
    })
    expect(skins.holeResults.map((r) => r.kind)).toEqual([
      'won',
      'tied',
      'tied',
      'won',
      'tied',
      'tied',
      'won',
      'won',
      'tied',
    ])
    expect(skins.carrying).toBe(1) // hole 9 tie dies carried
    expect(skins.standings[0]).toMatchObject({ label: 'A', amountCents: 800, detail: '4 skins' })
  })

  /**
   * F2: 3 players, NET skins off-low, $1, carryover on, front 9.
   * Course front-9 SIs [5,13,1,9,17,3,11,7,15] re-rank to
   * h3=1, h6=2, h1=3, h8=4, h4=5, h7=6, h2=7, h9=8, h5=9.
   * CH: Ben 2, Alice 9, Carol 13 → off low: 0 / 7 / 11.
   * Alice strokes on ranks 1–7 (h1,h2,h3,h4,h6,h7,h8); Carol 1 everywhere + 2 on h3,h6.
   * Hand-derived: H1 tie · H2 tie · H3 Ben×3 · H4 tie · H5 Carol×2 ·
   * H6 Alice×1 · H7 tie · H8 Ben×2 · H9 tie (dies).
   * Skins: Ben 5, Alice 1, Carol 2 → Ben +$7, Alice -$5, Carol -$2.
   */
  it('F2: net skins off low handicap, 3 players', () => {
    const course = makeCourse([4, 4, 5, 3, 4, 4, 3, 5, 4], [5, 13, 1, 9, 17, 3, 11, 7, 15])
    const players = makePlayers([
      { name: 'Ben', ch: 2 },
      { name: 'Alice', ch: 9 },
      { name: 'Carol', ch: 13 },
    ])
    const round = makeRound({
      course,
      players,
      holes: 'front9',
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: true },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, {
      Ben: [4, 5, 4, 3, 5, 4, 3, 4, 4],
      Alice: [5, 5, 6, 4, 5, 4, 5, 6, 4],
      Carol: [6, 5, 7, 5, 5, 6, 4, 6, 5],
    })
    const skins = skinsOf(round, log)

    expect(skins.settlement.perPlayerCents).toEqual({
      'p-ben': 700,
      'p-alice': -500,
      'p-carol': -200,
    })
    const won = skins.holeResults.filter((r) => r.kind === 'won')
    expect(won).toEqual([
      { hole: 3, kind: 'won', winnerId: 'p-ben', skins: 3, effective: 4 },
      { hole: 5, kind: 'won', winnerId: 'p-carol', skins: 2, effective: 4 },
      { hole: 6, kind: 'won', winnerId: 'p-alice', skins: 1, effective: 3 },
      { hole: 8, kind: 'won', winnerId: 'p-ben', skins: 2, effective: 4 },
    ])
  })

  /**
   * F3: corrections + retraction. 2 players, gross, no carryover ties still carry? No —
   * carryover ON. H1 A3/B4 → A wins. H2 tie → carry. H3 A5/B4 → B wins 2.
   * Correct H1 A→4: all-tie chain → H3 B wins 3.
   * Retract the correction: back to the original math.
   */
  it('F3: mid-round correction and retraction replay correctly', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [3, 4, 5], B: [4, 4, 4] }, [1, 2, 3])

    expect(skinsOf(round, log).settlement.perPlayerCents).toEqual({ 'p-a': -100, 'p-b': 100 })

    const correction = log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    expect(skinsOf(round, log).settlement.perPlayerCents).toEqual({ 'p-a': -300, 'p-b': 300 })

    log.append({ type: 'meta/retract', targetEventId: correction.id })
    expect(skinsOf(round, log).settlement.perPlayerCents).toEqual({ 'p-a': -100, 'p-b': 100 })
  })

  /**
   * Field-reported (Crooked Stick test round): one player missing on hole 1
   * must NOT block the game forever. Once play moves on, holes settle among
   * whoever posted; the missing player just can't win them.
   * h1: 5/5/5 posted, D missing → tie, carry · h2: 4/4/5/4 → tie, carry ·
   * h3: A2/B4/C5/D3 → A wins 3 skins.
   */
  it('a skipped player cannot win, holes settle once play moves on', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [5], B: [5], C: [5] }, [1]) // D never plays h1
    log.scoreByHole(round, { A: [4], B: [4], C: [5], D: [4] }, [2])
    log.scoreByHole(round, { A: [2], B: [4], C: [5], D: [3] }, [3])

    const skins = skinsOf(round, log)
    expect(skins.holeResults.slice(0, 3).map((r) => r.kind)).toEqual(['tied', 'tied', 'won'])
    expect(skins.holeResults[2]).toMatchObject({ winnerId: 'p-a', skins: 3 })
    expect(skins.settlement.perPlayerCents).toEqual({
      'p-a': 900,
      'p-b': -300,
      'p-c': -300,
      'p-d': -300,
    })
  })

  it('the frontier hole with partial scores stays pending', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })

    const skins = skinsOf(round, log)
    expect(skins.holeResults[0]).toEqual({ hole: 1, kind: 'pending' })
    expect(skins.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
  })

  it('a hole nobody scored is void once play moves on', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [3], B: [5] }, [2]) // h1 skipped entirely

    const skins = skinsOf(round, log)
    expect(skins.holeResults[0]).toEqual({ hole: 1, kind: 'void' })
    // h2 is worth only its own skin — the void hole added nothing to the pot
    expect(skins.holeResults[1]).toMatchObject({ kind: 'won', winnerId: 'p-a', skins: 1 })
  })

  it('completing the round finalizes a partially scored frontier hole', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    log.append({ type: 'round/completed' })

    const skins = skinsOf(round, log)
    expect(skins.holeResults[0]).toMatchObject({ kind: 'won', winnerId: 'p-a', skins: 1 })
  })

  it('carryover off: ties are simply dead', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: false } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 3], B: [4, 4] }, [1, 2])
    const skins = skinsOf(round, log)
    expect(skins.settlement.perPlayerCents).toEqual({ 'p-a': 100, 'p-b': -100 })
    expect(skins.carrying).toBe(0)
  })
})

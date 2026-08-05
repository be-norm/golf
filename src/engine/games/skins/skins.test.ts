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
    expect(skins.standings[0]).toMatchObject({ label: 'A', amountCents: 800, detail: '4 skins' })

    // Hole 9 ties with a skin on the pile and there is no hole left to win it.
    // Saying "1 carried" would promise it rolls somewhere; it doesn't — it
    // dies, and every money surface has to say so (MAI-38).
    expect(skins.carrying).toBe(1)
    expect(skins.carryDied).toBe(1)
    // bar recaps the latest decided hole, not the aggregate
    expect(skins.summaryParts).toEqual([{ label: 'H9', value: 'tied · 1 skin died unwon' }])
    expect(skins.holeSummary(9)).toEqual([
      'Tied — no outright winner',
      '↳ 1 skin died unwon — no hole left to win them',
    ])
    // ...and it reaches the settle screen and share card through the NOTES
    // channel, not as a zero-cent settlement line. settlement.lines is the
    // record of money that moved, and a dead pot moved none (MAI-40).
    expect(skins.notes).toEqual(['1 skin died unwon — no hole left to win them'])
    // pinned exactly, per the golden-fixture convention: the four holes that
    // were won, and nothing else — no dead-pot row among them
    expect(skins.settlement.lines.map((l) => l.label)).toEqual([
      'Hole 1 — A wins 1 skin',
      'Hole 4 — C wins 3 skins',
      'Hole 7 — A wins 3 skins',
      'Hole 8 — B wins 1 skin',
    ])
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
    // ledger explains the multi-skin win came from carried ties
    expect(skins.holeSummary(3)[1]).toBe('↳ this hole + 2 carried in from ties')
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

  /**
   * A pile is only dead when no hole is left to win it. Mid-round it is very
   * much alive and must keep reading as carried — the point of the carry is
   * that the next hole is worth more.
   */
  it('a live carry mid-round is carried, not dead', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 4], B: [4, 4] }, [1, 2]) // both tied, 7 holes left
    const skins = skinsOf(round, log)
    expect(skins.carrying).toBe(2)
    expect(skins.carryDied).toBe(0)
    expect(skins.summaryParts).toEqual([{ label: 'H2', value: 'tied · 2 carried' }])
    expect(skins.holeSummary(2)).toEqual(['Tied — 2 carried'])
    expect(skins.settlement.lines).toEqual([])
  })

  /**
   * Finishing early kills a live pile just as surely as tying the last hole —
   * completion finalizes the holes nobody reached, so there is no hole left to
   * win it on. The settle screen is the only place the group will look.
   */
  it('a carry outstanding when the round is finished early dies too', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 4, 4], B: [4, 4, 4] }, [1, 2, 3]) // 3 tied holes
    log.append({ type: 'round/completed' })
    const skins = skinsOf(round, log)

    expect(skins.carryDied).toBe(3)
    // narrated on the last hole anyone PLAYED, not on hole 9 which nobody saw
    expect(skins.holeSummary(3)).toEqual([
      'Tied — no outright winner',
      '↳ 3 skins died unwon — no hole left to win them',
    ])
    expect(skins.holeSummary(9)).toEqual(['No scores — hole void'])
    expect(skins.notes).toEqual(['3 skins died unwon — no hole left to win them'])
    // Nothing was won, so there are NO money lines — which is what lets the
    // settle panel still say "No money moved." truthfully, with the note
    // underneath explaining where the pot went.
    expect(skins.settlement.lines).toEqual([])
    expect(skins.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
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
    expect(skins.summaryParts).toEqual([{ label: 'H2', value: 'A wins 1 skin' }])
  })
})

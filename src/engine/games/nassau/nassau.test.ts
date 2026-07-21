import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { EventLog, makePlayers, makeRound } from '../../test/harness'

const game = (config: object) => ({
  type: 'nassau',
  config: { stakeCents: 500, teams: null, autoPress: false, ...config },
})

describe('nassau — golden fixtures (hand-verified)', () => {
  /**
   * N1: 1v1 gross, $5, no presses, full 18.
   * Front: A wins h1,h4,h6, B wins h3 → +2 → A wins $5.
   * Back: B wins h10,h12, A wins h13 → −1 → B wins $5.
   * Overall: +1 → A wins $5. Net: A +$5, B −$5.
   */
  it('N1: three bets, no presses', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [4, 4, 5, 3, 4, 4, 4, 4, 4, 5, 4, 5, 4, 4, 4, 4, 4, 4],
      B: [5, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    expect(d.settlement.lines).toHaveLength(3)
    // mini-bar shows match status per bet, not dollars
    expect(d.summary).toBe('F9: A wins ↑2 · B9: B wins ↑1 · 18: A wins ↑1')
  })

  /**
   * N2: same scores + a manual front press declared on hole 5.
   * Press spans h5–9: h5 tie, h6 A win, h7–9 ties → +1 → A +$5 more.
   */
  it('N2: manual press pays as its own bet', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [4, 4, 5, 3, 4, 4, 4, 4, 4, 5, 4, 5, 4, 4, 4, 4, 4, 4],
      B: [5, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4],
    })
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'nassau/press',
      data: { hole: 5, segment: 'front' },
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 1000, 'p-b': -1000 })
    expect(d.settlement.lines).toHaveLength(4)
  })

  /**
   * N3: auto-press, $2. A wins h1,h2 → F and O both hit +2 → presses @3.
   * All ties h3–h9. B wins h10,h11 → back hits −2 → press @12; O-press@3
   * reaches −2 at h11 → re-press @12. Ties h12–18.
   * Final: F +2 (A $2) · FP@3 push · Back −2 (B $2) · BP@12 push ·
   * O push · OP@3 −2 (B $2) · OPP@12 push. Net: A −$2, B +$2, 4 presses.
   */
  it('N3: auto-presses spawn at 2 down, presses press', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, games: [game({ stakeCents: 200, autoPress: true })] })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 4, 4, 4, 4, 4, 4, 4],
      B: [5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': -200, 'p-b': 200 })
    // decided bets paying: Front (+2), Back (−2), OP@3 (−2)
    expect(d.settlement.lines).toHaveLength(3)
    // bet ledger: 3 parents + 4 presses, presses indented under their nine
    expect(d.detailLines).toHaveLength(7)
    expect(d.detailLines!.filter((l) => l.depth === 1)).toHaveLength(4)
    expect(d.detailLines![0]).toEqual({ label: 'F9', value: 'A wins ↑2', depth: 0 })
    expect(d.detailLines![1]).toEqual({ label: 'Press @3', value: 'push', depth: 1 })
    // bar stays compact: parents only (no live presses at final)
    expect(d.summary).toBe('F9: A wins ↑2 · B9: B wins ↑2 · 18: push')
  })

  /**
   * N5: a hole where only one side posts a score goes to that side once
   * play moves on; a hole with no scores at all halves.
   */
  it('N5: missing scores — posted side wins, empty hole halves, money locks on close', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, holes: 'front9', games: [game({})] })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4] }, [1]) // B skips h1
    log.scoreByHole(round, { A: [4], B: [4] }, [2]) // play moved on; h2 halved
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    // A up 1 from the hole B never played — but NOTHING locked yet
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
    expect(d.summary).toBe('F9: A ↑1 · 7 to play')

    // finishing the round closes the bet → money locks
    log.append({ type: 'round/completed' })
    const done = deriveRound(round, log.events).derivations.get('game-1')!
    expect(done.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
  })

  /**
   * N6: golfer vocabulary — dormie when up exactly the holes remaining,
   * closed out when up more than remain.
   */
  it('N6: dormie and closed-out states', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, holes: 'front9', games: [game({})] })
    const log = new EventLog()
    // A wins 7 straight: after h7, up 7 with 2 to play → closed out
    log.scoreByHole(round, {
      A: [3, 3, 3, 3, 3, 3, 3],
      B: [4, 4, 4, 4, 4, 4, 4],
    })
    let d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.detailLines![0]!.value).toBe('A ↑7 · closed out')

    // fresh round: A up 2 after 7 → dormie (2 up, 2 to play)
    const round2 = makeRound({ players, holes: 'front9', games: [game({})] })
    const log2 = new EventLog()
    log2.scoreByHole(round2, {
      A: [3, 3, 4, 4, 4, 4, 4],
      B: [4, 4, 4, 4, 4, 4, 4],
    })
    d = deriveRound(round2, log2.events).derivations.get('game-1')!
    expect(d.detailLines![0]!.value).toBe('A ↑2 · dormie')
  })

  /**
   * N7: mid-round bar stays compact — parents only + live-press count;
   * the full ledger (incl. per-press status) lives in detailLines.
   */
  it('N7: compact bar with live-press chip mid-round', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, games: [game({ autoPress: true })] })
    const log = new EventLog()
    // A wins h1,h2 → F and O hit 2 → auto-presses @3 on both; h3 ties
    log.scoreByHole(round, { A: [4, 4, 4], B: [5, 5, 4] }, [1, 2, 3])
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.summary).toBe('F9: A ↑2 · B9: AS · 18: A ↑2 · 2 presses')
    expect(d.detailLines).toHaveLength(5)
    expect(d.detailLines![1]).toEqual({ label: 'Press @3', value: 'AS · 6 to play', depth: 1 })
  })

  /**
   * N4: 2v2 net best-ball off low; 9-hole round collapses to one Overall bet.
   * CHs: A0 B8 C4 D12 → off low: 0/8/4/12 over 9 holes.
   * Teams {A,D} vs {B,C}. Verifies best-ball + team stake per player.
   */
  it('N4: 9-hole 2v2 collapses to a single overall bet', () => {
    const players = makePlayers([
      { name: 'A', ch: 0 },
      { name: 'B', ch: 8 },
      { name: 'C', ch: 4 },
      { name: 'D', ch: 12 },
    ])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        {
          type: 'nassau',
          config: {
            stakeCents: 500,
            teams: { a: ['p-a', 'p-d'], b: ['p-b', 'p-c'] },
            autoPress: false,
          },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    const log = new EventLog()
    // A pars everything; others bogey everything. Front-9 SI ranks:
    // h3=1,h6=2,h1=3,h8=4,h4=5,h7=6,h2=7,h9=8,h5=9 (pars 4,4,5,3,4,4,3,5,4).
    // Strokes: B(8)=1 on ranks 1–8; C(4)=1 on ranks 1–4; D(12)=1 all + 2 on ranks 1–3.
    // Side A best net: 3,4,4,3,4,3,3,5,4 (D's double strokes bite on h1,h6).
    // Side B best net: 4,4,5,3,5,4,3,5,4.
    // A-side wins h1,h3,h5,h6; rest halved → Overall +4 → team A each +$5.
    log.scoreByHole(round, {
      A: [4, 4, 5, 3, 4, 4, 3, 5, 4],
      B: [5, 5, 6, 4, 5, 5, 4, 6, 5],
      C: [5, 5, 6, 4, 5, 5, 4, 6, 5],
      D: [5, 5, 6, 4, 5, 5, 4, 6, 5],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.lines).toHaveLength(1)
    expect(d.settlement.perPlayerCents).toEqual({
      'p-a': 500,
      'p-d': 500,
      'p-b': -500,
      'p-c': -500,
    })
  })

  /**
   * N8: 2v1 gross, $5, front9 (single Overall bet), pair {A,B} vs lone C.
   * The lone player plays each opponent for the stake, so a won bet swings
   * ±$10 for C and ±$5 per pair member — zero-sum across uneven sides.
   */
  const twoVsOne = (config: object) => ({
    type: 'nassau',
    config: {
      stakeCents: 500,
      teams: { a: ['p-a', 'p-b'], b: ['p-c'] },
      autoPress: false,
      ...config,
    },
  })

  it('N8a: pair beats the lone player → lone pays each of them', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({ players, holes: 'front9', games: [twoVsOne({})] })
    const log = new EventLog()
    // Pair best ball wins h1 & h2, halves h3–h9 → Overall +2 → pair wins.
    log.scoreByHole(round, {
      A: [4, 4, 4, 4, 4, 4, 4, 4, 4],
      B: [4, 4, 4, 4, 4, 4, 4, 4, 4],
      C: [5, 5, 4, 4, 4, 4, 4, 4, 4],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.lines).toHaveLength(1)
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': 500, 'p-c': -1000 })
    // zero-sum across the uneven split
    expect(Object.values(d.settlement.perPlayerCents).reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('N8b: lone player beats the pair → collects the stake from each', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({ players, holes: 'front9', games: [twoVsOne({})] })
    const log = new EventLog()
    // C wins h1 & h2, halves the rest → Overall −2 → lone C wins.
    log.scoreByHole(round, {
      A: [5, 5, 4, 4, 4, 4, 4, 4, 4],
      B: [5, 5, 4, 4, 4, 4, 4, 4, 4],
      C: [4, 4, 4, 4, 4, 4, 4, 4, 4],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': -500, 'p-b': -500, 'p-c': 1000 })
    expect(Object.values(d.settlement.perPlayerCents).reduce((a, b) => a + b, 0)).toBe(0)
  })
})

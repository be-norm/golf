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
    expect(d.summary).toBe('F9: A 2↑ · B9: B 1↑ · 18: A 1↑')
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
    expect(d.summary).toContain('4 press')
  })

  /**
   * N5: a hole where only one side posts a score goes to that side once
   * play moves on; a hole with no scores at all halves.
   */
  it('N5: missing scores — posted side wins, empty hole halves', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, holes: 'front9', games: [game({})] })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4] }, [1]) // B skips h1
    log.scoreByHole(round, { A: [4], B: [4] }, [2]) // play moved on; h2 halved
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    // 9-hole → single overall bet; A up 1 from the hole B never played
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    // single-bet rounds show holes to play
    expect(d.summary).toBe('F9: A 1↑ · 7 to play')
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
})

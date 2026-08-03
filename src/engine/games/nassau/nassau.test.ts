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

  /**
   * N9: the press OFFER (availableActions). A press is available whenever a
   * side is down by any amount — the 2-down convention is a recommendation,
   * not a gate — so `recommended` is the only thing that turns on at 2.
   *
   * A wins h1 (F9 +1, 18 +1), A wins h2 (F9 +2, 18 +2), B wins h3 & h4
   * (F9 0, 18 0). Offers are read on the frontier hole each time.
   */
  it('N9: presses are offered at any deficit, recommended at 2 down', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()

    // nothing scored: hole 1 is the frontier but no bet has started scoring
    const at = () => deriveRound(round, log.events).derivations.get('game-1')!.availableActions!()
    expect(at()).toEqual([])

    log.scoreByHole(round, { Ann: [4], Bob: [5] }, [1])
    const oneDown = at()
    expect(oneDown.map((a) => a.label)).toEqual(['Press F9', 'Press 18'])
    expect(oneDown.every((a) => a.recommended)).toBe(false)
    expect(oneDown[0]!.hole).toBe(2)
    expect(oneDown[0]!.detail).toBe('Bob 1 down · 8 to play')
    expect(oneDown[0]!.effect).toBe('New $5 bet · holes 2–9')
    expect(oneDown[1]!.effect).toBe('New $5 bet · holes 2–18')

    log.scoreByHole(round, { Ann: [4], Bob: [5] }, [2])
    const twoDown = at()
    expect(twoDown.every((a) => a.recommended)).toBe(true)
    expect(twoDown[0]!.detail).toBe('Bob 2 down · 7 to play')

    // back to all square → nothing to press, on either bet
    log.scoreByHole(round, { Ann: [5, 5], Bob: [4, 4] }, [3, 4])
    expect(at()).toEqual([])
  })

  /**
   * N10: a taken press stays on the list as an ENGAGED row carrying the events
   * that undo it — a mistap on a money bet must be reversible in place. It is
   * still one bet per (segment, hole), so the segment is offered fresh again
   * from the next tee.
   */
  it('N10: a taken press stays listed, engaged and undoable, then re-offers next hole', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()
    log.scoreByHole(round, { Ann: [4, 4], Bob: [5, 5] }, [1, 2])
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'nassau/press',
      data: { hole: 3, segment: 'front' },
    })
    const pressEventId = log.events[log.events.length - 1]!.id

    const [f9, overall] = at3()
    expect(f9!.label).toBe('Press F9')
    expect(f9!.taken).toBe(true)
    expect(f9!.recommended).toBe(false) // nothing left to nudge
    expect(f9!.undoEventIds).toEqual([pressEventId])
    expect(f9!.effect).toBe('Running $5 bet · holes 3–9')
    // the Overall is untouched and still a plain offer
    expect(overall!.label).toBe('Press 18')
    expect(overall!.taken).toBeUndefined()

    // play h3; still 2 down on F9 from the h4 tee → F9 offered fresh again
    log.scoreByHole(round, { Ann: [4], Bob: [4] }, [3])
    const h4 = deriveRound(round, log.events).derivations.get('game-1')!.availableActions!()
    expect(h4.map((a) => a.label)).toEqual(['Press F9', 'Press 18'])
    expect(h4.every((a) => !a.taken)).toBe(true)
    expect(h4[0]!.hole).toBe(4)

    function at3() {
      return deriveRound(round, log.events).derivations.get('game-1')!.availableActions!()
    }
  })

  /**
   * N10c: undoing a press. Retracting the press event un-does the bet entirely
   * — the ledger loses the row and the offer comes back on the table. This is
   * the compensation path of invariant #2, not a delete.
   */
  it('N10c: retracting the press event takes the bet back and re-opens the offer', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()
    log.scoreByHole(round, { Ann: [4, 4], Bob: [5, 5] }, [1, 2])
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'nassau/press',
      data: { hole: 3, segment: 'front' },
    })
    const pressed = deriveRound(round, log.events).derivations.get('game-1')!
    expect(pressed.detailLines!.map((l) => l.label)).toEqual(['F9', 'Press @3', 'B9', '18'])

    // toggle it back off, exactly as the sheet does
    const target = pressed.availableActions!()[0]!.undoEventIds![0]!
    log.append({ type: 'meta/retract', targetEventId: target })

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.detailLines!.map((l) => l.label)).toEqual(['F9', 'B9', '18'])
    const back = d.availableActions!()
    expect(back.map((a) => a.label)).toEqual(['Press F9', 'Press 18'])
    expect(back.every((a) => !a.taken)).toBe(true)
    expect(back[0]!.recommended).toBe(true) // 2 down again, and pressable again
  })

  /**
   * N10d: a press the RULES own is not the player's to take back. An auto-press
   * shows as running with no undo — and so does a hand-tapped press sitting in
   * a slot auto-press also wants, because retracting that event would only let
   * auto re-create the identical bet. Offering an undo there would be a control
   * that visibly does nothing.
   */
  it('N10d: presses auto-press owns are shown running but not undoable', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])

    // (a) plain auto-press: 2 down at h2 → press @3, no event behind it
    const auto = makeRound({ players, games: [game({ autoPress: true })] })
    const autoLog = new EventLog()
    autoLog.scoreByHole(auto, { Ann: [4, 4], Bob: [5, 5] }, [1, 2])
    const rows = deriveRound(auto, autoLog.events).derivations.get('game-1')!.availableActions!()
    expect(rows.map((a) => [a.label, a.taken ?? false, a.undoEventIds ?? null])).toEqual([
      ['Press F9', true, []],
      ['Press 18', true, []],
    ])
    expect(rows.every((a) => !a.recommended)).toBe(true) // nothing left to nudge
    expect(rows[0]!.effect).toBe('Running $5 bet · holes 3–9')

    // (b) hand-tapped at 1 down, then a score correction makes it 2 down, so
    // auto now wants the same slot. The tap is no longer what holds the bet up.
    const fixed = makeRound({ players, games: [game({ autoPress: true })] })
    const log = new EventLog()
    log.scoreByHole(fixed, { Ann: [4, 4], Bob: [5, 4] }, [1, 2]) // only 1 down
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'nassau/press',
      data: { hole: 3, segment: 'front' },
    })
    const beforeFix = deriveRound(fixed, log.events).derivations.get('game-1')!.availableActions!()
    expect(beforeFix[0]!.undoEventIds).toHaveLength(1) // theirs alone — undoable

    log.append({ type: 'score/set', playerId: 'p-bob', hole: 2, gross: 5 }) // now 2 down
    const afterFix = deriveRound(fixed, log.events).derivations.get('game-1')!.availableActions!()
    expect(afterFix[0]!.label).toBe('Press F9')
    expect(afterFix[0]!.taken).toBe(true)
    expect(afterFix[0]!.undoEventIds).toEqual([]) // auto owns it now — no false promise
  })

  /**
   * N10b: every live bet is its own offer — pressing one must never drag the
   * others in. You are offered the nine you are STANDING ON plus the overall;
   * the other nine's bet is not live, so it is never in the list (and a
   * finished F9 can't be pressed from the 12th tee).
   */
  it('N10b: each bet presses independently — the nine in play, plus the overall', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()
    // halve the front, then Bob loses h10 and h11 → B9 and 18 both 2 down
    log.scoreByHole(
      round,
      {
        Ann: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
        Bob: [4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5],
      },
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    )
    const back = deriveRound(round, log.events).derivations.get('game-1')!.availableActions!()
    // the front nine is over — not offered, however far anyone is down
    expect(back.map((a) => a.label)).toEqual(['Press B9', 'Press 18'])
    expect(back.map((a) => a.data.segment)).toEqual(['back', 'overall'])
    expect(back[0]!.effect).toBe('New $5 bet · holes 12–18')
    expect(back[1]!.effect).toBe('New $5 bet · holes 12–18')

    // take ONLY the B9: the overall stays on offer and gains no bet
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'nassau/press',
      data: { hole: 12, segment: 'back' },
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    const after = d.availableActions!()
    // B9 stays listed as engaged; the overall is still a plain, untaken offer
    expect(after.map((a) => [a.label, a.taken ?? false])).toEqual([
      ['Press B9', true],
      ['Press 18', false],
    ])
    // exactly one new bet, under the back nine — the overall gained nothing
    expect(d.detailLines!.map((l) => l.label)).toEqual(['F9', 'B9', 'Press @12', '18'])
  })

  /**
   * N11 — regression, MAI-34. A parent bet and one of ITS OWN presses can both
   * cross ±2 on the same hole, and each wants to open a press on the next hole
   * of the same segment. That is ONE bet, not two: same segment, same span,
   * same stake, indistinguishable in the ledger.
   *
   * $2, auto-press, 1v1. A wins h1,h2 → F9 +2 and 18 +2 → presses @3.
   * B wins h3,h4 → F9 0 (P@3 −2 → press @5); B wins h5,h6 → F9 −2 (prev −1,
   * fires) AND P@5 −2 (prev −1, fires), both wanting front @7.
   * Halved h7–h18.
   *
   * Front bets: F9 (−2, B), P@3 (−4, B), P@5 (−2, B), P@7 (0, push) = 4 rows.
   * Overall runs the same shape: 18 (−2), P@3 (−4), P@5 (−2), P@7 (push).
   * Money: B wins F9, FP@3, FP@5, 18, OP@3, OP@5 = 6 × $2 = $12 to B.
   * With the bug there would be a SEVENTH front row and an eighth overall row,
   * both pushes — harmless to zero-sum, which is why the fuzz never saw it.
   */
  it('N11: a parent and its own press crossing 2 down together open ONE press', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, games: [game({ stakeCents: 200, autoPress: true })] })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [4, 4, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
      B: [5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    // exactly one press per (segment, startHole) — no duplicate @7 in either
    // segment, and presses listed in the order they started
    expect(d.detailLines!.map((l) => l.label)).toEqual([
      'F9',
      'Press @3',
      'Press @5',
      'Press @7',
      'B9',
      '18',
      'Press @3',
      'Press @5',
      'Press @7',
    ])

    // magnitude, not just zero-sum: the bug leaves zero-sum intact
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': -1200, 'p-b': 1200 })
    expect(d.settlement.lines).toHaveLength(6)
  })

  /**
   * N12: press identity is independent of what created it. A hand-tapped press
   * and an auto-press landing on the same segment+hole are one bet — the
   * manual one wins the slot, and the group writes down one press either way.
   */
  it('N12: a manual press and an auto-press on the same segment+hole are one bet', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const scores = {
      A: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
      B: [5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    }
    // auto-press alone: A goes 2 up on F9 and 18 at h2 → presses @3
    const autoOnly = makeRound({ players, games: [game({ autoPress: true })] })
    const autoLog = new EventLog()
    autoLog.scoreByHole(autoOnly, scores)
    const auto = deriveRound(autoOnly, autoLog.events).derivations.get('game-1')!

    // same round, but the group ALSO tapped press on front @3 by hand
    const both = makeRound({ players, games: [game({ autoPress: true })] })
    const bothLog = new EventLog()
    bothLog.scoreByHole(both, scores)
    bothLog.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'nassau/press',
      data: { hole: 3, segment: 'front' },
    })
    const d = deriveRound(both, bothLog.events).derivations.get('game-1')!

    expect(d.detailLines).toEqual(auto.detailLines)
    expect(d.settlement.perPlayerCents).toEqual(auto.settlement.perPlayerCents)
  })

  /**
   * N13: Nassau blocks on nothing, and the ledger explains a press by the
   * deficit that caused it — including when the cause is another PRESS being
   * 2 down while the parent sits all square (h5 below: F9 is level, P@3 is −2).
   */
  it('N13: no blocking inputs; the ledger names who was down when a press opened', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({ stakeCents: 200, autoPress: true })] })
    const log = new EventLog()
    log.scoreByHole(round, {
      Ann: [4, 4, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
      Bob: [5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.requiredInputs()).toEqual([])

    // h3: the PARENTS were 2 down (Ann up 2) → Bob is the trailing side
    expect(d.holeSummary(3)).toContain('Press @3 starts (Bob 2 down → auto-press)')
    // h5: F9 itself is back to all square — the press @3 is what hit 2 down.
    // Reading the parent alone would have printed "AS" as the reason.
    expect(d.holeSummary(5)).toContain('Press @5 starts (Ann 2 down → auto-press)')
  })
})

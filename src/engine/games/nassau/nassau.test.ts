import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { EventLog, makePlayers, makeRound } from '../../test/harness'

const game = (config: object) => ({
  type: 'nassau',
  config: { stakeCents: 500, teams: null, autoPress: false, ...config },
})

/**
 * A match that went the distance, e.g. "2 up". The space is NON-BREAKING so
 * the share card's painter cannot strand the "up" on its own line — spelled
 * as an escape in these expectations because the character is invisible in
 * source, and a golden test you cannot read is worse than no golden test.
 */
const up = (n: number) => `${n}\u00A0up`

describe('nassau — golden fixtures (hand-verified)', () => {
  /**
   * N1: 1v1 gross, $5, no presses, full 18.
   * Front: A wins h1,h4,h6, B wins h3 → +2. A is 2 up standing on 9 with only
   *   h9 left, so the front is CLOSED OUT 2&1 on h8 — B cannot catch up.
   * Back: B wins h10,h12, A wins h13 → −1, decided only when the holes run
   *   out → B wins 1 up.
   * Overall: +1 over 18 → A wins 1 up. Net: A +$5, B −$5.
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
    // mini-bar shows match status per bet, not dollars — and names a close in
    // golf's own notation: 2&1 for the front, "1 up" for bets that went the
    // distance
    expect(d.summary).toBe(`F9: A wins 2&1 · B9: B wins ${up(1)} · 18: A wins ${up(1)}`)
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
   *
   * Each 2-up bet closes on the second-to-last hole of its stretch — 2&1 —
   * rather than waiting for the last hole it can no longer lose: F9 on h8,
   * B9 and OP@3 on h17. Same winners, same $2, named the way it was won.
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
    expect(d.detailLines![0]).toEqual({ label: 'F9', value: 'A wins 2&1', depth: 0 })
    expect(d.detailLines![1]).toEqual({ label: 'Press @3', value: 'push', depth: 1 })
    // bar stays compact: parents only (no live presses at final)
    expect(d.summary).toBe('F9: A wins 2&1 · B9: B wins 2&1 · 18: push')
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
   * N6: golfer vocabulary — dormie when up exactly the holes remaining, and
   * WON when up more than remain. The close is the whole point (MAI-38): it
   * names the margin, freezes it, and settles the money on the spot.
   *
   * A wins 5 straight on a front-9 round (one Overall bet over h1–h9):
   * after h5 A is 5 up with 4 to play → 5 > 4, so the match is over, 5&4.
   * The group keeps playing (h6, h7 are scored) but this bet is settled.
   */
  it('N6: a decided bet is won, frozen and paid on the closing hole', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, holes: 'front9', games: [game({})] })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [3, 3, 3, 3, 3, 3, 3],
      B: [4, 4, 4, 4, 4, 4, 4],
    })
    let d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.detailLines![0]!.value).toBe('A wins 5&4')
    // the money moves NOW, with h8 and h9 still unplayed — the old rule waited
    // for the holes to run out and reported $0 for a match already over
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    expect(d.holeSummary(5)).toContain('F9 closes — A wins 5&4')
    // and the bar says it too, not just the ledger
    expect(d.summary).toBe('F9: A wins 5&4')

    // FROZEN: B takes the two dead holes. A won 5&4 and still wins 5&4 — the
    // margin is what it was when the match ended, not a running total.
    log.scoreByHole(round, { A: [5, 5], B: [3, 3] }, [8, 9])
    d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.detailLines![0]!.value).toBe('A wins 5&4')
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })

    // fresh round: A up 2 after 7 → dormie (2 up, 2 to play) — still live,
    // because 2 is not MORE than 2. B can still halve it.
    const round2 = makeRound({ players, holes: 'front9', games: [game({})] })
    const log2 = new EventLog()
    log2.scoreByHole(round2, {
      A: [3, 3, 4, 4, 4, 4, 4],
      B: [4, 4, 4, 4, 4, 4, 4],
    })
    const dormie = deriveRound(round2, log2.events).derivations.get('game-1')!
    expect(dormie.detailLines![0]!.value).toBe('A ↑2 · dormie')
    expect(dormie.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
  })

  /**
   * N14: one bet closing does not close the others. The front nine is won 3&2
   * on h7 and pays there, while the back nine and the overall are still live
   * and still say so — the round's dollars are non-zero at the 8th tee.
   *
   * A wins h1,h2,h3 → F9 +3, 18 +3. h4–h7 halved. After h7 the front has 2
   * holes left and A is 3 up → over. The overall has 11 left → nowhere near.
   */
  it('N14: a closed bet pays mid-round while the other bets keep running', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()
    log.scoreByHole(
      round,
      { Ann: [4, 4, 4, 4, 4, 4, 4], Bob: [5, 5, 5, 4, 4, 4, 4] },
      [1, 2, 3, 4, 5, 6, 7],
    )
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.detailLines).toEqual([
      { label: 'F9', value: 'Ann wins 3&2', depth: 0 },
      { label: 'B9', value: 'AS · 9 to play', depth: 0 },
      { label: '18', value: 'Ann ↑3 · 11 to play', depth: 0 },
    ])
    expect(d.summary).toBe('F9: Ann wins 3&2 · B9: AS · 18: Ann ↑3')
    // one bet's stake, mid-round, with 11 holes still to play
    expect(d.settlement.perPlayerCents).toEqual({ 'p-ann': 500, 'p-bob': -500 })
    expect(d.settlement.lines).toHaveLength(1)
    expect(d.holeSummary(7)).toContain('F9 closes — Ann wins 3&2')
    // the per-player status line marks the settled bet without an arrow —
    // "↓3 up" would read as a contradiction
    expect(d.standings.find((s) => s.id === 'p-ann')!.detail).toBe('F9 ✓3&2 · B9 AS · 18 ↑3')
    expect(d.standings.find((s) => s.id === 'p-bob')!.detail).toBe('F9 ✗3&2 · B9 AS · 18 ↓3')
  })

  /**
   * N15: a segment whose bets are all decided is no longer pressable — there
   * is nothing left to press. But a LIVE press under a closed parent keeps the
   * segment alive, and pressing it is legal: you press the bet you're down on.
   *
   * Both halves share one scoreline — Ann wins h1–h5, so the front (5 up, 4 to
   * play) is over 5&4 on h5.
   */
  it('N15: a decided segment stops offering presses; a live press under it does not', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const scores = { Ann: [4, 4, 4, 4, 4], Bob: [5, 5, 5, 5, 5] }
    const holes = [1, 2, 3, 4, 5]

    // (a) nothing but the parent bets: the front is dead, the overall is not
    const dead = makeRound({ players, games: [game({})] })
    const deadLog = new EventLog()
    deadLog.scoreByHole(dead, scores, holes)
    const deadActions = deriveRound(dead, deadLog.events)
      .derivations.get('game-1')!
      .availableActions!()
    expect(deadActions.map((a) => a.label)).toEqual(['Press 18'])

    // (b) same scores, but Bob had pressed the front from h5 — that press is
    // live and 1 down, so the front is on the table again
    const alive = makeRound({ players, games: [game({})] })
    const aliveLog = new EventLog()
    aliveLog.scoreByHole(alive, scores, holes)
    aliveLog.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'nassau/press',
      data: { hole: 5, segment: 'front' },
    })
    const d = deriveRound(alive, aliveLog.events).derivations.get('game-1')!
    const live = d.availableActions!()
    expect(live.map((a) => a.label)).toEqual(['Press F9', 'Press 18'])
    // The reason quoted is the LIVE press's deficit, not the dead parent's —
    // and it SAYS so. Without naming the bet this offer reads "Press F9 · Bob
    // 1 down" directly under a ledger line saying "F9 · Ann wins 5&4", which
    // looks like the app forgot the match is over.
    expect(live[0]!.detail).toBe('Bob 1 down on Press @5 · 4 to play')
    expect(d.detailLines).toEqual([
      { label: 'F9', value: 'Ann wins 5&4', depth: 0 },
      { label: 'Press @5', value: 'Ann ↑1 · 4 to play', depth: 1 },
      { label: 'B9', value: 'AS · 9 to play', depth: 0 },
      { label: '18', value: 'Ann ↑5 · 13 to play', depth: 0 },
    ])
  })

  /**
   * N16: 2 down with 1 to play is a CLOSE, not a press. Both rules fire on the
   * same hole — the bet hits ±2 (auto-press's trigger) and simultaneously runs
   * out of room (2 > 1) — and the close wins: you cannot press a match that is
   * over. Without the guard the group would be booked into a phantom bet over
   * a hole that no longer decides anything.
   *
   * Front-9 round (one Overall bet, h1–h9), auto-press ON. Ann wins h1, h2–h7
   * halved, Ann wins h8 → 2 up with only h9 left.
   */
  it('N16: a bet closing 2&1 opens no auto-press on its last hole', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, holes: 'front9', games: [game({ autoPress: true })] })
    const log = new EventLog()
    log.scoreByHole(
      round,
      { Ann: [4, 4, 4, 4, 4, 4, 4, 4], Bob: [5, 4, 4, 4, 4, 4, 4, 5] },
      [1, 2, 3, 4, 5, 6, 7, 8],
    )
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    // exactly one bet — no "Press @9" spawned off a match that just ended
    expect(d.detailLines).toEqual([{ label: 'F9', value: 'Ann wins 2&1', depth: 0 }])
    expect(d.settlement.perPlayerCents).toEqual({ 'p-ann': 500, 'p-bob': -500 })
    // and standing on the 9th tee there is nothing to press by hand either
    expect(d.availableActions!()).toEqual([])
  })

  /**
   * N17: finishing early must not invent a margin. "2&1" is a claim that a real
   * hole clinched the match with one left to play. Abandon an 18 after five
   * holes and `round/completed` finalizes the other thirteen at once — every
   * bet runs out of room on a hole nobody stood on. The honest report is where
   * the bet actually ended: 2 up.
   */
  it('N17: a round finished early reports where it ended, not a fictional margin', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()
    // Ann wins h1 and h2, h3–h5 halved, then the group packs it in
    log.scoreByHole(round, { Ann: [4, 4, 4, 4, 4], Bob: [5, 5, 4, 4, 4] }, [1, 2, 3, 4, 5])
    log.append({ type: 'round/completed' })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.detailLines).toEqual([
      { label: 'F9', value: `Ann wins ${up(2)}`, depth: 0 },
      { label: 'B9', value: 'push', depth: 0 },
      { label: '18', value: `Ann wins ${up(2)}`, depth: 0 },
    ])
    // no bet may quote a to-play count off holes nobody played. Matched as the
    // MARGIN pattern rather than a bare '&', which a team side ("Ann & Bob")
    // also contains — that would pass here by luck and break on a 2v2 fixture.
    expect(d.detailLines!.every((l) => !/\d&\d/.test(l.value))).toBe(true)
    // the money is unaffected — only the sentence describing it
    expect(d.settlement.perPlayerCents).toEqual({ 'p-ann': 1000, 'p-bob': -1000 })
  })

  /**
   * N18: a side of two WIN, one player WINS. The bar, the ledger and the
   * settlement label all render one sentence from one helper, so the verb (and
   * the bet's name) cannot disagree between them.
   */
  it('N18: a 2v2 close agrees with itself across the bar, ledger and money', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cy' }, { name: 'Dee' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [game({ teams: { a: ['p-ann', 'p-bob'], b: ['p-cy', 'p-dee'] } })],
    })
    const log = new EventLog()
    log.scoreByHole(
      round,
      { Ann: [4, 4, 4, 4, 4], Bob: [4, 4, 4, 4, 4], Cy: [5, 5, 5, 5, 5], Dee: [5, 5, 5, 5, 5] },
      [1, 2, 3, 4, 5],
    )
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.detailLines![0]!.value).toBe('Ann & Bob win 5&4')
    expect(d.summary).toBe('F9: Ann & Bob win 5&4')
    // the settlement names the bet the way the ledger does — a nine-hole
    // round's single bet is the nine that was played, not "Overall"
    expect(d.settlement.lines[0]!.label).toBe('F9 — Ann & Bob win 5&4')
    // ...and so does the per-player status line, which had kept its own copy
    // of the segment label and called this bet "18"
    expect(d.standings[0]!.detail).toBe('F9 ✓5&4')
  })

  /**
   * N19: a pushed bet reports on the last hole of ITS OWN stretch. The front
   * nine finishes level on 9, not on 18 — piling every pushed front-nine bet
   * and press onto the final row of the round is the ledger telling the group
   * their front nine was decided on the 18th green.
   */
  it('N19: a push closes on the last hole of its own nine', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({})] })
    const log = new EventLog()
    const flat = Array(18).fill(4)
    log.scoreByHole(round, { Ann: flat, Bob: flat }) // every hole halved
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.holeSummary(9)).toContain('F9 closes — push')
    expect(d.holeSummary(18)).toContain('B9 closes — push')
    expect(d.holeSummary(18)).toContain('18 closes — push')
    // the front's push does NOT also land on 18
    expect(d.holeSummary(18)).not.toContain('F9 closes — push')
  })

  /**
   * N20: the front nine and the overall both open a press on the same hole, so
   * a bare "Press @3 closes" cannot say which bet just paid. These notes are a
   * flat per-hole list — the same reason the press-START note names its
   * segment.
   */
  it('N20: a closing press names its segment, like the note that opened it', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game({ autoPress: true })] })
    const log = new EventLog()
    // Bob wins the whole front: F9 and 18 each auto-press at h3, and the F9
    // press is itself over by h6 (4 up, 3 to play)
    log.scoreByHole(
      round,
      { Ann: [5, 5, 5, 5, 5, 5, 5, 5, 5], Bob: [4, 4, 4, 4, 4, 4, 4, 4, 4] },
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    )
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    // both presses announce themselves by segment on the hole they start
    expect(d.holeSummary(3)).toContain('F9 press @3 starts (Ann 2 down → auto-press)')
    expect(d.holeSummary(3)).toContain('18 press @3 starts (Ann 2 down → auto-press)')
    // and the one that closes says which one it was
    expect(d.holeSummary(6)).toContain('F9 press @3 closes — Bob wins 4&3')
  })

  /**
   * N21: the reported screen. Auto-press ON, win h1–h3, halve h4–h7 — so the
   * front auto-pressed at h3 (2 up at h2) and is then WON 3&2 at h7 while that
   * press is still live and 1 down. Standing on the 8th tee the front is
   * legitimately pressable: you press the bet you're down on, and that bet is
   * the press, not the finished match.
   *
   * What must never happen is the offer saying "Press F9 · Colby 1 down"
   * directly under a ledger reading "F9 · Benjamin wins 3&2" — two true
   * statements that look like a contradiction because neither names its bet.
   */
  it('N21: an offer under a won parent says which bet is actually down', () => {
    const players = makePlayers([{ name: 'Benjamin' }, { name: 'Colby' }])
    const round = makeRound({ players, games: [game({ autoPress: true })] })
    const log = new EventLog()
    log.scoreByHole(
      round,
      { Benjamin: [4, 4, 4, 4, 4, 4, 4], Colby: [5, 5, 5, 4, 4, 4, 4] },
      [1, 2, 3, 4, 5, 6, 7],
    )
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    // the front is won, and its press is still running
    expect(d.detailLines![0]).toEqual({ label: 'F9', value: 'Benjamin wins 3&2', depth: 0 })
    expect(d.detailLines![1]).toEqual({
      label: 'Press @3',
      value: 'Benjamin ↑1 · 2 to play',
      depth: 1,
    })

    const offers = d.availableActions!()
    expect(offers.map((a) => a.label)).toEqual(['Press F9', 'Press 18'])
    // the front offer names the live press it is really about...
    expect(offers[0]!.detail).toBe('Colby 1 down on Press @3 · 2 to play')
    expect(offers[0]!.effect).toBe('New $5 bet · holes 8–9')
    expect(offers[0]!.recommended).toBe(false)
    // ...while the overall, whose own parent is the bet that's down, doesn't
    // need naming and is at the 2-down convention, so it gets the nudge
    expect(offers[1]!.detail).toBe('Colby 3 down · 11 to play')
    expect(offers[1]!.recommended).toBe(true)
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

  /**
   * N8c: the press offer quotes the stake to the side being invited to press.
   * A lone player books the bet against EACH opponent, so a $5 press costs them
   * $10 — and 2v1 is the default the moment a third player joins. Saying "$5"
   * in the line meant to state what you're signing up for is the wrong number.
   */
  it('N8c: a lone player is quoted their own exposure, not the pair’s', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({ players, holes: 'front9', games: [twoVsOne({})] })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 4], B: [4, 4], C: [5, 5] }, [1, 2]) // lone C is 2 down
    const offer = deriveRound(round, log.events).derivations.get('game-1')!.availableActions!()
    expect(offer).toHaveLength(1)
    expect(offer[0]!.detail).toBe('C 2 down · 7 to play')
    expect(offer[0]!.effect).toBe('New $10 bet · holes 3–9')

    // and that is exactly what it settles: C pays $10 per bet, each of the
    // pair collects $5 — the quote and the money agree
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'nassau/press',
      data: { hole: 3, segment: 'overall' },
    })
    log.scoreByHole(
      round,
      { A: [4, 4, 4, 4, 4, 4, 4], B: [4, 4, 4, 4, 4, 4, 4], C: [5, 5, 5, 5, 5, 5, 5] },
      [3, 4, 5, 6, 7, 8, 9],
    )
    const done = deriveRound(round, log.events).derivations.get('game-1')!
    expect(done.settlement.perPlayerCents).toEqual({ 'p-a': 1000, 'p-b': 1000, 'p-c': -2000 })
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

    // and once hole 3 is played, the LEDGER must agree with the sheet about who
    // owns that bet. Authorship is ownership, not who tapped first — reading the
    // bet id would say "pressed" here while the sheet badges the same bet "auto".
    log.scoreByHole(fixed, { Ann: [4], Bob: [4] }, [3])
    const d = deriveRound(fixed, log.events).derivations.get('game-1')!
    expect(d.holeSummary(3)).toContain('F9 press @3 starts (Bob 2 down → auto-press)')
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
    expect(d.holeSummary(3)).toContain('F9 press @3 starts (Bob 2 down → auto-press)')
    // h5: F9 itself is back to all square — the press @3 is what hit 2 down.
    // Reading the parent alone would have printed "AS" as the reason, so the
    // note NAMES the bet that was down. "Ann 2 down" beside a level F9 is the
    // kind of line that gets an app argued with on the 5th tee.
    expect(d.holeSummary(5)).toContain('F9 press @5 starts (Ann 2 down on Press @3 → auto-press)')
  })

  /**
   * N14: a Nassau over a round that teed off on 10 — the ticket's whole point.
   *
   * Play order is [10…18, 1…9]. The three bets are the two nines WALKED plus
   * the eighteen: the first bet covers 10–18, the second covers 1–9. Splitting
   * by hole number instead would settle the group's opening bet with the last
   * nine holes they play, which is exactly the "bets don't carry past the turn"
   * complaint MAI-41 exists to fix.
   *
   * The nines are named ordinally here, not F9/B9. Holes 10–18 are not this
   * round's front nine in any sense the group would recognise, and calling
   * 1–9 "B9" while they walk it last would be a plain lie.
   *
   * Card: A wins the first three walked (10, 11, 12) → 1st9 +3. B wins the
   * first two of the second nine (1, 2) → 2nd9 −2. Everything else halves.
   *   1st9:  A +3 over nine holes. After hole 14 — the fifth walked — A is 3 up
   *          with 4 left; decided when 3 > to-play, i.e. after hole 15 (3 left)
   *          no, after 16 (2 left) yes → 3&2 on hole 16. A +$5.
   *   2nd9:  B +2, decided on hole 7 (the sixteenth walked) with 2 left → 2&2?
   *          B is 2 up after hole 2 with 7 left, so it runs on and closes when
   *          2 > to-play → after hole 7, 2 left → no; after hole 8, 1 left → 2&1.
   *          B +$5.
   *   18:    A +3 −2 = +1 over eighteen → A wins 1 up at the end. A +$5.
   * Net: A +$5, B −$5.
   */
  it('N14: an eighteen from the 10th tee bets the two nines it walked', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, startHole: 10, games: [game({})] })
    const log = new EventLog()
    // scored in PLAY order — scoreByHole reads the round's own hole list
    log.scoreByHole(round, {
      A: [4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 4, 4, 4, 4, 4, 4, 4],
      B: [5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    expect(d.summary).toBe(`1st9: A wins 3&2 · 2nd9: B wins 2&1 · 18: A wins ${up(1)}`)
    // the first bet was decided on hole 16 — a hole in the opening nine walked
    expect(d.holeSummary(16)).toContain('1st9 closes — A wins 3&2')
  })

  /**
   * N15: a press offer on a wrapped round quotes holes that actually exist.
   *
   * Standing on hole 12 of a round that teed off on 10, the overall bet still
   * has holes 12–18 and then 1–9 in front of it. The old phrasing took the
   * first and last of the span and rendered "holes 12–9" — a range that reads
   * backwards and names nothing. It is now the two runs it really is.
   *
   * The nine's own offer is unaffected: 12–18 is still one plain run.
   */
  it('N15: names a wrapped stretch as the runs it is, not "holes 12–9"', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, startHole: 10, games: [game({})] })
    const log = new EventLog()
    // B goes 2 down over the first two walked, so a press is on offer at 12
    log.scoreByHole(round, { A: [4, 4], B: [5, 5] }, [10, 11])
    const offers = deriveRound(round, log.events).derivations.get('game-1')!.availableActions!()

    expect(offers.map((o) => o.label)).toEqual(['Press 1st9', 'Press 18'])
    expect(offers[0]!.effect).toBe('New $5 bet · holes 12–18')
    expect(offers[1]!.effect).toBe('New $5 bet · holes 12–18, 1–9')
  })
})

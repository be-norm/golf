import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { EventLog, makePlayers, makeRound } from '../../test/harness'
import type { HandicapSettings } from '../../core/types'

const game = (config: object = {}) => ({
  type: 'matchPlay',
  config: { stakeCents: 500, teams: null, ...config },
})

/**
 * A match that went the distance, e.g. "2 up". The space is NON-BREAKING so the
 * share card's painter cannot strand the "up" on its own line — spelled as an
 * escape in these expectations because the character is invisible in source,
 * and a golden test you cannot read is worse than no golden test.
 */
const up = (n: number) => `${n}\u00A0up`

const NET: HandicapSettings = { mode: 'net', allowancePct: 100, reference: 'offLow' }

/** n copies of a score, for cards whose interest is in a handful of holes. */
const flat = (n: number, gross: number) => Array.from({ length: n }, () => gross)

describe('match play — golden fixtures (hand-verified)', () => {
  /**
   * MP1: the close, and the two holes that cannot undo it.
   *
   * A wins h1,h2,h3 → 3 up. h4–h16 halved. After h16 the card has two holes
   * left and A is 3 up, so the match is DECIDED there: 3&2, and it pays there.
   * B then wins h17 and h18 — which must move nothing. Reading `holesRemaining`
   * before `closedAt`, or letting a closed match keep scoring, would report
   * "1 up" and pay the wrong margin while staying perfectly zero-sum.
   */
  it('MP1: closes 3&2, and the last two holes cannot move it', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, games: [game()] })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [...flat(16, 4), 5, 5],
      B: [5, 5, 5, ...flat(15, 4)],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    expect(d.settlement.lines).toHaveLength(1)
    expect(d.settlement.lines[0]!.label).toBe('A wins 3&2')
    expect(d.detailLines).toEqual([{ label: '18', value: 'A wins 3&2' }])
    expect(d.summary).toBe('18: A wins 3&2')
    expect(d.standings.find((s) => s.id === 'p-a')!.detail).toBe('✓3&2')
    expect(d.standings.find((s) => s.id === 'p-b')!.detail).toBe('✗3&2')
    expect(d.holeSummary(16)).toEqual(['Halved', 'Match closes — A wins 3&2'])
    // h17 went to B and says so — but the match recorded no new position for
    // it, because a decided match is inert
    expect(d.holeSummary(17)).toEqual(['B wins the hole'])
    expect(d.holeSummary(18)).toEqual(['B wins the hole'])
  })

  /**
   * MP2: a match that goes the distance is "N up", never "N&0".
   *
   * Halved through h16, then A takes h17 and h18 → 2 up with nothing left. The
   * to-play count is 0, so the margin degrades to the "up" form — and that
   * form's space must be non-breaking.
   */
  it('MP2: a match that goes the distance is "2 up"', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, games: [game()] })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: flat(18, 4),
      B: [...flat(16, 4), 5, 5],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    expect(d.detailLines![0]!.value).toBe(`A wins ${up(2)}`)
    // matched as the margin PATTERN rather than a bare "&": a team side name
    // ("Ann & Bob") contains one of those too
    expect(/\d&\d/.test(d.detailLines![0]!.value)).toBe(false)
    expect(d.detailLines![0]!.value).toContain('\u00A0')
  })

  /**
   * MP3: level at the end is a push — it never "closes", and it pays nothing.
   *
   * Every hole halved. `closedAt` stays undefined (nobody won it), so the match
   * is decided only by running out of holes, which is `holesRemaining === 0` —
   * and that number is re-derived after the walk. Forget the re-derive and
   * `newMatch`'s seed leaves it at 18 forever: the match reads as live at the
   * end of the round, prints no push and files no close note.
   */
  it('MP3: level at the end is a push and pays nothing', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, games: [game()] })
    const log = new EventLog()
    log.scoreByHole(round, { A: flat(18, 4), B: flat(18, 4) })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.settlement.lines).toEqual([])
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
    expect(d.detailLines).toEqual([{ label: '18', value: 'push' }])
    expect(d.standings.find((s) => s.id === 'p-a')!.detail).toBe('AS')
    expect(d.holeSummary(18)).toEqual(['Halved', 'Match closes — push'])
    // the settle panel says it in the ledger, so there is nothing left for the
    // round-level narration channel to add
    expect(d.notes).toBeUndefined()
  })

  /**
   * MP4: 2v2 best ball — a pair WIN, and only their better ball counts.
   *
   * Bob's 6s must never reach the match: the side posts Ann's 4 against Cy and
   * Dee's 5, so A takes h1–h5 → 5 up with four of the nine left, decided 5&4 on
   * h5 while h6–h9 have no scores at all. If the loser's own ball counted, or
   * if a side's worst ball leaked in, this would be all square.
   */
  it('MP4: 2v2 best ball — a pair win, and the worse ball never counts', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cy' }, { name: 'Dee' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [game({ teams: { a: ['p-ann', 'p-bob'], b: ['p-cy', 'p-dee'] } })],
    })
    const log = new EventLog()
    log.scoreByHole(round, {
      Ann: flat(5, 4),
      Bob: flat(5, 6),
      Cy: flat(5, 5),
      Dee: flat(5, 5),
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.detailLines).toEqual([{ label: 'F9', value: 'Ann & Bob win 5&4' }])
    // the verb agrees with the side's SIZE — "Ann & Bob wins 5&4" is what a
    // hardcoded "wins" produces on every 2v2 close
    expect(d.detailLines![0]!.value).toContain(' win ')
    expect(d.settlement.perPlayerCents).toEqual({
      'p-ann': 500,
      'p-bob': 500,
      'p-cy': -500,
      'p-dee': -500,
    })
    expect(d.standings.find((s) => s.id === 'p-ann')!.detail).toBe('✓5&4')
    expect(d.holeSummary(1)).toEqual(['Ann & Bob win the hole', 'Ann & Bob ↑1'])
  })

  /**
   * MP5: a lone player plays the stake against EACH opponent.
   *
   * C beats the pair's better ball on h1–h3 → 3 down from A's side; h4–h9 are
   * halved, and after h7 only two holes remain, so the match is decided 3&2
   * there. C collects $5 from each of the two, they lose $5 apiece — uneven
   * sides, still zero-sum. A flat stake both ways would pay C $5 against two
   * players losing $5 each and leave $5 unaccounted for.
   */
  it('MP5: a lone player collects the stake from each opponent', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [game({ teams: { a: ['p-a', 'p-b'], b: ['p-c'] } })],
    })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [5, 5, 5, ...flat(6, 4)],
      B: [5, 5, 5, ...flat(6, 4)],
      C: flat(9, 4),
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.detailLines![0]!.value).toBe('C wins 3&2')
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': -500, 'p-b': -500, 'p-c': 1000 })
    expect(Object.values(d.settlement.perPlayerCents).reduce((a, b) => a + b, 0)).toBe(0)
    // singular, because the winning side is one player
    expect(d.detailLines![0]!.value).toContain(' wins ')
  })

  /**
   * MP6: a nine is ONE match over that nine — and it knows which nine.
   *
   * The span is `ctx.holesPlayed`, so a back-nine round runs h10–h18 with no
   * special case. A goes 2 up by h11, the rest halve, and h17 leaves one hole
   * against a 2-hole lead → 2&1. The assertions that matter are structural:
   * exactly ONE bet (a Nassau here would show three), labelled B9 rather than
   * F9 or 18.
   */
  it('MP6: a back nine is one match over that nine', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, holes: 'back9', games: [game()] })
    const log = new EventLog()
    log.scoreByHole(round, {
      A: flat(9, 4),
      B: [5, 5, ...flat(7, 4)],
    })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.detailLines).toEqual([{ label: 'B9', value: 'A wins 2&1' }])
    expect(d.settlement.lines).toHaveLength(1)
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    expect(d.holeSummary(17)).toEqual(['Halved', 'Match closes — A wins 2&1'])
  })

  /**
   * MP7: running out of room on a hole nobody played says "2 up", not "2&1".
   *
   * Five holes played, then the group walks in. `round/completed` finalizes
   * h6–h18 at once with nobody posted, so they all halve, and the match runs
   * out of room on h17 — a hole that never happened. "Ann wins 2&1" would be a
   * claim about the 17th of an 18 abandoned after five (MAI-38). The money and
   * the sentence both land on h5, the last hole anybody actually played.
   */
  it('MP7: out of room on an unplayed hole degrades to "2 up"', () => {
    const players = makePlayers([{ name: 'Ann' }, { name: 'Bob' }])
    const round = makeRound({ players, games: [game()] })
    const log = new EventLog()
    log.scoreByHole(round, { Ann: flat(5, 4), Bob: [5, 5, 4, 4, 4] }, [1, 2, 3, 4, 5])
    log.append({ type: 'round/completed' })
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.detailLines![0]!.value).toBe(`Ann wins ${up(2)}`)
    expect(/\d&\d/.test(d.detailLines![0]!.value)).toBe(false)
    expect(d.settlement.perPlayerCents).toEqual({ 'p-ann': 500, 'p-bob': -500 })
    // h17 decided it; h5 is where a prefix replay first sees that, so it is
    // where the dollars appear and where the sentence has to sit
    expect(d.holeSummary(5)).toEqual(['Halved', `Match closes — Ann wins ${up(2)}`])
    expect(d.holeSummary(17)).toEqual([])
  })

  /**
   * MP8: a handicap stroke decides the match — with the gross control beside it.
   *
   * Identical cards: both players make nine 4s on the front nine. Gross, that
   * is nine halves and a push. Net off the low player, B's course handicap of 4
   * halves to 2 for nine of an eighteen (`nineOfEighteen`), and the front-nine
   * stroke indexes put those two strokes on h3 and h6 — SI 1 and SI 3 of the
   * holes played. B nets 3 there, goes 2 up, and after h8 only one hole remains
   * → 2&1. The two halves of this test are the same scorecard, so the strokes
   * are provably the only cause.
   */
  it('MP8: handicap strokes decide it — the same card is a push gross', () => {
    const players = makePlayers([
      { name: 'A', ch: 0 },
      { name: 'B', ch: 4 },
    ])
    const card = { A: flat(9, 4), B: flat(9, 4) }

    const net = makeRound({
      players,
      holes: 'front9',
      games: [{ ...game(), handicap: NET }],
    })
    const netLog = new EventLog()
    netLog.scoreByHole(net, card)
    const dNet = deriveRound(net, netLog.events).derivations.get('game-1')!

    expect(dNet.detailLines).toEqual([{ label: 'F9', value: 'B wins 2&1' }])
    expect(dNet.settlement.perPlayerCents).toEqual({ 'p-a': -500, 'p-b': 500 })
    expect(dNet.holeSummary(3)).toEqual(['B wins the hole', 'B ↑1'])
    expect(dNet.holeSummary(6)).toEqual(['B wins the hole', 'B ↑2'])

    // same scores, no strokes: every hole halves
    const gross = makeRound({ players, holes: 'front9', games: [game()] })
    const grossLog = new EventLog()
    grossLog.scoreByHole(gross, card)
    const dGross = deriveRound(gross, grossLog.events).derivations.get('game-1')!

    expect(dGross.detailLines).toEqual([{ label: 'F9', value: 'push' }])
    expect(dGross.settlement.lines).toEqual([])
    expect(dGross.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
  })

  /**
   * MP9: a hole only one side posts goes to that side, and money locks only on
   * the close.
   *
   * A posts h1 alone and the group moves on, which finalizes it — B cannot win
   * a hole they have no score on. h2 halves. The match is 1 up with seven to
   * play and has moved NOTHING: a lead can still flip, and only a decided match
   * cannot. Completing the round halves the rest and closes it on h9, on a hole
   * nobody played, so the margin is the plain "1 up" and the note lands back on
   * h2.
   */
  it('MP9: an unopposed hole is won, and a mere lead pays nothing', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, holes: 'front9', games: [game()] })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4] }, [1])
    log.scoreByHole(round, { A: [4], B: [4] }, [2])

    const live = deriveRound(round, log.events).derivations.get('game-1')!
    expect(live.summary).toBe('F9: A ↑1 · 7 to play')
    expect(live.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
    expect(live.settlement.lines).toEqual([])
    expect(live.holeSummary(1)).toEqual(['A wins the hole', 'A ↑1'])
    // nobody played it and it isn't final — nothing to say about it yet
    expect(live.holeSummary(3)).toEqual([])

    log.append({ type: 'round/completed' })
    const done = deriveRound(round, log.events).derivations.get('game-1')!
    expect(done.detailLines![0]!.value).toBe(`A wins ${up(1)}`)
    expect(done.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    expect(done.holeSummary(2)).toEqual(['Halved', `Match closes — A wins ${up(1)}`])
  })

  /**
   * MP10: dormie — up exactly as many holes as remain.
   *
   * A is 2 up after h2 and the next five halve, leaving h8 and h9. Two up with
   * two to play cannot be LOST, but it is not won either: the close test is
   * strictly "more than remains". A match that settled here would pay out a bet
   * the other side can still halve.
   */
  it('MP10: two up with two to play is dormie, not won', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, holes: 'front9', games: [game()] })
    const log = new EventLog()
    log.scoreByHole(round, { A: flat(7, 4), B: [5, 5, ...flat(5, 4)] }, [1, 2, 3, 4, 5, 6, 7])
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.summary).toBe('F9: A ↑2 · dormie')
    expect(d.settlement.lines).toEqual([])
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
    expect(d.standings.find((s) => s.id === 'p-a')!.detail).toBe('↑2')
    expect(d.standings.find((s) => s.id === 'p-b')!.detail).toBe('↓2')
  })

  /**
   * MP11: the close note survives landing on the LIVE frontier.
   *
   * A takes h1–h4, h5 halves, then A alone posts h6 and A alone posts h7. h6
   * finalizes because play moved on — B posted nothing, so A takes it and goes
   * 5 up with three left: closed 5&3. But `finalizedAt(6)` is 7, because h7 is
   * where a prefix replay first sees h6 as final, so that is the ledger row the
   * ±$5 appears on. h7 is the half-scored frontier and therefore undecided, and
   * a `holeSummary` that returned [] for an undecided hole would drop the one
   * sentence explaining that money. Transient — it heals when B posts h7 — but
   * the hole it opens is precisely the one `ctx.finalizedAt` exists to close.
   */
  it('MP11: a close landing on the live frontier still explains its money', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }])
    const round = makeRound({ players, holes: 'front9', games: [game()] })
    const log = new EventLog()
    log.scoreByHole(round, { A: flat(5, 4), B: [5, 5, 5, 5, 4] }, [1, 2, 3, 4, 5])
    log.scoreByHole(round, { A: [4] }, [6])
    log.scoreByHole(round, { A: [4] }, [7])
    const d = deriveRound(round, log.events).derivations.get('game-1')!

    expect(d.detailLines![0]!.value).toBe('A wins 5&3')
    expect(d.settlement.perPlayerCents).toEqual({ 'p-a': 500, 'p-b': -500 })
    // h7 is where the money lands, so h7 is where the sentence has to be —
    // even though nothing about h7 itself is decided yet
    expect(d.holeSummary(7)).toEqual(['Match closes — A wins 5&3'])
  })
})

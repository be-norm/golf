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
    const ledger = buildHoleLedger(round, log.events, ctx, derivations)
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
    const midLedger = buildHoleLedger(round, log.events, mid.ctx, mid.derivations)
    const midRows = midLedger.get('game-1')!
    expect(midRows[0]!.summary[0]).toBe('A wins the hole')
    expect(midRows[0]!.summary[1]).toContain('F9 A ↑1')
    expect(midRows.every((r) => r.deltas.length === 0)).toBe(true)

    // finishing the round closes the bet — money lands on the last PLAYED
    // hole's row (never on an unplayed hole finalized by completion)
    log.append({ type: 'round/completed' })
    const done = deriveRound(round, log.events)
    const ledger = buildHoleLedger(round, log.events, done.ctx, done.derivations)
    const rows = ledger.get('game-1')!
    const closing = rows[rows.length - 1]!
    expect(closing.hole).toBe(3)
    expect(closing.summary.some((s) => s.includes('closes'))).toBe(true)
    expect(closing.deltas).toEqual([
      { playerId: 'p-a', cents: 500 },
      { playerId: 'p-b', cents: -500 },
    ])
  })

  it('nassau: a bet decided early pays on its closing hole, with the reason', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } }],
    })
    const log = new EventLog()
    // Ann wins h1–h3, h4–h7 halved → 3 up with 2 of the front left = 3&2 on h7
    log.scoreByHole(
      round,
      { Ann: [4, 4, 4, 4, 4, 4, 4], Bob: [5, 5, 5, 4, 4, 4, 4] },
      [1, 2, 3, 4, 5, 6, 7],
    )
    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!

    // nothing moves while the front can still be caught
    expect(rows.filter((r) => r.hole < 7).every((r) => r.deltas.length === 0)).toBe(true)
    const closing = rows.find((r) => r.hole === 7)!
    expect(closing.deltas).toEqual([
      { playerId: 'p-ann', cents: 500 },
      { playerId: 'p-bob', cents: -500 },
    ])
    // the money and the sentence explaining it share a row
    expect(closing.summary).toContain('F9 closes — Ann wins 3&2')
  })

  it('nassau: a bet decided on a skipped hole narrates where the money lands', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } }],
    })
    const log = new EventLog()
    // Ann wins h1–h4 (+4), h5 halved. NOBODY plays h6 — but h6 still shrinks
    // the bet, and 4 up with h7–h9 left ends it 4&3 on a hole with no scores.
    log.scoreByHole(round, { Ann: [4, 4, 4, 4, 4], Bob: [5, 5, 5, 5, 4] }, [1, 2, 3, 4, 5])
    log.scoreByHole(round, { Ann: [4, 4], Bob: [4, 4] }, [7, 8])
    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!

    // A scoreless hole is only final once play moves past it, so the money
    // surfaces on h7 — the first hole actually played after the close. The
    // note has to follow it there: h6 has neither a score nor a delta, so its
    // row does not exist to carry the explanation.
    const closing = rows.find((r) => r.deltas.length > 0)!
    expect(closing.hole).toBe(7)
    expect(closing.deltas).toEqual([
      { playerId: 'p-ann', cents: 500 },
      { playerId: 'p-bob', cents: -500 },
    ])
    // "4&3" would claim a real hole clinched it with three left to play, and
    // h6 was never played — so the margin degrades to the plainly true "4 up"
    expect(closing.summary).toContain(`F9 closes — Ann wins 4\u00A0up`)
    expect(rows.some((r) => r.hole === 6)).toBe(false)
  })

  it('nassau: a close follows the money past the end of its own segment', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } }],
    })
    const log = new EventLog()
    // Ann wins h1–h4, h5 halved — then the group skips the rest of the front
    // entirely and tees off on 10. The FRONT bet dies on h6 (4 up, 3 left), but
    // no front hole is ever played again, so the hunt for the row carrying the
    // money has to leave the segment.
    log.scoreByHole(round, { Ann: [4, 4, 4, 4, 4], Bob: [5, 5, 5, 5, 4] }, [1, 2, 3, 4, 5])
    log.scoreByHole(round, { Ann: [4], Bob: [4] }, [10])
    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!

    const closing = rows.find((r) => r.deltas.length > 0)!
    expect(closing.hole).toBe(10)
    expect(closing.summary).toContain(`F9 closes — Ann wins 4\u00A0up`)
    // and nothing is stranded on hole 5, which carries no money
    expect(rows.find((r) => r.hole === 5)!.summary.every((s) => !s.includes('closes'))).toBe(true)
  })

  it('nassau: a close decided on a part-scored hole follows the money forward', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } }],
    })
    const log = new EventLog()
    log.scoreByHole(
      round,
      { Ann: [4, 4, 4, 4, 4, 4], Bob: [5, 5, 5, 4, 4, 4] },
      [1, 2, 3, 4, 5, 6],
    )
    // Only Ann posts hole 7 — enough to decide the front (4 up, 2 to play) but
    // NOT enough to finalize the hole, which needs play to move on. So the
    // money waits for hole 8, and the sentence has to wait with it: "anyone
    // scored it" would have stranded the note back on 7.
    log.append({ type: 'score/set', playerId: 'p-ann', hole: 7, gross: 4 })
    log.scoreByHole(round, { Ann: [4], Bob: [4] }, [8])
    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!

    expect(rows.find((r) => r.hole === 7)!.deltas).toEqual([])
    const closing = rows.find((r) => r.hole === 8)!
    expect(closing.deltas).toEqual([
      { playerId: 'p-ann', cents: 500 },
      { playerId: 'p-bob', cents: -500 },
    ])
    expect(closing.summary).toContain('F9 closes — Ann wins 4&2')
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
    const emptyLedger = buildHoleLedger(round, emptyLog.events, emptyCtx, emptyDerivations)
    // wolf announces "Wolf: A" for every pending hole — none of that belongs here
    expect(emptyLedger.get('game-1')).toEqual([])

    const log = new EventLog()
    log.append({ type: 'game/event', gameId: 'game-1', kind: 'wolf/pick', data: { hole: 1, choice: 'p-b' } })
    log.scoreByHole(round, { A: [4], B: [5], C: [5], D: [5] }, [1])
    const { ctx, derivations } = deriveRound(round, log.events)
    const ledger = buildHoleLedger(round, log.events, ctx, derivations)
    const wolf = ledger.get('game-1')!
    expect(wolf).toHaveLength(1)
    expect(wolf[0]!.hole).toBe(1)
    // A rides with B and their 4 beats C/D's 5. Partnered is one unit and the
    // sides are even, so the hole is worth its stake to each player: ±$1.
    expect(wolf[0]!.deltas).toEqual([
      { playerId: 'p-a', cents: 100 },
      { playerId: 'p-b', cents: 100 },
      { playerId: 'p-c', cents: -100 },
      { playerId: 'p-d', cents: -100 },
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
    const vegas = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!
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

  /**
   * A prefix is a POSITION in the walk, not "every hole with a smaller number".
   *
   * The round tees off on 10 and wraps, so holes 1–9 are played LAST. A carry
   * built on 10 and 11 banks on 12 — and the prefix for 12 must contain 10 and
   * 11 and nothing else. Under the old numeric filter (`eventHole(e) <= hole`)
   * the prefix for hole 12 swallowed holes 1–9, which the group had not yet
   * played: the carry would have been resolved by scores from the future, and
   * every row's delta would have been computed against the wrong history.
   *
   * The rows also have to come out in play order — hole 10 first, hole 9 last —
   * because this list IS the money ledger the scorecard screen renders.
   */
  it('builds prefixes by position, so a wrapped round banks on the hole walked', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      holes: 'full18',
      startHole: 10,
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog()
    // h10 tie (carry 1), h11 tie (carry 2), h12 A wins 3 skins — the first
    // three holes WALKED. Nothing on 1–9, which come nine holes later.
    log.scoreByHole(round, { A: [4, 4, 3], B: [4, 4, 4] }, [10, 11, 12])
    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!

    expect(ctx.holesPlayed[0]).toBe(10)
    expect(rows.map((r) => r.hole)).toEqual([10, 11, 12])
    expect(rows[2]!.deltas).toEqual([
      { playerId: 'p-a', cents: 300 },
      { playerId: 'p-b', cents: -300 },
    ])
  })

  /**
   * The award channel meets the positional prefix.
   *
   * An award is the one thing designed to be recorded long after the hole it
   * names (MAI-46) — here a CTP on hole 4, entered at the very end of a round
   * that teed off on 10, i.e. thirteen holes after it happened. `Award.data`
   * carries its hole precisely so `buildHoleLedger` can place it, and with a
   * wrapped round "place it" can only mean by position: hole 4 is the thirteenth
   * hole walked, so its money belongs on row 4 and on no earlier row. Numerically
   * it precedes every hole of the opening nine, which is how it used to land on
   * row 10.
   */
  it('places a late-entered award on the hole it names, not on every row', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      holes: 'full18',
      startHole: 10,
      games: [{ type: 'ctp', config: { stakeCents: 200 } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: Array(18).fill(4), B: Array(18).fill(4) })
    // hole 4 is a par 3 on the harness card, so CTP is live there; this lands
    // after every score, as a late-entered award does
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'ctp/award',
      data: { hole: 4, playerId: 'p-a' },
    })
    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!
    const paid = rows.filter((r) => r.deltas.length > 0)

    expect(paid).toHaveLength(1)
    expect(paid[0]!.hole).toBe(4)
  })

  /**
   * THE COMPLETION HOLE IS A HOLE SOMEBODY PLAYED, and "played" has to mean
   * what the derivation means by it.
   *
   * This was read off raw `score/set` events, which no retraction or clear ever
   * reaches — so undoing the only score on the last hole left the ledger still
   * attributing a completed round's money there, on a hole `ctx.anyScored` (and
   * therefore every engine) says nobody played. Reachable with the header undo.
   *
   * Latent while only narration rode on it (Skins places its dead carry with
   * the same expression), and money the moment Snake shipped: its entire
   * settlement lands on the hole this picks, so the payment appeared on one row
   * while the sentence explaining it sat on another (MAI-58).
   */
  it('places a completed round on the last hole still standing after an undo', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }]),
      holes: 'front9',
      trackPutts: true,
      games: [{ type: 'snake', config: { potCents: 100, doubling: false } }],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 4, 4], B: [4, 4, 4] }, [1, 2, 3])
    log.append({ type: 'score/putts', playerId: 'p-a', hole: 2, putts: 3 })
    // hole 4 is entered and then undone — the group mis-tapped and backed out
    const slip = log.append({ type: 'score/set', playerId: 'p-a', hole: 4, gross: 5 })
    log.append({ type: 'meta/retract', targetEventId: slip.id })
    log.append({ type: 'round/completed' })

    const { ctx, derivations } = deriveRound(round, log.events)
    const rows = buildHoleLedger(round, log.events, ctx, derivations).get('game-1')!
    const paid = rows.filter((r) => r.deltas.length > 0)

    expect(ctx.anyScored(4)).toBe(false)
    expect(paid).toHaveLength(1)
    // hole 3, not the undone hole 4 …
    expect(paid[0]!.hole).toBe(3)
    // … and the sentence explaining it is on that same row
    expect(paid[0]!.summary.join(' ')).toContain('left holding the snake')
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
    const ledger = buildHoleLedger(round, log.events, ctx, derivations)
    expect(ledger.get('game-1')![0]!.deltas).toEqual([
      { playerId: 'p-a', cents: 100 },
      { playerId: 'p-b', cents: -100 },
    ])
  })
})

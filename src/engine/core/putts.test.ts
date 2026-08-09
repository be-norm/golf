import { describe, expect, it } from 'vitest'
import { buildRoundContext } from './context'
import { effectiveEvents } from './replay'
import { EventLog, makePlayers, makeRound } from '../test/harness'

/**
 * Putts are the first fact contributed to `RoundContext` rather than owned by
 * an engine (MAI-54, MAI-90) — the escape hatch invariant #7 reserved, used for
 * what it was reserved for. Nothing reads them yet; Snake is the first consumer.
 *
 * These pin the shared read-model, because every game that ever wants putts
 * inherits whatever it does — and the one thing it must never do is pretend an
 * unrecorded hole was a chip-in.
 */
const ctxFor = (log: EventLog) => {
  const round = makeRound({
    players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
    holes: 'front9',
    games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
  })
  return buildRoundContext(round, effectiveEvents(log.events))
}

describe('putts in RoundContext', () => {
  it('keeps "not recorded" and "no putts" apart', () => {
    const log = new EventLog()
    // A CHIP-IN: genuinely zero putts, and nothing like an unrecorded hole.
    // Folding absence to 0 would hand Snake a three-putt-free hole it never saw.
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 1, putts: 0 })
    const ctx = ctxFor(log)

    expect(ctx.puttsFor('p-ann', 1)).toBe(0)
    expect(ctx.puttsFor('p-ann', 2)).toBeUndefined()
    expect(ctx.puttsFor('p-bob', 1)).toBeUndefined()
    // and the two are distinguishable, which is the whole point
    expect(ctx.puttsFor('p-ann', 1)).not.toBe(ctx.puttsFor('p-ann', 2))
  })

  it('takes the last count per player and hole, like a corrected score', () => {
    const log = new EventLog()
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 3, putts: 3 })
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 3, putts: 2 })
    // a different hole is untouched by the correction
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 4, putts: 1 })

    const ctx = ctxFor(log)
    expect(ctx.puttsFor('p-ann', 3)).toBe(2)
    expect(ctx.puttsFor('p-ann', 4)).toBe(1)
  })

  it('undoes by retraction, back to not-recorded rather than to zero', () => {
    const log = new EventLog()
    const first = log.append({ type: 'score/putts', playerId: 'p-bob', hole: 5, putts: 3 })
    log.append({ type: 'meta/retract', targetEventId: first.id })

    // invariant #2: the event is compensated, never deleted, and what is left
    // is the absence of a fact — not a fact whose value is 0
    expect(ctxFor(log).puttsFor('p-bob', 5)).toBeUndefined()
  })

  it('clears back to not-recorded, which is not the same as zero', () => {
    const log = new EventLog()
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 2, putts: 3 })
    log.append({ type: 'score/puttsClear', playerId: 'p-ann', hole: 2 })

    // NOT 0. Zero is a chip-in, and a junk game pays for one — so the erase
    // gesture has to remove the fact rather than record a different one.
    expect(ctxFor(log).puttsFor('p-ann', 2)).toBeUndefined()
  })

  it('re-records after a clear, and clears only the hole it names', () => {
    const log = new EventLog()
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 2, putts: 3 })
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 3, putts: 1 })
    log.append({ type: 'score/puttsClear', playerId: 'p-ann', hole: 2 })
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 2, putts: 2 })

    const ctx = ctxFor(log)
    expect(ctx.puttsFor('p-ann', 2)).toBe(2)
    expect(ctx.puttsFor('p-ann', 3)).toBe(1)
  })

  it('leaves the scorecard alone — putts are not strokes', () => {
    const log = new EventLog()
    log.append({ type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 })
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 1, putts: 2 })
    // and a hole with ONLY putts was not played
    log.append({ type: 'score/putts', playerId: 'p-ann', hole: 2, putts: 2 })

    const ctx = ctxFor(log)
    expect(ctx.gross.get('p-ann')?.get(1)).toBe(4)
    expect(ctx.anyScored(1)).toBe(true)
    expect(ctx.gross.get('p-ann')?.get(2)).toBeUndefined()
    expect(ctx.anyScored(2)).toBe(false)
  })
})

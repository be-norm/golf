import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import '../games/index'
import { deriveRound, getEngine, listEngines } from '../catalog'
import { EventLog, makePlayers, makeRound } from '../test/harness'
import { arbitraryRoundAndEvents, GAME_FUZZ } from '../test/arbitraries'
import { TEST_ONLY_ENGINE_TYPES } from '../test/harness'
import { assertZeroSum, minimalTransfers } from './money'
import type { RoundEvent } from './events'
import { effectiveEvents } from './replay'

describe('replay invariants (fast-check)', () => {
  it('settlements are always zero-sum', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), ({ round, log }) => {
        const { derivations } = deriveRound(round, log.events)
        for (const d of derivations.values()) assertZeroSum(d.settlement)
      }),
    )
  })

  /**
   * `settlement.lines` is the record of money that MOVED. A zero-cent row in it
   * is a category error: it makes `lines.length === 0` — the settle screen's
   * "No money moved." signal — false for a round where no money moved, and it
   * hands every consumer that counts or sums lines a phantom entry.
   *
   * Skins broke this reaching for somewhere to say "3 skins died unwon"; the
   * fix was a `notes` channel on the derivation, and this is the guard that
   * keeps the next game from reaching for the same shortcut (MAI-40).
   */
  it('every settlement line moves money', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), ({ round, log }) => {
        const { derivations } = deriveRound(round, log.events)
        for (const [gameId, d] of derivations) {
          // WOLF IS A KNOWN EXCEPTION, not a silently weakened rule — see the
          // test below, which fails the moment MAI-75 fixes it and so forces
          // this skip to be deleted rather than outliving the bug it names.
          if (round.games.find((g) => g.gameId === gameId)?.type === 'wolf') continue
          for (const line of d.settlement.lines) {
            const moved = Object.values(line.perPlayerCents).some((c) => c !== 0)
            expect(moved, `settlement line moved nothing: "${line.label}"`).toBe(true)
          }
        }
      }),
    )
  })

  /**
   * A newly registered engine would otherwise be invisible to every property
   * above while CLAUDE.md tells its author a test enforces them. These two
   * catch that, and they catch different halves of it — keep both.
   *
   * This one names the omission outright: register an engine, forget its entry
   * in `GAME_FUZZ` (src/engine/test/arbitraries.ts), and the failure says so.
   */
  it('every registered engine contributes an arbitrary', () => {
    // engines registered by sibling test FILES are excluded by name rather than
    // by trusting vitest to isolate modules — see TEST_ONLY_ENGINE_TYPES
    const registered = listEngines()
      .map((e) => e.type)
      .filter((t) => !TEST_ONLY_ENGINE_TYPES.includes(t))
    expect(new Set(GAME_FUZZ.map((g) => g.type))).toEqual(new Set(registered))
  })

  /**
   * A fuzz entry whose config the engine rejects would leave the game inert —
   * Nassau sides that post no scores, a Wolf rotation naming nobody — and every
   * property above would pass over rounds that exercise nothing. Cheaper to
   * check once here than inside the generator, which runs thousands of times.
   */
  it('every fuzzed config is one its engine would actually accept', () => {
    for (const playerCount of [2, 3, 4]) {
      const { round } = fc
        .sample(arbitraryRoundAndEvents(), { numRuns: 40, seed: 7 })
        .find((s) => s.round.players.length === playerCount)!
      for (const game of round.games) {
        const engine = getEngine(game.type)!
        expect(engine.configSchema.safeParse(game.config).success, `${game.type} config`).toBe(true)
        expect(engine.validateSetup(game, round.players), `${game.type} setup`).toEqual([])
      }
    }
  })

  /**
   * And this one proves the entries actually admit their game into rounds — an
   * `eligible` that never returns true would satisfy the test above while
   * covering nothing.
   */
  it('the fuzz actually deals every registered engine', () => {
    // Across samples, not within one round: Six Point is threesome-only while
    // Wolf and Vegas need a foursome, so no single round can hold all five.
    const seen = new Set(
      fc
        .sample(arbitraryRoundAndEvents(), { numRuns: 200 })
        .flatMap(({ round }) => round.games.map((g) => g.type)),
    )
    expect(seen).toEqual(
      new Set(listEngines().map((e) => e.type).filter((t) => !TEST_ONLY_ENGINE_TYPES.includes(t))),
    )
  })

  /**
   * A KNOWN VIOLATION, asserted so it self-retires. Wolf itemises per-player
   * points ("A — 3 pts") rather than per-transaction money, so a player whose
   * points land on the average nets zero and still earns a settlement row.
   *
   * This test exists to fail when MAI-75 fixes that — at which point the Wolf
   * skip in "every settlement line moves money" must be deleted, and this test
   * with it. A bare `continue` up there would have quietly outlived the bug.
   */
  it('Wolf still emits zero-money settlement lines (MAI-75 — delete this when fixed)', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    // nothing scored: every player sits on 0 points, so every row moves $0
    const { derivations } = deriveRound(round, new EventLog().events)
    const lines = derivations.get('game-1')!.settlement.lines
    expect(lines.length).toBeGreaterThan(0)
    expect(
      lines.every((l) => Object.values(l.perPlayerCents).every((c) => c === 0)),
    ).toBe(true)
  })

  it('replay is deterministic: same events, same result', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), ({ round, log }) => {
        const a = deriveRound(round, log.events)
        const b = deriveRound(round, [...log.events])
        expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
          [...b.derivations.values()].map((d) => d.settlement),
        )
      }),
    )
  })

  it('retract(e) is equivalent to a log that never contained e', () => {
    fc.assert(
      fc.property(
        arbitraryRoundAndEvents().filter(({ log }) => log.events.length > 0),
        fc.nat(),
        ({ round, log }, pick) => {
          const target = log.events[pick % log.events.length]!
          const withRetract: RoundEvent[] = [
            ...log.events,
            {
              type: 'meta/retract',
              targetEventId: target.id,
              id: 'evt-retract',
              roundId: round.id,
              seq: log.events.length + 1,
              at: '2026-07-18T12:00:00.000Z',
              deviceId: 'device-test',
            },
          ]
          const without = log.events.filter((e) => e.id !== target.id)
          const a = deriveRound(round, withRetract)
          const b = deriveRound(round, without)
          expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
            [...b.derivations.values()].map((d) => d.settlement),
          )
        },
      ),
    )
  })

  it('correction equivalence: a corrected score equals having entered it right initially', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), fc.integer({ min: 1, max: 12 }), ({ round, log }, corrected) => {
        const scoreEvents = log.events.filter((e) => e.type === 'score/set')
        if (scoreEvents.length === 0) return
        const target = scoreEvents[0]!
        const correctionLog = new EventLog()
        for (const e of log.events) {
          if (e.type !== 'score/set') continue
          correctionLog.append({ type: 'score/set', playerId: e.playerId, hole: e.hole, gross: e.gross })
        }
        correctionLog.append({
          type: 'score/set',
          playerId: target.playerId,
          hole: target.hole,
          gross: corrected,
        })

        const directLog = new EventLog()
        for (const e of log.events) {
          if (e.type !== 'score/set') continue
          directLog.append(
            e.id === target.id
              ? { type: 'score/set', playerId: e.playerId, hole: e.hole, gross: corrected }
              : { type: 'score/set', playerId: e.playerId, hole: e.hole, gross: e.gross },
          )
        }

        const a = deriveRound(round, correctionLog.events)
        const b = deriveRound(round, directLog.events)
        expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
          [...b.derivations.values()].map((d) => d.settlement),
        )
      }),
    )
  })
})

describe('effectiveEvents', () => {
  it('drops retracted events and retracts themselves', () => {
    const log = new EventLog()
    const e1 = log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    log.append({ type: 'score/set', playerId: 'p-b', hole: 1, gross: 5 })
    log.append({ type: 'meta/retract', targetEventId: e1.id })
    const effective = effectiveEvents(log.events)
    expect(effective).toHaveLength(1)
    expect(effective[0]).toMatchObject({ playerId: 'p-b' })
  })
})

describe('minimalTransfers', () => {
  it('settles a zero-sum balance with minimal greedy transfers', () => {
    const transfers = minimalTransfers({ a: 800, b: -400, c: 400, d: -800 })
    const net: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 }
    for (const t of transfers) {
      net[t.fromPlayerId]! -= t.cents
      net[t.toPlayerId]! += t.cents
    }
    expect(net).toEqual({ a: 800, b: -400, c: 400, d: -800 })
    expect(transfers.length).toBeLessThanOrEqual(3)
  })
})

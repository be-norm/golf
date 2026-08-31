import { describe, expect, it } from 'vitest'
import './games'
import { amendRound, deriveRound } from './catalog'
import { buildHoleLedger } from './ledger'
import { effectiveEvents } from './core/replay'
import { assertZeroSum } from './core/money'
import { EventLog, makePlayers, makeRound } from './test/harness'
import type { EventDraft } from './core/events'
import type { HandicapSettings, Round } from './core/types'
import type { SnakeDerivation } from './games/snake/engine'

/**
 * SETTINGS AMENDMENTS (MAI-100/101).
 *
 * The case these exist for: a group played Snake at the wrong pot with doubling
 * off and noticed on the ninth green. Before amendments the only remedy was to
 * abandon the round, because settings live on the round DOCUMENT and
 * `deriveRound` reads them wholesale — so changing one rewrote every settled
 * hole's money silently, which invariant #2 exists to prevent.
 *
 * An amendment is an event instead, folded by `amendRound` ahead of everything
 * else, and it re-prices the WHOLE round: "the pot was always $2". These
 * fixtures pin that reading, plus the three fold properties nothing else would
 * fail loudly on — reject-inert, idempotent, identity-stable.
 */

const FOUR = () => makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
const GROSS: HandicapSettings = { mode: 'gross', allowancePct: 100, reference: 'absolute' }

function snakeRound(potCents = 100, doubling = false) {
  return makeRound({
    players: FOUR(),
    holes: 'front9',
    games: [{ type: 'snake', config: { potCents, doubling } }],
  })
}

/** Score every hole flat, so `anyScored` lets the bites count. */
function scoreHoles(round: Round, log: EventLog, holes: number[]) {
  log.scoreByHole(
    round,
    Object.fromEntries(round.players.map((p) => [p.name, holes.map(() => 4)])),
    holes,
  )
}

const bite = (log: EventLog, hole: number, playerId: string) =>
  log.append({ type: 'game/event', gameId: 'game-1', kind: 'snake/bite', data: { hole, playerId } })

/** The editor's write: this game's settings, whole, from now back to hole 1. */
const configure = (log: EventLog, config: unknown, handicap: HandicapSettings = GROSS) =>
  log.append({ type: 'game/configured', gameId: 'game-1', config, handicap })

const snakeOf = (round: Round, log: EventLog): SnakeDerivation =>
  deriveRound(round, log.events).derivations.get('game-1') as SnakeDerivation

/**
 * The reported round, played twice: once on a card set up wrong and corrected on
 * the 8th, once on a card that was right from the first tee.
 *
 * A holds the snake at the end either way — what changes is only what it costs.
 */
function playedRound(round: Round, amend?: EventDraft) {
  const log = new EventLog()
  scoreHoles(round, log, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  bite(log, 2, 'p-a')
  bite(log, 4, 'p-b')
  bite(log, 6, 'p-a')
  if (amend) log.append(amend)
  log.append({ type: 'round/completed' })
  return log
}

describe('amendRound — a settings change re-prices the whole round', () => {
  /**
   * A1: AMENDMENT EQUIVALENCE, the headline — and written with the game's own
   * recorded events present, because that is where the teeth are. With a bare
   * config and no events it would be near-tautological: the fold produces that
   * config, so of course it settles like it. What has to hold is that three
   * bites recorded under the OLD settings still line up against the new ones and
   * double in the order they were actually passed.
   */
  it('A1: settles exactly as a round configured that way from the first tee', () => {
    const corrected = snakeRound(100, false)
    const fromTheStart = snakeRound(200, true)

    const amended = snakeOf(
      corrected,
      playedRound(corrected, {
        type: 'game/configured',
        gameId: 'game-1',
        config: { potCents: 200, doubling: true },
        handicap: GROSS,
      }),
    )
    const intended = snakeOf(fromTheStart, playedRound(fromTheStart))

    expect(amended.settlement.perPlayerCents).toEqual(intended.settlement.perPlayerCents)
    expect(amended.bites).toEqual(intended.bites)
    // and it is the doubled chain, not the original: $2, $4, $8 over three bites
    expect(amended.bites.map((b) => b.potCents)).toEqual([200, 400, 800])
    // A holds it at $8, paying that to each of the other three
    expect(amended.settlement.perPlayerCents['p-a']).toBe(-2400)
    assertZeroSum(amended.settlement)
  })

  /**
   * A2: the ledger has to agree with the settle screen. Amendments are
   * round-scoped, so `eventHole` answers null and they land in EVERY prefix —
   * which is what makes hole 2's row show the amended price even though the
   * amendment was appended six holes later.
   */
  it('A2: re-prices holes already in the ledger, not just the total', () => {
    const round = snakeRound(100, false)
    const log = playedRound(round, {
      type: 'game/configured',
      gameId: 'game-1',
      config: { potCents: 200, doubling: true },
      handicap: GROSS,
    })
    const view = deriveRound(round, log.events)
    const rows = buildHoleLedger(view.round, log.events, view.ctx, view.derivations).get('game-1')!

    // hole 2 is where the snake came out; its row now quotes the AMENDED pot,
    // six holes before the amendment was appended
    expect(rows.find((r) => r.hole === 2)!.summary.join(' ')).toContain('the pot is now $2')
    // and the money still lands on the last hole played, at the doubled pot
    expect(rows.find((r) => r.hole === 9)!.deltas).toContainEqual({
      playerId: 'p-a',
      cents: -2400,
    })
  })

  /**
   * A3: undo. Nothing special is written for this — a retract drops the
   * amendment out of `effectiveEvents`, so the fold never sees it.
   */
  it('A3: retracting an amendment is a log that never held one', () => {
    const round = snakeRound(100, false)
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    bite(log, 2, 'p-a')
    const amendment = configure(log, { potCents: 500, doubling: true })
    log.append({ type: 'meta/retract', targetEventId: amendment.id })
    log.append({ type: 'round/completed' })

    const untouched = new EventLog()
    scoreHoles(round, untouched, [1, 2, 3])
    bite(untouched, 2, 'p-a')
    untouched.append({ type: 'round/completed' })

    expect(snakeOf(round, log).settlement.perPlayerCents).toEqual(
      snakeOf(round, untouched).settlement.perPlayerCents,
    )
    expect(snakeOf(round, log).potCents).toBe(100)
  })

  /**
   * A4: THE WORST FAILURE AVAILABLE HERE, refused. A config the engine rejects
   * is skipped and the game carries on at its previous settings — because
   * letting it through would reach `deriveRound`'s `configSchema` guard and make
   * the game INERT: a mistyped stake silently deleting a live bet, with the bar
   * simply going quiet.
   */
  it('A4: an amendment the engine rejects is inert — the game keeps its settings', () => {
    const round = snakeRound(100, false)
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    bite(log, 2, 'p-a')
    // `doubling` missing: a partial payload, which snakeConfigSchema refuses
    configure(log, { potCents: 500 })
    log.append({ type: 'round/completed' })

    const snake = snakeOf(round, log)
    // still deriving, still at the ORIGINAL pot — not silently zeroed
    expect(snake.potCents).toBe(100)
    expect(snake.settlement.perPlayerCents['p-a']).toBe(-300)
    assertZeroSum(snake.settlement)
  })

  /**
   * A5: an amendment naming a game the round doesn't hold conjures nothing.
   * Adding a game is `game/added`'s job and carries a type; this one couldn't
   * know what engine to run.
   */
  it('A5: ignores an amendment for a game the round does not hold', () => {
    const round = snakeRound(100, false)
    const log = new EventLog()
    log.append({
      type: 'game/configured',
      gameId: 'game-nope',
      config: { potCents: 900, doubling: true },
      handicap: GROSS,
    })
    expect(amendRound(round, effectiveEvents(log.events)).games).toHaveLength(1)
    expect(amendRound(round, effectiveEvents(log.events)).games[0]!.config).toEqual({
      potCents: 100,
      doubling: false,
    })
  })
})

describe('amendRound — the fold properties', () => {
  /**
   * P1: IDEMPOTENCE, and it is load-bearing rather than tidy. `buildHoleLedger`
   * hands this function's own output back to `deriveRound` once per hole, each
   * time with a prefix that still contains the amendments — so folding an
   * already-amended round again must change nothing. A2 above is the same
   * property observed from the outside; this one states it directly.
   */
  it('P1: folding an already-amended round changes nothing', () => {
    const round = snakeRound(100, false)
    const log = playedRound(round, {
      type: 'game/configured',
      gameId: 'game-1',
      config: { potCents: 200, doubling: true },
      handicap: GROSS,
    })
    const effective = effectiveEvents(log.events)
    const once = amendRound(round, effective)
    expect(amendRound(once, effective)).toEqual(once)
  })

  /**
   * P2: IDENTITY. Every round in the app today has no amendments, and they must
   * cost nothing — `useRound`'s memo and every downstream identity comparison
   * behave exactly as they did before this existed.
   */
  it('P2: a round with nothing to amend comes back as the same object', () => {
    const round = snakeRound(100, false)
    const log = new EventLog()
    scoreHoles(round, log, [1, 2, 3])
    bite(log, 2, 'p-a')
    expect(amendRound(round, effectiveEvents(log.events))).toBe(round)
  })

  /**
   * P3: `role` is replaced wholesale like everything else, so an amendment
   * without one CLEARS a stamp rather than leaving the old one in place. The
   * editor re-runs `reconcileRoles` and sends what it decides, so "no role" is
   * an answer, not an omission.
   */
  it('P3: an amendment without a role clears one the round was carrying', () => {
    const round = makeRound({
      players: FOUR(),
      holes: 'front9',
      games: [
        { type: 'snake', config: { potCents: 100, doubling: false }, role: 'main' },
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
      ],
    })
    const log = new EventLog()
    configure(log, { potCents: 200, doubling: false })
    const amended = amendRound(round, effectiveEvents(log.events))
    expect('role' in amended.games[0]!).toBe(false)
  })
})

describe('amendRound — locked fields', () => {
  const wolfRound = () =>
    makeRound({
      players: FOUR(),
      holes: 'front9',
      games: [
        {
          type: 'wolf',
          config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] },
        },
      ],
    })
  const reordered = { pointCents: 100, rotation: ['p-d', 'p-c', 'p-b', 'p-a'] }

  /**
   * L1: locked means "not once anything is scored", NOT "never". On the first
   * tee — which is when a mis-entered wolf order is actually spotted — it is
   * fully editable.
   */
  it('L1: a locked field is editable before the first score', () => {
    const round = wolfRound()
    const log = new EventLog()
    configure(log, reordered)
    expect(amendRound(round, effectiveEvents(log.events)).games[0]!.config).toEqual(reordered)
  })

  /**
   * L2: and refused after it. Every recorded pick is attributed THROUGH the
   * rotation — inside it the config alone decides who the wolf was — so
   * re-ordering once picks exist would hand hole 1's declaration to a different
   * player: a partnership nobody formed, priced as if they had.
   */
  it('L2: a locked field is refused once a score is in', () => {
    const round = wolfRound()
    const log = new EventLog()
    log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    configure(log, reordered)
    expect(amendRound(round, effectiveEvents(log.events)).games[0]!.config).toEqual({
      pointCents: 100,
      rotation: ['p-a', 'p-b', 'p-c', 'p-d'],
    })
  })

  /**
   * L3: the whole amendment is dropped, not just the locked key. Merging would
   * need per-key rules and would leave the group looking at a card that accepted
   * half of what they typed.
   */
  it('L3: refusal takes the whole amendment, editable keys included', () => {
    const round = wolfRound()
    const log = new EventLog()
    log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    configure(log, { ...reordered, pointCents: 500 })
    expect(amendRound(round, effectiveEvents(log.events)).games[0]!.config).toHaveProperty(
      'pointCents',
      100,
    )
  })

  /**
   * L4: an editable field on a game that ALSO has a locked one still moves.
   * Wolf's stake is the ordinary amendment, and the lock must not swallow it.
   */
  it('L4: an editable field on the same game is unaffected by the lock', () => {
    const round = wolfRound()
    const log = new EventLog()
    log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    configure(log, { pointCents: 500, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] })
    expect(amendRound(round, effectiveEvents(log.events)).games[0]!.config).toEqual({
      pointCents: 500,
      rotation: ['p-a', 'p-b', 'p-c', 'p-d'],
    })
  })
})

describe('amendRound — an unregistered game type', () => {
  /**
   * U1: a round imported from a build that ships a game this one doesn't. The
   * game is inert in `deriveRound` either way, so dropping its amendment would
   * lose a change made where the game DOES run — the same call `importSchema`
   * makes about letting unknown types through.
   */
  it('U1: accepts amendments for a game this build cannot derive', () => {
    const round = makeRound({
      players: FOUR(),
      holes: 'front9',
      games: [{ type: 'from-the-future', config: { anything: 1 } }],
    })
    const log = new EventLog()
    configure(log, { anything: 2 })
    expect(amendRound(round, effectiveEvents(log.events)).games[0]!.config).toEqual({ anything: 2 })
  })

  /**
   * U2: …and it has no locked fields to check, since we cannot know what they
   * would be. Scored or not, the amendment applies.
   */
  it('U2: has no locked fields, so a score does not block it', () => {
    const round = makeRound({
      players: FOUR(),
      holes: 'front9',
      games: [{ type: 'from-the-future', config: { anything: 1 } }],
    })
    const log = new EventLog()
    log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    configure(log, { anything: 2 })
    expect(amendRound(round, effectiveEvents(log.events)).games[0]!.config).toEqual({ anything: 2 })
  })
})

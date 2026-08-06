import { describe, expect, it } from 'vitest'
import './games/index'
import {
  deriveRound,
  listEngines,
  type GameCategory,
  type GameFamily,
  type GameShape,
} from './catalog'
import { EventLog, makePlayers, makeRound } from './test/harness'

// `satisfies` ties each mirror to its union: a typo here is a compile error,
// and so is adding a union member without listing it.
const FAMILIES = ['match', 'stroke', 'points', 'pot', 'award', 'wager'] as const satisfies readonly GameFamily[]
const CATEGORIES = ['main', 'side', 'either'] as const satisfies readonly GameCategory[]
const SHAPES = ['solo', 'headToHead', 'teams', 'partners'] as const satisfies readonly GameShape[]

describe('engine registry invariants', () => {
  it('every game ships complete player-facing rules', () => {
    const engines = listEngines()
    expect(engines.length).toBeGreaterThanOrEqual(4)
    for (const engine of engines) {
      const { rules } = engine.meta
      expect(rules.tagline.length, `${engine.type} tagline`).toBeGreaterThan(0)
      expect(rules.howToPlay.length, `${engine.type} howToPlay`).toBeGreaterThan(0)
      expect(rules.scoring.length, `${engine.type} scoring`).toBeGreaterThan(0)
      expect(rules.terms.length, `${engine.type} terms`).toBeGreaterThan(0)
      for (const t of rules.terms) {
        expect(t.term.length, `${engine.type} term name`).toBeGreaterThan(0)
        expect(t.def.length, `${engine.type} "${t.term}" definition`).toBeGreaterThan(0)
      }
    }
  })

  /**
   * The taxonomy is what setup grouping, the picker sheet and display density
   * read. A game that omits it doesn't fail loudly — it quietly lands in
   * whatever bucket the renderer falls back to, which is how a side bet ends up
   * presented as somebody's main event (MAI-43).
   */
  it('every game declares where it belongs', () => {
    for (const engine of listEngines()) {
      expect(CATEGORIES, `${engine.type} category`).toContain(engine.meta.category)
      expect(FAMILIES, `${engine.type} family`).toContain(engine.meta.family)
      expect(engine.meta.shapes.length, `${engine.type} shapes`).toBeGreaterThan(0)
      for (const shape of engine.meta.shapes) {
        expect(SHAPES, `${engine.type} shape`).toContain(shape)
      }
    }
  })

  /**
   * A game that can be played solo AND in teams says so, but a game claiming
   * `teams` or `partners` must be able to seat them: two players cannot form
   * two sides, and a rotating-partner game needs at least three.
   */
  it('declares no shape its player limits cannot seat', () => {
    for (const engine of listEngines()) {
      const { shapes, minPlayers, maxPlayers } = engine.meta
      if (shapes.includes('teams') || shapes.includes('partners')) {
        expect(maxPlayers, `${engine.type} needs room for sides`).toBeGreaterThanOrEqual(3)
      }
      if (shapes.includes('partners')) {
        // two players cannot re-form into partnerships each hole
        expect(minPlayers, `${engine.type} rotating partners needs 3+`).toBeGreaterThanOrEqual(3)
      }
      if (shapes.includes('headToHead')) {
        expect(minPlayers, `${engine.type} head-to-head needs 2`).toBeLessThanOrEqual(2)
      }
    }
  })
})

/**
 * THE ONE-WAY RULE, as a test rather than a paragraph.
 *
 * `role` is presentation: it says whether this round treats the game as its
 * main event or a side bet. Money must not notice. If it ever did, the same
 * scorecard would settle differently depending on how the group had grouped
 * their games on the setup screen — and the bug would be invisible, because
 * both answers are internally consistent and zero-sum.
 */
describe('taxonomy never reaches the money', () => {
  /** Nine holes of real, varied scores — enough for every engine to move money. */
  const CARD: Record<string, number[]> = {
    A: [4, 5, 3, 4, 6, 4, 3, 5, 4],
    B: [5, 4, 4, 4, 5, 5, 3, 4, 5],
    C: [4, 6, 4, 3, 5, 4, 4, 6, 4],
    D: [6, 4, 5, 4, 4, 3, 5, 5, 3],
  }

  /**
   * EVERY registered engine, at its own minimum roster and with its own default
   * config — not a hand-picked pair. `deriveRound` hands the whole `GameConfig`
   * (now carrying `role`) to `engine.derive`, so any engine could branch on it;
   * a fixture naming two games would let the other three, and every game still
   * to be written, do exactly what invariant #7 forbids and ship green.
   */
  for (const engine of listEngines()) {
    const names = ['A', 'B', 'C', 'D'].slice(0, engine.meta.minPlayers)
    const players = makePlayers(names.map((name) => ({ name })))

    const scored = (role?: 'main' | 'side') => {
      const round = makeRound({
        players,
        holes: 'front9',
        games: [{ type: engine.type, config: engine.defaultConfig(players) }],
      })
      // stamped after construction, so the rounds are otherwise byte-identical
      const games = round.games.map((g) => ({ ...g, ...(role ? { role } : {}) }))
      const log = new EventLog()
      log.scoreByHole(
        round,
        Object.fromEntries(names.map((n) => [n, CARD[n]!])),
      )
      // games that need an in-round choice get one, or they never settle
      for (const input of deriveRound({ ...round, games }, log.events)
        .derivations.get('game-1')!
        .requiredInputs()) {
        log.append({
          type: 'game/event',
          gameId: 'game-1',
          kind: input.eventKind,
          data: { hole: input.hole, choice: input.options[0]!.value },
        })
      }
      return deriveRound({ ...round, games }, log.events).derivations.get('game-1')!
    }

    it(`settles ${engine.type} identically whether it is main, side, or unlabelled`, () => {
      const asMain = scored('main')
      expect(scored('side').settlement).toEqual(asMain.settlement)
      // absent is what every round created before MAI-43 looks like
      expect(scored().settlement).toEqual(asMain.settlement)
      // …and money actually moved, or the assertions above are vacuous
      expect(
        Object.values(asMain.settlement.perPlayerCents).some((c) => c !== 0),
        `${engine.type} moved no money — the guard proves nothing`,
      ).toBe(true)
    })
  }
})

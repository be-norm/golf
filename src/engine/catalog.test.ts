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

// `satisfies` alone only checks each element is a MEMBER — it does not check
// the list is complete, which an earlier comment here claimed and tsc quietly
// disproves. `Covers` is the missing half: it fails to compile when a union
// gains a value the mirror lacks, which would otherwise go unnoticed until some
// engine used it and the failure blamed the engine instead of this list.
type Covers<Union, Listed extends readonly Union[]> = [Exclude<Union, Listed[number]>] extends [
  never,
]
  ? Listed
  : ['missing from the list:', Exclude<Union, Listed[number]>]

const FAMILIES = ['match', 'stroke', 'points', 'pot', 'award', 'wager'] as const satisfies readonly GameFamily[]
const CATEGORIES = ['main', 'side', 'either'] as const satisfies readonly GameCategory[]
const SHAPES = ['solo', 'headToHead', 'teams', 'partners'] as const satisfies readonly GameShape[]

type _FamiliesCovered = Covers<GameFamily, typeof FAMILIES>
type _CategoriesCovered = Covers<GameCategory, typeof CATEGORIES>
type _ShapesCovered = Covers<GameShape, typeof SHAPES>
const _exhaustive: [_FamiliesCovered, _CategoriesCovered, _ShapesCovered] = [
  FAMILIES,
  CATEGORIES,
  SHAPES,
]
void _exhaustive

describe('engine registry invariants', () => {
  /**
   * Every guard below iterates the registry, and registration happens only as a
   * side effect of the bare `import './games/index'` at the top of this file.
   * Drop or reorder that import and each loop runs zero times while the suite
   * reports success — including the generated `it`s further down, which would
   * not even be registered. CLAUDE.md says this file proves invariant #7; the
   * proof has to fail loudly rather than evaporate.
   */
  it('has engines to check at all', () => {
    expect(listEngines().length).toBeGreaterThanOrEqual(5)
  })

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
      const needsThree = (s: GameShape) => s === 'teams' || s === 'partners'
      // Two claims, and the difference matters. Nassau declares both
      // `headToHead` and `teams` at minPlayers 2 — correctly, because 2 is
      // seatable by head-to-head even though teams need 3. So:
      // (1) every declared shape must be seatable SOMEWHERE in the range, and
      if (shapes.some(needsThree)) {
        expect(maxPlayers, `${engine.type} declares sides it can never seat`).toBeGreaterThanOrEqual(3)
      }
      // (2) the game's OWN MINIMUM must be seatable by some declared shape,
      //     or it accepts a roster that can play none of the ways it offers.
      if (minPlayers < 3) {
        expect(
          shapes.some((s) => !needsThree(s)),
          `${engine.type} accepts ${minPlayers} players but every shape it declares needs 3+`,
        ).toBe(true)
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
    // `slice` clamps rather than erroring, so an engine wanting 5+ would get a
    // short roster and fail later with a message blaming the invariant instead
    // of this fixture.
    if (names.length < engine.meta.minPlayers) {
      throw new Error(`${engine.type} needs ${engine.meta.minPlayers} players; add scorecards`)
    }
    // NON-ZERO, VARIED handicaps: the harness defaults everyone to 0 and every
    // game to gross, which would run each engine through only half its derive.
    // An engine reading `role` inside its net/stroke-allocation branch would
    // ship green against a fixture where no stroke is ever allocated.
    const players = makePlayers(names.map((name, i) => ({ name, ch: i * 4 })))

    const scored = (role?: 'main' | 'side') => {
      const round = makeRound({
        players,
        holes: 'front9',
        games: [
          {
            type: engine.type,
            config: engine.defaultConfig(players),
            // the engine's OWN handicap policy — net for four of the five
            handicap: engine.defaultHandicap(),
          },
        ],
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

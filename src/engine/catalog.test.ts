import { describe, expect, it } from 'vitest'
import './games/index'
import {
  deriveRound,
  listEngines,
  roleOf,
  type GameCategory,
  type GameFamily,
  type GameShape,
  type RoundFact,
} from './catalog'
import { EventLog, makePlayers, makeRound, TEST_ONLY_ENGINE_TYPES } from './test/harness'
import type { GameConfig } from './core/types'
import { isPaintable } from './label'

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
const FACTS = ['putts'] as const satisfies readonly RoundFact[]

type _FamiliesCovered = Covers<GameFamily, typeof FAMILIES>
type _CategoriesCovered = Covers<GameCategory, typeof CATEGORIES>
type _ShapesCovered = Covers<GameShape, typeof SHAPES>
type _FactsCovered = Covers<RoundFact, typeof FACTS>
const _exhaustive: [
  _FamiliesCovered,
  _CategoriesCovered,
  _ShapesCovered,
  _FactsCovered,
] = [FAMILIES, CATEGORIES, SHAPES, FACTS]
void _exhaustive

/** the registry minus anything a sibling test file registered for its own use */
const shippedEngines = () => listEngines().filter((e) => !TEST_ONLY_ENGINE_TYPES.includes(e.type))

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
    expect(shippedEngines().length).toBeGreaterThanOrEqual(5)
  })

  /**
   * `meta.name` IS the label whenever a round holds one of a game — and it is
   * painted onto the share card in Press Start 2P. `gameLabel` enforces this
   * for the parenthetical it builds, but the name itself comes straight from
   * the engine, and neighbouring engine strings in this repo already carry "·",
   * "—" and emoji (wolf's prompt is "🐺 Hole N: …"). A game named "Wolf 🐺"
   * would render that glyph in the system face mid-title, and jsdom has no
   * canvas to catch it.
   */
  it('every game name can be painted in the pixel font', () => {
    for (const engine of shippedEngines()) {
      expect(isPaintable(engine.meta.name), `${engine.type} name`).toBe(true)
    }
  })

  /**
   * `gameLabel` disambiguates games sharing a TYPE. Two engines sharing a NAME
   * would defeat it entirely — each sees one sibling, so both render the bare
   * name and every surface shows two identical rows, which is the failure MAI-42
   * exists to remove. The catalog has 26 more games to come and several have
   * overlapping common names (Best Ball / Four-Ball, Match Play / Matches).
   */
  it('no two games share a name', () => {
    const names = shippedEngines().map((e) => e.meta.name)
    expect(new Set(names).size, `duplicate game name in ${names.join(', ')}`).toBe(names.length)
  })

  it('every game ships complete player-facing rules', () => {
    for (const engine of shippedEngines()) {
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
  /**
   * A round collects a shared fact because a game READS it (MAI-90), and setup
   * is what turns collection on. A typo'd fact would therefore fail silently in
   * the worst way available: the game derives nothing, setup asks for nothing,
   * and everything looks healthy.
   */
  it('reads only facts the round knows how to collect', () => {
    for (const engine of shippedEngines()) {
      for (const fact of engine.meta.reads ?? []) {
        expect(FACTS, `${engine.type} reads`).toContain(fact)
      }
    }
  })

  /**
   * `meta.grossOnly` is a claim about the GAME — strokes cannot decide it — and
   * setup acts on it by hiding the handicap control entirely. An engine
   * declaring it while defaulting to net would ship a round whose stored policy
   * nobody can see or change, which is worse than either honest answer.
   *
   * Nothing enforces the other direction: a gross DEFAULT is not a claim (Skins
   * ships gross and is routinely flipped to net — that is the whole reason
   * `gameLabel` has a discriminator ladder).
   */
  it('never declares strokes irrelevant while defaulting to net', () => {
    for (const engine of shippedEngines()) {
      if (!engine.meta.grossOnly) continue
      expect(engine.defaultHandicap().mode, `${engine.type} grossOnly`).toBe('gross')
    }
  })

  it('every game declares where it belongs', () => {
    for (const engine of shippedEngines()) {
      expect(CATEGORIES, `${engine.type} category`).toContain(engine.meta.category)
      expect(FAMILIES, `${engine.type} family`).toContain(engine.meta.family)
      expect(engine.meta.shapes.length, `${engine.type} shapes`).toBeGreaterThan(0)
      for (const shape of engine.meta.shapes) {
        expect(SHAPES, `${engine.type} shape`).toContain(shape)
      }
    }
  })

  /**
   * `GameAction` is a generic channel, but the affordance around it has no
   * vocabulary of its own (MAI-47) — so a game that offers actions and declares
   * no copy would render whatever the previous game called its move, or the
   * neutral fallback, with nothing saying why.
   *
   * The type cannot enforce this: whether a game offers actions is decided
   * inside `derive`, not on `meta`. So it is checked here, against a real
   * derivation rather than a promise.
   */
  it('every game offering actions declares how to talk about them', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    for (const engine of shippedEngines()) {
      const seated = players.slice(0, Math.max(engine.meta.minPlayers, 2))
      const round = makeRound({
        players: seated,
        holes: 'front9',
        games: [{ type: engine.type, config: engine.defaultConfig(seated) }],
      })
      const d = deriveRound(round, new EventLog().events).derivations.get('game-1')!
      if (!d.availableActions) continue
      const copy = engine.meta.actions
      expect(copy, `${engine.type} offers actions with no meta.actions`).toBeDefined()
      for (const [key, value] of Object.entries(copy!)) {
        expect(value.length, `${engine.type} meta.actions.${key}`).toBeGreaterThan(0)
      }
    }
  })

  /**
   * A game that can be played solo AND in teams says so, but a game claiming
   * `teams` or `partners` must be able to seat them: two players cannot form
   * two sides, and a rotating-partner game needs at least three.
   */
  it('declares no shape its player limits cannot seat', () => {
    for (const engine of shippedEngines()) {
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
        // a RANGE, both ends: 2 has to be inside it. `minPlayers <= 2` alone is
        // satisfied by a game accepting 1, which cannot play one-against-one
        // either — the message said "needs 2" while checking only one bound.
        expect(minPlayers, `${engine.type} head-to-head needs to accept 2`).toBeLessThanOrEqual(2)
        expect(maxPlayers, `${engine.type} head-to-head needs to accept 2`).toBeGreaterThanOrEqual(2)
      }
    }
  })
})

describe('roleOf', () => {
  const game = (gameId: string, type: string): GameConfig => ({
    gameId,
    type,
    handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
    config: {},
  })

  it('reads an "either" game off the ROUND, not off the engine', () => {
    const skins = game('g1', 'skins')
    const nassau = game('g2', 'nassau')
    // alone, skins IS the round — the thing invariant #7 says only the round knows
    expect(roleOf(skins, [skins])).toBe('main')
    // beside a game that can only be the main event, it is the side bet
    expect(roleOf(skins, [skins, nassau])).toBe('side')
    expect(roleOf(nassau, [skins, nassau])).toBe('main')
  })

  /**
   * A sibling's EXPLICIT role has to count when deriving another game's. Reading
   * only `meta.category` meant a user demoting their Nassau to a side bet left
   * the round with two side bets and no main event — and MAI-44 is precisely
   * the feature that starts writing explicit roles.
   */
  it('respects a sibling\'s explicit role, not just its category', () => {
    const skins = game('g1', 'skins')
    const nassau = { ...game('g2', 'nassau'), role: 'side' as const }
    // nobody claims the main event any more, so the "either" game takes it
    expect(roleOf(skins, [skins, nassau])).toBe('main')

    // and the mirror: one of two "either" games promoted makes the other the side bet
    const a = { ...game('g1', 'skins'), role: 'main' as const }
    const b = game('g2', 'skins')
    expect(roleOf(b, [a, b])).toBe('side')
  })

  it('takes an explicit choice over any default', () => {
    const skins = game('g1', 'skins')
    const nassau = game('g2', 'nassau')
    expect(roleOf({ ...skins, role: 'main' }, [skins, nassau])).toBe('main')
    expect(roleOf({ ...nassau, role: 'side' }, [skins, nassau])).toBe('side')
  })

  /**
   * `role` arrives from imported JSON whose games are validated loosely, so a
   * value that is neither would otherwise be handed back typed as the union and
   * silently read as a main event by the first `=== 'side'` check.
   */
  it('ignores a role that is not one of the two things it can be', () => {
    const bogus = { ...game('g1', 'skins'), role: 'sausage' } as unknown as GameConfig
    expect(roleOf(bogus, [bogus])).toBe('main')
  })

  it('treats an unregistered game type as a main event', () => {
    const orphan = game('g1', 'notAGame')
    expect(roleOf(orphan, [orphan])).toBe('main')
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
  /** The front nine, named once: the holes scored, awarded and compared over. */
  const HOLES = [1, 2, 3, 4, 5, 6, 7, 8, 9]

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
  for (const engine of shippedEngines()) {
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
      const derived = deriveRound({ ...round, games }, log.events).derivations.get('game-1')!
      // games that need an in-round choice get one, or they never settle
      for (const input of derived.requiredInputs()) {
        log.append({
          type: 'game/event',
          gameId: 'game-1',
          kind: input.eventKind,
          data: { ...input.options[0]!.data, hole: input.hole, choice: input.options[0]!.value },
        })
      }
      // …and the same for the AWARD channel, for the same two reasons. It is
      // what makes an award game move money at all (without it the "moved no
      // money" assertion below fires), and `Award.data` is appended verbatim as
      // a game event exactly like `GameAction.data` — so an engine handing out
      // awards under one role and withholding them under another moves
      // different money the moment one is tapped.
      for (const hole of HOLES) {
        const cell = derived.awards?.(hole)[0]
        if (cell) {
          log.append({
            type: 'game/event',
            gameId: 'game-1',
            kind: cell.eventKind,
            data: cell.data,
          })
        }
      }
      // …and the ROUND-LEVEL FACTS an engine may read out of `RoundContext`
      // (MAI-90), for the third time and the same two reasons. Snake's money
      // does not exist without a three-putt, so the "moved money" assertion
      // below is unsatisfiable for it otherwise — and a game handing the snake
      // to a different player under one role would move different money while
      // every other field stayed identical.
      for (const hole of HOLES) {
        log.append({
          type: 'score/putts',
          playerId: players[hole % players.length]!.playerId,
          hole,
          putts: 3,
        })
      }
      // LAST: a game may settle only once the round is OVER — Snake pays
      // whoever is holding it at the final hole, and until then nothing is
      // owed. Nothing above depends on it, and every variant gets it.
      log.append({ type: 'round/completed' })
      return deriveRound({ ...round, games }, log.events).derivations.get('game-1')!
    }

    it(`settles ${engine.type} identically whether it is main, side, or unlabelled`, () => {
      // Everything a role could plausibly steer, not just the settlement:
      // `standings` carries `amountCents` and IS the money the standings sheet
      // shows, and the narration channels are money's explanation. Function
      // properties are dropped because they never compare equal.
      const money = (d: ReturnType<typeof scored>) => ({
        settlement: d.settlement,
        standings: d.standings,
        summary: d.summary,
        summaryParts: d.summaryParts,
        detailLines: d.detailLines,
        notes: d.notes,
        holeSummaries: HOLES.map((h) => d.holeSummary(h)),
        // the two channels that CREATE money: `GameAction.data` and
        // `Award.data` are appended verbatim as game events, so an engine
        // offering a press — or a greenie — under one role and withholding it
        // under another moves different money the moment it is taken, while
        // every field above stays identical
        actions: d.availableActions?.(),
        awards: HOLES.map((h) => d.awards?.(h)),
      })
      const asMain = scored('main')
      expect(money(scored('side'))).toEqual(money(asMain))
      // absent is what every round created before MAI-43 looks like
      expect(money(scored())).toEqual(money(asMain))
      // …and money actually moved, or the assertions above are vacuous
      expect(
        Object.values(asMain.settlement.perPlayerCents).some((c) => c !== 0),
        `${engine.type} moved no money — the guard proves nothing`,
      ).toBe(true)
    })
  }
})

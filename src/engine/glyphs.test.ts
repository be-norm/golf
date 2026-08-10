import { describe, expect, it } from 'vitest'
import './games/index'
import { deriveRound, listEngines } from './catalog'
import { GLYPH_NAMES, glyph, hasGlyphToken, parseGlyphs } from './core/glyphs'
import { EventLog, makePlayers, makeRound, TEST_ONLY_ENGINE_TYPES } from './test/harness'

describe('glyph tokens', () => {
  it('round-trips a known name', () => {
    expect(glyph('wolf-shades')).toBe(':wolf-shades:')
    expect(parseGlyphs(':wolf-shades:')).toEqual([{ kind: 'glyph', name: 'wolf-shades' }])
  })

  it('keeps the text either side, in order', () => {
    expect(parseGlyphs('a :wolf: b')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'glyph', name: 'wolf' },
      { kind: 'text', value: ' b' },
    ])
  })

  /**
   * A typo must be VISIBLE, not swallowed. A glyph that silently disappears
   * takes the sentence's meaning with it — "Ben (lone)" reading as "Ben" is
   * the failure this whole channel exists to prevent.
   */
  it('reports an unknown token rather than dropping it', () => {
    expect(parseGlyphs('x :wolf-shdes: y')).toEqual([
      { kind: 'text', value: 'x ' },
      { kind: 'unknown', value: ':wolf-shdes:' },
      { kind: 'text', value: ' y' },
    ])
    expect(hasGlyphToken('x :wolf-shdes: y')).toBe(true)
  })

  /** Ordinary prose has colons in it; none of them are tokens. */
  it('leaves prose alone', () => {
    for (const s of [
      'Wolf: Benjamin Norman',
      'TOTAL: Ben +$6 · DJ -$2',
      'H4: 3 skins died unwon',
      'net 4: the hole doubles',
      '',
    ]) {
      expect(hasGlyphToken(s), s).toBe(false)
    }
  })

  /**
   * The regex is not global, and `parseGlyphs` builds its own splitter, because
   * a `/g` regex carries `lastIndex` between calls — `.test()` on the same
   * string would alternate true/false.
   */
  it('gives the same answer twice', () => {
    expect(hasGlyphToken(':wolf:')).toBe(true)
    expect(hasGlyphToken(':wolf:')).toBe(true)
  })
})

/**
 * THE LEAK GUARD.
 *
 * A token is only meaningful in a channel that decodes it — `holeSummary` and
 * `requiredInputs`, the two the scoring and scorecard screens render through
 * `GlyphText`. Everywhere else it is literal text:
 *
 * - the pinned bar renders `summary` / `summaryParts` raw;
 * - `standings`, `detailLines` and `notes` are rendered raw too;
 * - and `settlement.lines`, `detailLines` and `notes` are what
 *   `buildSummaryCard` feeds to `paintSummaryCard`, which PAINTS THEM ONTO A
 *   CANVAS. A token there is rasterised as `:wolf:` into a PNG people send
 *   each other, and no renderer is left to catch it.
 *
 * So this walks every registered engine over a real card and fails on a token
 * anywhere but the two decoding channels.
 */
describe('glyph tokens stay in channels that decode them', () => {
  const HOLES = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  const CARD: Record<string, number[]> = {
    A: [4, 5, 3, 4, 6, 4, 3, 5, 4],
    B: [5, 4, 4, 4, 5, 5, 3, 4, 5],
    C: [4, 6, 4, 3, 5, 4, 4, 6, 4],
    D: [6, 4, 5, 4, 4, 3, 5, 5, 3],
  }
  const engines = listEngines().filter((e) => !TEST_ONLY_ENGINE_TYPES.includes(e.type))

  it('has engines to check at all', () => {
    expect(engines.length).toBeGreaterThanOrEqual(5)
  })

  /**
   * ANSWER FIRST *AND* LAST, which is the difference between a guard and a
   * decoration. `options[0]` is Wolf's first non-wolf PARTNER — the one pick
   * mode that emits no glyph — so a first-only sweep asserted "no tokens
   * leaked" over a card where the only engine with tokens produced none at all.
   * The last option is `blind`, and that is the state the undecoded channels
   * have to survive. `glyphs.test.ts` is cited by CLAUDE.md and the games
   * catalog as the thing that makes this rule real, so it has to be able to
   * fail: the test below this loop proves it can.
   */
  const settle = (engine: (typeof engines)[number], answer: 'first' | 'last') => {
    const names = ['A', 'B', 'C', 'D'].slice(0, engine.meta.minPlayers)
    const players = makePlayers(names.map((name, i) => ({ name, ch: i * 4 })))
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        {
          type: engine.type,
          config: engine.defaultConfig(players),
          handicap: engine.defaultHandicap(),
        },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, Object.fromEntries(names.map((n) => [n, CARD[n]!])))
    // answer whatever the game asks for, or it never settles and the channels
    // below are empty strings that trivially pass
    const first = deriveRound(round, log.events).derivations.get('game-1')!
    for (const input of first.requiredInputs()) {
      const o = answer === 'first' ? input.options[0]! : input.options[input.options.length - 1]!
      log.append({
        type: 'game/event',
        gameId: 'game-1',
        kind: input.eventKind,
        data: { ...o.data, hole: input.hole, choice: o.value },
      })
    }
    for (const hole of HOLES) {
      const cell = first.awards?.(hole)[0]
      if (cell) {
        log.append({ type: 'game/event', gameId: 'game-1', kind: cell.eventKind, data: cell.data })
      }
    }
    return deriveRound(round, log.events).derivations.get('game-1')!
  }

  /** Every string a screen renders WITHOUT `GlyphText`. */
  const undecodedOf = (d: ReturnType<typeof settle>) => {
    const undecoded = [
        d.summary,
        ...(d.summaryParts ?? []).flatMap((p) => [p.label, p.value]),
        ...d.standings.flatMap((s) => [s.label, s.detail ?? '']),
        ...(d.detailLines ?? []).flatMap((l) => [l.label, l.value]),
        ...(d.notes ?? []),
        ...d.settlement.lines.map((l) => l.label),
        ...(d.availableActions?.() ?? []).flatMap((a) => [
          a.label,
          a.detail,
          a.effect,
          // rendered raw beside the row, in a 9px column (ActionsSheet)
          a.recommendedReason ?? '',
        ]),
      ...HOLES.flatMap((h) => (d.awards?.(h) ?? []).flatMap((a) => [a.group, a.label])),
    ]
    return undecoded
  }

  for (const engine of engines) {
    for (const answer of ['first', 'last'] as const) {
      it(`${engine.type} keeps tokens out of the undecoded channels (${answer} answer)`, () => {
        const d = settle(engine, answer)
        const strings = [
          ...undecodedOf(d),
          // the affordance's own vocabulary (MAI-47) — button, sheet header,
          // explainer and empty state, none of which go through GlyphText
          ...Object.values(engine.meta.actions ?? {}),
        ]
        for (const s of strings) expect(hasGlyphToken(s), s).toBe(false)
      })
    }
  }

  /**
   * THE GUARD CAN FAIL — which is the only thing that makes the loop above
   * worth anything, and was not true when it answered `options[0]` alone.
   *
   * Answering LAST puts Wolf in blind, the state that actually emits a glyph.
   * `holeSummary` must carry one (it is decoded) and every undecoded channel
   * must not — so a token added to, say, `pickTag` (which feeds `summaryParts`,
   * rendered raw by the pinned bar) has somewhere to be caught.
   */
  it('is checking something — the last-answer sweep really derives a glyph', () => {
    const wolf = engines.find((e) => e.type === 'wolf')!
    const d = settle(wolf, 'last')
    // the token exists on this card...
    expect(HOLES.some((h) => d.holeSummary(h).some(hasGlyphToken))).toBe(true)
    // ...and the channels the loop checks are non-empty, so their silence means
    // something. A first-answer sweep produced neither.
    expect(undecodedOf(d).filter((s) => s.length > 0).length).toBeGreaterThan(5)
    // for contrast: answering first, Wolf never goes solo and emits nothing
    expect(HOLES.some((h) => settle(wolf, 'first').holeSummary(h).some(hasGlyphToken))).toBe(false)
  })

  it('every name has a token that parses back to it', () => {
    for (const name of GLYPH_NAMES) {
      expect(parseGlyphs(glyph(name))).toEqual([{ kind: 'glyph', name }])
    }
  })
})

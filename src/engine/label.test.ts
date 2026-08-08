import { describe, expect, it } from 'vitest'
import './games/index'
import { registerEngine } from './catalog'
import { skinsEngine } from './games/skins/engine'
import { LABEL_PROBE_ENGINE_TYPE } from './test/harness'
import { gameLabel, isPaintable } from './label'
import type { GameConfig, HandicapSettings } from './core/types'

const net: HandicapSettings = { mode: 'net', allowancePct: 100, reference: 'offLow' }
const gross: HandicapSettings = { mode: 'gross', allowancePct: 100, reference: 'absolute' }

const skins = (gameId: string, handicap: HandicapSettings, stakeCents = 100): GameConfig => ({
  gameId,
  type: 'skins',
  handicap,
  config: { stakeCents, carryover: true },
})

describe('gameLabel', () => {
  it('uses the engine name, not a transform of the type', () => {
    const sixPoint: GameConfig = {
      gameId: 'g1',
      type: 'sixPoint',
      handicap: net,
      config: { pointCents: 25 },
    }
    // the bug this replaces: "SixPoint" in the bar, "sixPoint" on the scorecard
    expect(gameLabel(sixPoint, [sixPoint])).toBe('Six Point')
  })

  it('leaves a lone game plainly named', () => {
    const one = skins('g1', net)
    const nassau: GameConfig = {
      gameId: 'g2',
      type: 'nassau',
      handicap: net,
      config: { stakeCents: 500, teams: null, autoPress: true },
    }
    // a round with other games in it, just not another Skins
    expect(gameLabel(one, [one, nassau])).toBe('Skins')
    expect(gameLabel(nassau, [one, nassau])).toBe('Nassau')
  })

  it('separates gross skins from net skins — the case that motivated it', () => {
    const a = skins('g1', net)
    const b = skins('g2', gross)
    expect(gameLabel(a, [a, b])).toBe('Skins (net)')
    expect(gameLabel(b, [a, b])).toBe('Skins (gross)')
  })

  it('falls to a config field when handicap mode is shared', () => {
    const cheap = skins('g1', net, 100)
    const dear = skins('g2', net, 500)
    expect(gameLabel(cheap, [cheap, dear])).toBe('Skins ($1)')
    expect(gameLabel(dear, [cheap, dear])).toBe('Skins ($5)')
  })

  /**
   * Config fields are walked declaratively off `configFields`, so a difference
   * the engine already declares gets named without label.ts knowing the game.
   * Carryover is a boolean field; before this it fell through to "#1"/"#2",
   * which tells the player nothing about which bet is which.
   */
  it('names a boolean config difference rather than numbering', () => {
    const rolls: GameConfig = { ...skins('g1', net), config: { stakeCents: 100, carryover: true } }
    const flat: GameConfig = { ...skins('g2', net), config: { stakeCents: 100, carryover: false } }
    expect(gameLabel(rolls, [rolls, flat])).toBe('Skins (carryovers)')
    expect(gameLabel(flat, [rolls, flat])).toBe('Skins (no carryovers)')
  })

  /**
   * THE bug this logic is shaped around. Handicap mode VARIES across these
   * three, but it does not separate them — labelling each with its own mode
   * prints "gross" twice, which is the duplicate the function exists to
   * prevent. A candidate is only usable when every sibling gets a different
   * answer, so this falls through to numbering.
   */
  it('rejects a difference that varies but does not separate every sibling', () => {
    const a = skins('g1', net)
    const b = skins('g2', gross)
    const c = skins('g3', gross)
    const labels = [a, b, c].map((g) => gameLabel(g, [a, b, c]))
    expect(labels).toEqual(['Skins (#1)', 'Skins (#2)', 'Skins (#3)'])
    expect(new Set(labels).size).toBe(3)
  })

  /**
   * Two bets identical in every nameable way. Numbering them is still better
   * than two rows both reading "Skins" — the player at least knows there are
   * two, which is the whole job of the label.
   */
  it('numbers siblings that are alike in every way we can name', () => {
    const a = skins('g1', net)
    const b = skins('g2', net)
    expect(gameLabel(a, [a, b])).toBe('Skins (#1)')
    expect(gameLabel(b, [a, b])).toBe('Skins (#2)')
  })

  /**
   * The label is painted onto the share card in the Press Start 2P display
   * font, where every other string has stayed plain ASCII. A glyph that font
   * lacks falls back per-glyph to the system face and renders mid-title in the
   * wrong typeface — and jsdom has no canvas, so nothing downstream can catch
   * it. Keep the label ASCII-only.
   */
  it('stays ASCII, because the share card paints it in the pixel font', () => {
    const a = skins('g1', net)
    const b = skins('g2', gross)
    for (const label of [gameLabel(a, [a, b]), gameLabel(b, [a, b])]) {
      expect(isPaintable(label)).toBe(true)
    }
  })

  /**
   * The ASCII rule has to hold for text this file never sees. Boolean and select
   * phrases come from engine-authored `configFields` labels, and this repo
   * already writes "·" into exactly that kind of string — nassau's teams field
   * is `'Teams (best ball · 2v2 or 2v1)'`, off the card today only because
   * `teams` has no short form. So the guard lives in `renderFieldValue`: an
   * unpaintable phrase is skipped rather than shown, and the label degrades to
   * numbering instead of painting a glyph in the wrong typeface.
   */
  it('refuses an engine-authored label the pixel font cannot paint', () => {
    registerEngine({
      ...skinsEngine,
      // named in TEST_ONLY_ENGINE_TYPES so registry guards skip it by name
      // rather than relying on vitest's per-file isolation
      type: LABEL_PROBE_ENGINE_TYPE,
      configFields: [
        { key: 'stakeCents', kind: 'money', label: 'Stake' },
        // the shape of label this codebase actually writes (nassau ships one)
        { key: 'carryover', kind: 'boolean', label: 'Carryovers · rollover' },
      ],
    })
    const a: GameConfig = {
      gameId: 'g1',
      // named in TEST_ONLY_ENGINE_TYPES so registry guards skip it by name
      // rather than relying on vitest's per-file isolation
      type: LABEL_PROBE_ENGINE_TYPE,
      handicap: net,
      config: { stakeCents: 100, carryover: true },
    }
    const b: GameConfig = { ...a, gameId: 'g2', config: { stakeCents: 100, carryover: false } }
    const labels = [gameLabel(a, [a, b]), gameLabel(b, [a, b])]
    // fell through to numbering rather than emitting the middle dot
    expect(labels).toEqual(['Skins (#1)', 'Skins (#2)'])
    for (const label of labels) expect(isPaintable(label)).toBe(true)
  })

  /**
   * `importSchema` repairs `handicap` and `config` now, but this function is
   * called on whatever is in Dexie — including rows written before that repair
   * existed. Every deref here is optional for that reason; an unguarded one
   * white-screens the scoring card on a restored round rather than degrading
   * to a duller label.
   */
  it('survives a game with no handicap or config at all', () => {
    const bare = { gameId: 'g1', type: 'skins' } as unknown as GameConfig
    const bare2 = { gameId: 'g2', type: 'skins' } as unknown as GameConfig
    expect(() => gameLabel(bare, [bare, bare2])).not.toThrow()
    expect(gameLabel(bare, [bare, bare2])).toBe('Skins (#1)')
    expect(gameLabel(bare2, [bare, bare2])).toBe('Skins (#2)')

    // and a config missing the key the discriminator would have reached for
    const noConfig = { ...skins('g1', net), config: undefined } as unknown as GameConfig
    expect(() => gameLabel(noConfig, [noConfig, skins('g2', net)])).not.toThrow()
  })

  /**
   * Two unregistered types both sanitise to the placeholder, so grouping
   * siblings by `type` would call each an only child and paint two rows
   * reading exactly "Game".
   */
  it('tells apart two unregistered games that sanitise to the same name', () => {
    const a: GameConfig = { gameId: 'g1', type: 'スキンズ', handicap: net, config: {} }
    const b: GameConfig = { gameId: 'g2', type: 'ウルフ', handicap: net, config: {} }
    const labels = [gameLabel(a, [a, b]), gameLabel(b, [a, b])]
    expect(new Set(labels).size).toBe(2)
    expect(labels).toEqual(['Game (#1)', 'Game (#2)'])
  })

  it('falls back to the raw type for an engine that is not registered', () => {
    const orphan: GameConfig = { gameId: 'g1', type: 'notAGame', handicap: net, config: {} }
    // an imported round naming a game this build doesn't ship
    expect(gameLabel(orphan, [orphan])).toBe('notAGame')
  })

  /**
   * The unregistered-type fallback is the one path around the paintability
   * choke point: `exportRound` validates `type` as any string, so an imported
   * card can put arbitrary text straight into the painted title.
   */
  it('sanitises an unregistered type the pixel font cannot paint', () => {
    const jp: GameConfig = { gameId: 'g1', type: 'スキンズ', handicap: net, config: {} }
    expect(gameLabel(jp, [jp])).toBe('Game')

    const mixed: GameConfig = { gameId: 'g1', type: 'Skins — net', handicap: net, config: {} }
    const label = gameLabel(mixed, [mixed])
    expect(isPaintable(label)).toBe(true)
    // whitespace collapsed, not doubled: `wrapText` splits a double space
    // into an empty token
    expect(label).toBe('Skins net')
  })

  /**
   * Allowance is the LAST named tier rather than never: two of the four
   * surfaces that render a label show no allowance beside it, so refusing it
   * outright left those games as a meaningless "#1"/"#2".
   */
  it('names an allowance difference when nothing else separates them', () => {
    const full = skins('g1', net)
    const ninety = skins('g2', { ...net, allowancePct: 90 })
    expect(gameLabel(full, [full, ninety])).toBe('Skins (100%)')
    expect(gameLabel(ninety, [full, ninety])).toBe('Skins (90%)')
  })
})

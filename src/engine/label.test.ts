import { describe, expect, it } from 'vitest'
import './games/index'
import { gameLabel } from './label'
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
      expect(label).toMatch(/^[\x20-\x7E]+$/)
    }
  })

  it('falls back to the raw type for an engine that is not registered', () => {
    const orphan: GameConfig = { gameId: 'g1', type: 'notAGame', handicap: net, config: {} }
    // an imported round naming a game this build doesn't ship
    expect(gameLabel(orphan, [orphan])).toBe('notAGame')
  })
})

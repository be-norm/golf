import { describe, expect, it } from 'vitest'
import { cardScale, wrapText } from './paintSummaryCard'

/**
 * The painter is deliberately untested as a whole — jsdom has no 2D context,
 * and every number it draws comes pre-computed from `summaryCard.ts`, which is
 * tested. `wrapText` is the exception: it owns the only loop in the file with a
 * termination condition, and a wrong one hangs the share sheet rather than
 * drawing something slightly off. So it takes its measurer as an argument.
 *
 * One char = one unit here, which is what a monospace pixel font approximates.
 */
const mono = (s: string) => s.length

describe('wrapText', () => {
  it('keeps a short line whole', () => {
    expect(wrapText(mono, 'Ben wins', 20)).toEqual(['Ben wins'])
  })

  it('breaks greedily at spaces', () => {
    expect(wrapText(mono, 'Ben & Rob win by three holes', 12)).toEqual([
      'Ben & Rob',
      'win by three',
      'holes',
    ])
  })

  it('never emits a line wider than the limit', () => {
    const text = 'Bartholomew & Fitzwilliam-Cholmondeley win the front nine outright'
    for (const max of [4, 7, 11, 20, 33]) {
      for (const line of wrapText(mono, text, max)) {
        expect(line.length).toBeLessThanOrEqual(max)
      }
    }
  })

  it('chops a token that has no break opportunity', () => {
    // the old greedy-only rule accepted this whole and let it run off the panel
    expect(wrapText(mono, 'Llanfairpwllgwyngyll', 8)).toEqual([
      'Llanfair',
      'pwllgwyn',
      'gyll',
    ])
  })

  it('chops an over-long token that follows a normal word', () => {
    expect(wrapText(mono, 'at Llanfairpwllgwyngyll', 10)).toEqual([
      'at',
      'Llanfairpw',
      'llgwyngyll',
    ])
  })

  it('terminates when the limit is narrower than a single glyph', () => {
    // pathological, but it must not hang the share sheet
    expect(wrapText(mono, 'abc', 0)).toEqual(['a', 'b', 'c'])
  })

  it('loses no characters', () => {
    const text = 'Colby & Benjamin halve the back nine after a Supercalifragilistic press'
    for (const max of [5, 9, 16, 40]) {
      expect(wrapText(mono, text, max).join('').replace(/ /g, '')).toBe(
        text.replace(/ /g, ''),
      )
    }
  })

  it('is empty-safe', () => {
    expect(wrapText(mono, '', 10)).toEqual([])
  })
})

/**
 * The other pure part of the painter. Everything else here measures text in a
 * 2D context, which jsdom does not have — but the retina cliff is arithmetic,
 * and getting it wrong ships the card people actually share at half resolution
 * without any visible failure.
 */
describe('cardScale', () => {
  it('paints at 2× for any realistic round', () => {
    // a 4-player, 8-game round lands well inside this; the tall end of the
    // range is a nine played twice with a full scorecard
    expect(cardScale(900)).toBe(2)
    expect(cardScale(2400)).toBe(2)
  })

  it('drops to 1× only at the real ceiling, not the legacy one', () => {
    // 8192 per side is what iOS Safari enforces, so 2× survives to 4096 logical
    // px. The legacy 4096 figure put this cliff at 2048 — which a 4-player
    // 3-game round clears, and those rounds shipped at 480px wide.
    expect(cardScale(4096)).toBe(2)
    expect(cardScale(4097)).toBe(1)
  })
})

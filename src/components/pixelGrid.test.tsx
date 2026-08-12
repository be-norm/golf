import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { mergedRects } from './pixelGrid'

/**
 * THE ONE EMITTER BEHIND EVERY DRAWING IN THE APP, and the only genuinely
 * fiddly logic in the pixel-art work — a greedy 2D merge over a `taken` mask.
 *
 * Nothing else pins it. The sprite tests assert a frame has SOME rects and the
 * icon test compares two independent encoders, so a merge that grew a rectangle
 * over a cell another had claimed would repaint pixels in the wolf, the coin,
 * the scan card and the banner at once, with the suite green.
 *
 * So these check the property that matters — the rects reconstruct the grid
 * exactly, and cover every painted cell once — rather than a particular
 * decomposition, which is the emitter's business to choose.
 */
const paint = (rows: readonly string[], legend: Record<string, string>) => {
  const { container } = render(mergedRects(rows.map((r) => r.split('')), legend, 'k'))
  return [...container.querySelectorAll('rect')].map((r) => ({
    x: +r.getAttribute('x')!,
    y: +r.getAttribute('y')!,
    w: +r.getAttribute('width')!,
    h: +r.getAttribute('height')!,
    fill: r.getAttribute('fill')!,
  }))
}

/** Replay the rects onto a blank grid — what the browser will actually show. */
const replay = (rects: ReturnType<typeof paint>, w: number, h: number) => {
  const out = Array.from({ length: h }, () => Array<string>(w).fill('.'))
  let painted = 0
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        expect(out[y]![x], `cell ${x},${y} painted twice`).toBe('.')
        out[y]![x] = r.fill
        painted += 1
      }
    }
  }
  return { rows: out.map((r) => r.join('')), painted }
}

describe('mergedRects', () => {
  const L = { a: 'A', b: 'B' }

  it('reconstructs the grid exactly, painting every cell once', () => {
    const rows = ['aabba', 'aabba', 'abbba', '.....', 'ababa']
    const { rows: back } = replay(paint(rows, L), 5, 5)
    expect(back).toEqual(['AABBA', 'AABBA', 'ABBBA', '.....', 'ABABA'])
  })

  it('grows a rectangle down only while the whole span still matches', () => {
    // the 2-wide run of `a` on row 0 cannot deepen, because row 1 breaks it
    const rects = paint(['aa', 'ab'], L)
    expect(rects).toContainEqual({ x: 0, y: 0, w: 2, h: 1, fill: 'A' })
    expect(replay(rects, 2, 2).rows).toEqual(['AA', 'AB'])
  })

  it('merges a solid field into a single rectangle', () => {
    expect(paint(['aaa', 'aaa', 'aaa'], L)).toEqual([{ x: 0, y: 0, w: 3, h: 3, fill: 'A' }])
  })

  it('leaves characters the legend does not name transparent', () => {
    // how a silhouette keeps its background: unknown characters paint nothing
    const rects = paint(['a?a'], L)
    expect(replay(rects, 3, 1).painted).toBe(2)
  })
})

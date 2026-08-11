import type { ReactElement } from 'react'
import type { CelebrationSprite } from '../engine/core/celebration'
import { FRAME_MS } from '../lib/motion'

/**
 * ANIMATED 16×16 pixel art — the moving counterpart to `PixelGlyph`, in the
 * same idiom `public/icon.svg` set: `shape-rendering="crispEdges"` rects on a
 * 16-unit grid, in the theme palette.
 *
 * A sprite is N frames drawn side by side into one wide SVG. The SVG sits in a
 * one-frame-wide `overflow:hidden` box and the whole strip is translated one
 * frame at a time under `steps()`. Nothing tweens: frame 2 replaces frame 1
 * whole, which is the difference between pixel art that moves and a picture
 * being slid around.
 *
 * INTEGER SCALE ONLY, for the reason `PixelGlyph` documents at length — crisp
 * rects snap to device pixels, and at a fractional scale they snap to DIFFERENT
 * widths, so a coin comes out with one flat side. Note this is also why the
 * size is set in explicit pixels rather than with a Tailwind `size-*` class:
 * those are rem-based against a 19px root, so `size-16` is 76px, not 64.
 *
 * `data-sprite` is both the test handle and what the reduced-motion rule in
 * `index.css` selects on to freeze the strip at frame 0.
 */

/* ── palette ─────────────────────────────────────────────── */
const GOLD = '#ffd23e' // coin-400
const GOLD_DARK = '#f5b800' // coin-500
const GOLD_EDGE = '#8a6a00' // darker than any token; the coin's rim in shadow
const GLINT = '#fff6d0'

/** A run of pixels: [y, x, width]. Frames are drawn as lists of these — far
 *  easier to read and re-shape than a wall of <rect>, and it keeps every value
 *  on the integer grid by construction. */
type Run = readonly [y: number, x: number, w: number]

function runs(list: readonly Run[], fill: string, key: string): ReactElement {
  return (
    <>
      {list.map(([y, x, w], i) => (
        <rect key={`${key}-${i}`} x={x} y={y} width={w} height={1} fill={fill} />
      ))}
    </>
  )
}

/** The coin's silhouette at four widths — one full turn. Rows 3–12 throughout,
 *  so it spins about its own axis instead of bobbing. */
const DISC: readonly Run[] = [
  [3, 6, 4],
  [4, 4, 8],
  [5, 3, 10],
  [6, 3, 10],
  [7, 3, 10],
  [8, 3, 10],
  [9, 3, 10],
  [10, 3, 10],
  [11, 4, 8],
  [12, 6, 4],
]

const HALF: readonly Run[] = [
  [3, 7, 2],
  [4, 6, 4],
  [5, 5, 6],
  [6, 5, 6],
  [7, 5, 6],
  [8, 5, 6],
  [9, 5, 6],
  [10, 5, 6],
  [11, 6, 4],
  [12, 7, 2],
]

const EDGE: readonly Run[] = [
  [3, 7, 2],
  [4, 7, 2],
  [5, 7, 2],
  [6, 7, 2],
  [7, 7, 2],
  [8, 7, 2],
  [9, 7, 2],
  [10, 7, 2],
  [11, 7, 2],
  [12, 7, 2],
]

const COIN_FRAMES: readonly ReactElement[] = [
  // face on, with a glint high-left and the rim shaded low-right
  <>
    {runs(DISC, GOLD, 'd')}
    {runs(
      [
        [10, 5, 6],
        [11, 6, 4],
        [12, 6, 4],
      ],
      GOLD_DARK,
      'ds',
    )}
    <rect x="5" y="5" width="2" height="1" fill={GLINT} />
    <rect x="5" y="6" width="1" height="1" fill={GLINT} />
  </>,
  // turning away
  <>
    {runs(HALF, GOLD, 'h')}
    {runs(
      [
        [10, 5, 6],
        [11, 6, 4],
      ],
      GOLD_DARK,
      'hs',
    )}
    <rect x="6" y="5" width="1" height="1" fill={GLINT} />
  </>,
  // edge on — the whole coin is rim
  <>{runs(EDGE, GOLD_EDGE, 'e')}</>,
  // coming back round, lit from the other side
  <>
    {runs(HALF, GOLD_DARK, 'h2')}
    {runs(
      [
        [4, 6, 4],
        [5, 5, 6],
        [6, 5, 6],
      ],
      GOLD,
      'h2l',
    )}
  </>,
]

const SPRITES = {
  coin: { frames: COIN_FRAMES, label: 'a coin' },
} as const satisfies Record<string, { frames: readonly ReactElement[]; label: string }>

export type SpriteName = keyof typeof SPRITES

/**
 * EVERY CELEBRATION TOKEN MUST HAVE ART. The engine owns the token list and
 * cannot see this file, so without this the first game to name a sprite nobody
 * drew would render an empty box at runtime instead of failing to compile.
 * Mirrors the `Covers<>` idiom in `catalog.test.ts`.
 */
type CelebrationsHaveArt =
  [Exclude<CelebrationSprite, SpriteName>] extends [never]
    ? true
    : ['no PixelSprite art for:', Exclude<CelebrationSprite, SpriteName>]
const _celebrationsCovered: CelebrationsHaveArt = true
void _celebrationsCovered

interface PixelSpriteProps {
  name: SpriteName
  /** integer multiplier on the 16px grid — 4 renders a 64px sprite */
  scale?: number
  /** loop forever (a progress indicator) rather than play once and hold */
  loop?: boolean
  /** ms per frame; defaults to the house rate */
  frameMs?: number
  /**
   * Given a label the sprite announces itself; without one it is decorative.
   * Default decorative, because a celebration's meaning is carried by the words
   * beside it and a screen reader should not hear the picture twice.
   */
  label?: string
}

export function PixelSprite({
  name,
  scale = 3,
  loop = false,
  frameMs = FRAME_MS,
  label,
}: PixelSpriteProps) {
  const { frames } = SPRITES[name]
  const n = frames.length
  const cell = 16 * scale

  // A LOOP runs all N frames and wraps, so it travels a full N cells and the
  // last frame gets its own slice of time before frame 0 comes back. A ONE-SHOT
  // must come to rest ON the final frame, so it travels N-1 cells in N-1 steps
  // and holds — travelling N would park the strip one cell past the art and
  // leave an empty box on screen.
  const steps = loop ? n : Math.max(1, n - 1)
  const travel = -cell * steps

  return (
    <div
      data-sprite={name}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: cell, height: cell, overflow: 'hidden', display: 'inline-block' }}
    >
      <svg
        viewBox={`0 0 ${16 * n} 16`}
        shapeRendering="crispEdges"
        focusable="false"
        style={{
          width: cell * n,
          height: cell,
          display: 'block',
          ['--sprite-travel' as string]: `${travel}px`,
          animationName: 'sprite-strip',
          animationDuration: `${frameMs * steps}ms`,
          animationTimingFunction: `steps(${steps})`,
          animationIterationCount: loop ? 'infinite' : 1,
          animationFillMode: 'forwards',
        }}
      >
        {frames.map((frame, i) => (
          <g key={i} transform={`translate(${i * 16}, 0)`}>
            {frame}
          </g>
        ))}
      </svg>
    </div>
  )
}

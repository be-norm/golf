import type { ReactElement } from 'react'
import type { CelebrationSprite } from '../engine/core/celebration'
import { FRAME_MS } from '../lib/motion'
import { SWING_SIZE, WOLF_SHADES_SWING_FRAMES, WOLF_SWING_FRAMES } from './wolfArt'

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
 * EACH SPRITE DECLARES ITS OWN GRID. 16 is the house size and what everything
 * inline uses, but a sprite that plays large — the wolf's swing, centre screen
 * at five times scale — has to be drawn at 32 or it reads as flat and cheap.
 * The grid is per-sprite rather than global because the two live side by side:
 * the same wolf is a 16px mark in a ledger line and a 32px figure mid-swing.
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

/* ── the wolf, taking a swing at it ─────────────────────── */
/**
 * The art is `wolfArt.tsx`'s, beside the still head `PixelGlyph` renders — one
 * animal, one palette, and the only sprite here drawn on the 32 grid.
 */
/* ── the course, as `public/icon.svg` draws it ───────────── */
/**
 * THE ICON, REDRAWN AS FRAMES. Same subject, same palette and the same rects as
 * `public/icon.svg` — deliberately, so the home screen animates the mark people
 * already have on their home screen rather than introducing a second one. Any
 * change to the icon belongs in both, and MAI-12's 1024px source should be
 * exported from this drawing rather than become a third.
 */
const SKY = '#052e16' // felt-950
const TURF_HI = '#15803d' // felt-700
const TURF = '#16a34a' // felt-600
const CUP = '#04220f'
const STICK = '#e7e5e4'
const FLAG = '#ff4444' // flag-500
const FLAG_DARK = '#dc2626' // flag-600
const BALL = '#fafaf9'
const SPARK = '#7dff66' // felt-300

function course() {
  return (
    <>
      <rect x="0" y="0" width="16" height="10" fill={SKY} />
      <rect x="0" y="10" width="16" height="2" fill={TURF_HI} />
      <rect x="0" y="12" width="16" height="4" fill={TURF} />
      <rect x="9" y="11" width="4" height="1" fill={CUP} />
      <rect x="10" y="2" width="1" height="9" fill={STICK} />
    </>
  )
}

/** Two flag shapes — the ripple is the whole animation of a flag. */
function flag(furled: boolean) {
  return furled ? (
    <>
      <rect x="11" y="2" width="3" height="1" fill={FLAG} />
      <rect x="11" y="3" width="4" height="1" fill={FLAG} />
      <rect x="11" y="4" width="3" height="1" fill={FLAG_DARK} />
    </>
  ) : (
    <>
      <rect x="11" y="2" width="4" height="1" fill={FLAG} />
      <rect x="11" y="3" width="3" height="1" fill={FLAG} />
      <rect x="11" y="4" width="2" height="1" fill={FLAG_DARK} />
    </>
  )
}

function ball(x: number) {
  return (
    <>
      <rect x={x} y="12" width="2" height="2" fill={BALL} />
      <rect x={x} y="12" width="1" height="1" fill="#ffffff" />
    </>
  )
}

/** The ball finds the cup, the flag ripples the whole way. Five frames. */
const LOGO_FRAMES: readonly ReactElement[] = [
  <>
    {course()}
    {flag(false)}
    {ball(3)}
  </>,
  <>
    {course()}
    {flag(true)}
    {ball(5)}
  </>,
  <>
    {course()}
    {flag(false)}
    {ball(7)}
  </>,
  <>
    {course()}
    {flag(true)}
    {ball(9)}
  </>,
  // dropped: the cup, and the little burst of nothing that follows a putt
  <>
    {course()}
    {flag(false)}
    <rect x="8" y="9" width="1" height="1" fill={SPARK} />
    <rect x="13" y="8" width="1" height="1" fill={SPARK} />
    <rect x="10" y="7" width="1" height="1" fill={SPARK} />
  </>,
]

/**
 * FIRST TEE — the flag goes in. The stick drops from above and the flag unfurls
 * behind it, which is the picture of a hole being made ready to play.
 */
const FLAG_PLANT_FRAMES: readonly ReactElement[] = [
  <>
    <rect x="0" y="0" width="16" height="10" fill={SKY} />
    <rect x="0" y="10" width="16" height="2" fill={TURF_HI} />
    <rect x="0" y="12" width="16" height="4" fill={TURF} />
    <rect x="9" y="11" width="4" height="1" fill={CUP} />
  </>,
  <>
    <rect x="0" y="0" width="16" height="10" fill={SKY} />
    <rect x="0" y="10" width="16" height="2" fill={TURF_HI} />
    <rect x="0" y="12" width="16" height="4" fill={TURF} />
    <rect x="9" y="11" width="4" height="1" fill={CUP} />
    <rect x="10" y="0" width="1" height="5" fill={STICK} />
  </>,
  <>
    {course()}
    <rect x="11" y="2" width="1" height="1" fill={FLAG} />
  </>,
  <>
    {course()}
    <rect x="11" y="2" width="2" height="1" fill={FLAG} />
    <rect x="11" y="3" width="2" height="1" fill={FLAG_DARK} />
  </>,
  <>
    {course()}
    {flag(false)}
    <rect x="4" y="5" width="1" height="1" fill={SPARK} />
    <rect x="14" y="7" width="1" height="1" fill={SPARK} />
  </>,
]

/* ── reading a scorecard ─────────────────────────────────── */
const CARD_BG = '#1c1917'
const CARD_LINE = '#44403c'
const CARD_EDGE = '#15803d'

function scorecard() {
  return (
    <>
      <rect x="0" y="0" width="16" height="16" fill={CARD_EDGE} />
      <rect x="1" y="1" width="14" height="14" fill={CARD_BG} />
      {[4, 7, 10, 13].map((y) => (
        <rect key={y} x="2" y={y} width="12" height="1" fill={CARD_LINE} />
      ))}
      <rect x="6" y="2" width="1" height="12" fill={CARD_LINE} />
      <rect x="10" y="2" width="1" height="12" fill={CARD_LINE} />
    </>
  )
}

/**
 * SCANNING — a bright line walks down the card, the way the CRT overlay walks
 * down the app. Loops for as long as the request takes, which is the point: it
 * is a progress indicator, not a celebration, and the wait is what it is for.
 */
const SCAN_FRAMES: readonly ReactElement[] = [2, 4, 6, 8, 10, 12, 14].map((y) => (
  <>
    {scorecard()}
    <rect x="1" y={y} width="14" height="1" fill={SPARK} />
    {y > 2 && <rect x="1" y={y - 1} width="14" height="1" fill="#22c55e" opacity="0.5" />}
  </>
))

/**
 * No labels live here: every sprite in the app today rides beside words that
 * already say the thing — "Reading scorecard…", "★ First tee ★", the
 * celebration's own text — so they are decorative, and a caller that needs an
 * announced one passes `label`. A label per sprite read as thorough and was
 * simply never used, which is worse than none.
 */
const SPRITES = {
  coin: { frames: COIN_FRAMES, grid: 16 },
  wolf: { frames: WOLF_SWING_FRAMES, grid: SWING_SIZE },
  'wolf-shades': { frames: WOLF_SHADES_SWING_FRAMES, grid: SWING_SIZE },
  logo: { frames: LOGO_FRAMES, grid: 16 },
  'flag-plant': { frames: FLAG_PLANT_FRAMES, grid: 16 },
  scan: { frames: SCAN_FRAMES, grid: 16 },
} as const satisfies Record<string, { frames: readonly ReactElement[]; grid: number }>

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
  /** integer multiplier on the sprite's own grid — 4 renders a 16-grid sprite
   *  at 64px and a 32-grid one at 128px */
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
  const { frames, grid } = SPRITES[name]
  const n = frames.length
  const cell = grid * scale

  // A LOOP runs all N frames and wraps, so it travels a full N cells and the
  // last frame gets its own slice of time before frame 0 comes back. A ONE-SHOT
  // must come to rest ON the final frame, so it travels N-1 cells in N-1 steps
  // and holds — travelling N would park the strip one cell past the art and
  // leave an empty box on screen.
  const steps = loop ? n : Math.max(1, n - 1)
  const travel = -cell * steps

  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: cell, height: cell, overflow: 'hidden', display: 'inline-block' }}
    >
      <svg
        // ON THE ANIMATED ELEMENT, not the wrapper — `animation` does not
        // inherit, so the reduced-motion rule in `index.css` selects this and a
        // `data-sprite` one element up would silently match nothing while
        // looking exactly right. Same placement as `PixelGlyph`'s `data-glyph`.
        data-sprite={name}
        viewBox={`0 0 ${grid * n} ${grid}`}
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
          <g key={i} transform={`translate(${i * grid}, 0)`}>
            {frame}
          </g>
        ))}
      </svg>
    </span>
  )
}

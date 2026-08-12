import type { ReactElement } from 'react'
import type { CelebrationSprite } from '../engine/core/celebration'
import { FRAME_MS } from '../lib/motion'
import { once } from '../lib/once'
import { mergedRects } from './pixelGrid'
import {
  BANNER_H,
  BANNER_W,
  courseBackdrop,
  COURSE_FLAG_PLANT_FRAMES,
  COURSE_IDLE_FRAMES,
  COURSE_LOGO_FRAMES,
} from './courseArt'
import { SWING_SIZE, WOLF_SHADES_SWING_FRAMES, WOLF_SWING_FRAMES } from './wolfArt'

/**
 * ANIMATED 16×16 pixel art — the moving counterpart to `PixelGlyph`, in the
 * same idiom the app icon set: `shape-rendering="crispEdges"` rects on a
 * 16-unit grid, in the theme palette.
 *
 * A sprite is N frames drawn side by side into one wide SVG. The SVG sits in a
 * one-frame-wide `overflow:hidden` box and the whole strip is translated one
 * frame at a time under `steps()`. Nothing tweens: frame 2 replaces frame 1
 * whole, which is the difference between pixel art that moves and a picture
 * being slid around.
 *
 * EACH SPRITE DECLARES ITS OWN SIZE, and it need not be square. 16 is the house
 * grid and what everything inline uses, but a sprite that plays large — the
 * wolf's swing, centre screen at five times scale — has to be drawn at 32 or it
 * reads as flat and cheap, and one that spans a screen (the course banner) is
 * drawn wider than it is tall, because a square asked to fill a width either
 * crops or leaves the sides empty.
 *
 * FRAMES ARE A THUNK, not an array: every screen imports this module and a
 * banner is thousands of nodes, so the strips are built the first time one is
 * actually rendered rather than on the critical path of a cold start.
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

/* ── the coin ────────────────────────────────────────────── */
/**
 * A SPINNING COIN, redrawn at 32 with a dark rim. It is a CHARACTER sprite —
 * it flies free over the scoring grid at 64px and up, with nothing behind it —
 * so it takes the one-pixel outline, and at 16 with four flat tones it was the
 * last thing in the app still reading as NES (`docs/pixel-art.md`).
 *
 * Four widths make one full turn, about its own axis rather than bobbing. The
 * face carries a `$`, which is what the coin is for and what ties it to the
 * flag; edge-on it is all rim and the `$` is gone, which is the frame that
 * sells the rotation.
 */
const GOLD_LIT = '#ffe98a'
const GOLD = '#ffd23e' // coin-400
const GOLD_MID = '#f5b800' // coin-500
const GOLD_DEEP = '#a97c00'
const RIM = '#2a1c00'

const COIN_LEGEND: Record<string, string> = {
  o: RIM,
  L: GOLD_LIT,
  G: GOLD,
  M: GOLD_MID,
  D: GOLD_DEEP,
}

type CoinGrid = string[][]

/** one turn: face on, three-quarter, edge, three-quarter back */
const COIN_WIDTHS = [13, 8, 3, 8] as const
/** which way the light falls — it swaps as the face turns away and back */
const COIN_LIT_LEFT = [true, true, false, false] as const

function coinFrame(i: number): CoinGrid {
  const g: CoinGrid = Array.from({ length: 32 }, () => Array<string>(32).fill(' '))
  const put = (x: number, y: number, ch: string) => {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px >= 0 && px < 32 && py >= 0 && py < 32) g[py]![px] = ch
  }
  const rx = COIN_WIDTHS[i]!
  const ry = 13
  const cx = 15.5
  const cy = 15.5
  const litLeft = COIN_LIT_LEFT[i]!
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      const d = dx * dx + dy * dy
      if (d > 1) continue
      // the rim is the outer band of the disc, darker where it turns away
      if (d > 0.72) {
        put(x, y, 'D')
        continue
      }
      const towardLight = (litLeft ? -1 : 1) * dx + -dy
      put(x, y, towardLight > 0.7 ? 'L' : towardLight > -0.35 ? 'G' : 'M')
    }
  }
  // the $ on the face — only while there is a face to carry it
  if (rx >= 8) {
    const D = ['ooo', 'oo.', 'ooo', '.oo', 'ooo']
    D.forEach((row, j) => {
      for (let k = 0; k < row.length; k++) {
        if (row[k] === 'o') put(cx - 1 + k, cy - 2.5 + j, 'D')
      }
    })
    put(cx, cy - 3.5, 'D')
    put(cx, cy + 2.5, 'D')
  }
  // one-pixel rim, drawn last so it survives everything
  const out = g.map((row) => [...row])
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (g[y]![x] !== ' ') continue
      const touching = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([ax, ay]) => {
        const a = x + ax
        const b = y + ay
        return a >= 0 && a < 32 && b >= 0 && b < 32 && g[b]![a] !== ' '
      })
      if (touching) out[y]![x] = 'o'
    }
  }
  return out
}

const COIN_FRAMES = once(() => [0, 1, 2, 3].map((i) => mergedRects(coinFrame(i), COIN_LEGEND, `coin${i}`)))

/**
 * THE SAME COIN AT 16, and a second drawing rather than a scaled one — which is
 * the standard's rule (grid follows render size), not a duplication. The settle
 * screen's confetti is 6–14px specks, and a 32-grid sprite cannot render below
 * 32px at integer scale, so the big coin lands there five times the size of the
 * paper it falls with. Same relationship the wolf has: a 16px mark and a 32px
 * sprite are different pictures of one thing.
 *
 * Flat and rimless on purpose. At 16px a rim eats the outer ring, and a third
 * gold reads as dirt.
 */
const SMALL: Record<string, string> = { G: GOLD, M: GOLD_MID, D: GOLD_DEEP, L: GOLD_LIT }
/**
 * SEMI-axes, like `coinFrame`'s. They were read as full widths against a
 * vertical semi-axis of 7, which made the coin half as wide as it was tall — a
 * gold capsule rather than a disc, and a three-quarter pose narrower than the
 * old edge-on frame.
 */
const SMALL_RX = [5.5, 3, 1, 3] as const
/**
 * WHICH END IS LIT, and it swaps as the face turns away and comes back — the
 * same cue the big coin gets from `COIN_LIT_LEFT`. Without it frames 1 and 3
 * are pixel-identical and the spin reads as a pulse rather than a rotation.
 */
const SMALL_LIT_TOP = [true, true, false, false] as const

function smallCoin(i: number, key: string): ReactElement {
  const rx = SMALL_RX[i]!
  const litTop = SMALL_LIT_TOP[i]!
  const out: ReactElement[] = []
  for (let y = 0; y < 16; y++) {
    const dy = (y - 7.5) / 5.5
    const span = 1 - dy * dy
    if (span <= 0) continue
    const w = Math.max(1, Math.round(2 * rx * Math.sqrt(span)))
    // centred on the same axis whatever the parity — rounding a half-pixel
    // centre made even and odd widths sit on different columns, so one edge
    // stepped in while the other stepped out
    const x = Math.round(8 - w / 2)
    const near = litTop ? y < 6 : y > 9
    const far = litTop ? y > 10 : y < 5
    const tone = i === 2 ? 'D' : near ? 'L' : far ? 'M' : 'G'
    out.push(<rect key={`${key}-${y}`} x={x} y={y} width={w} height={1} fill={SMALL[tone]} />)
  }
  return <>{out}</>
}

const COIN_SMALL_FRAMES = once(() => [0, 1, 2, 3].map((i) => smallCoin(i, `cs${i}`)))

/* ── reading a scorecard ─────────────────────────────────── */
/**
 * SCANNING — a bright line walks down the card, the way the CRT overlay walks
 * down the app. Loops for as long as the request takes, which is the point: it
 * is a progress indicator, not a celebration, and the wait is what it is for.
 *
 * BACK ON THE 16 GRID, and that is rule (2) applied rather than abandoned. It
 * renders at 32 CSS pixels — a button's busy state and a one-line banner — so on
 * a 32 grid every rim, rule and shadow was a single CSS pixel and the card came
 * out half as chunky as everything around it. At 16 it is two pixels an art
 * pixel, which is the app's idiom. The grid follows the RENDER SIZE; 32 is for
 * things that play at 64 and up.
 */
const CARD_RIM = '#08240f'
const CARD_EDGE = '#15803d'
const CARD_EDGE_LIT = '#22c55e'
const PAPER = '#f5f3ea'
const PAPER_SH = '#cfcabc'
const RULE = '#a9a394'
const SCAN_LINE = '#7dff66'
const SCAN_TRAIL = '#22c55e'

const SCAN_LEGEND: Record<string, string> = {
  o: CARD_RIM,
  E: CARD_EDGE,
  e: CARD_EDGE_LIT,
  P: PAPER,
  S: PAPER_SH,
  R: RULE,
  L: SCAN_LINE,
  T: SCAN_TRAIL,
}

function scanFrame(line: number): string[][] {
  const g: string[][] = Array.from({ length: 16 }, () => Array<string>(16).fill(' '))
  const put = (x: number, y: number, ch: string) => {
    if (x >= 0 && x < 16 && y >= 0 && y < 16) g[y]![x] = ch
  }
  for (let y = 1; y < 15; y++) for (let x = 2; x < 14; x++) put(x, y, 'E')
  for (let x = 2; x < 14; x++) put(x, 1, 'e')
  for (let y = 3; y < 14; y++) for (let x = 3; x < 13; x++) put(x, y, 'P')
  // a ruled grid — rows of holes, two columns of scores
  for (const y of [5, 8, 11]) for (let x = 3; x < 13; x++) put(x, y, 'R')
  for (let y = 3; y < 14; y++) put(8, y, 'R')
  for (let x = 3; x < 13; x++) put(x, 13, 'S')
  for (let y = 3; y < 14; y++) put(12, y, 'S')
  // the line, with a trail behind it — after the shadow, or it punches through
  for (let x = 3; x < 13; x++) {
    put(x, line, 'L')
    if (line > 3) put(x, line - 1, 'T')
  }
  const out = g.map((row) => [...row])
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (g[y]![x] !== ' ') continue
      const touching = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([ax, ay]) => {
        const a = x + ax
        const b = y + ay
        return a >= 0 && a < 16 && b >= 0 && b < 16 && g[b]![a] !== ' '
      })
      if (touching) out[y]![x] = 'o'
    }
  }
  return out
}

const SCAN_FRAMES = once(() =>
  [3, 5, 7, 9, 11, 13].map((y, i) => mergedRects(scanFrame(y), SCAN_LEGEND, `scan${i}`)),
)

/**
 * No labels live here: every sprite in the app today rides beside words that
 * already say the thing — "Reading scorecard…", "★ First tee ★", the
 * celebration's own text — so they are decorative, and a caller that needs an
 * announced one passes `label`. A label per sprite read as thorough and was
 * simply never used, which is worse than none.
 */
const SPRITES = {
  coin: { frames: COIN_FRAMES, w: 32, h: 32 },
  'coin-small': { frames: COIN_SMALL_FRAMES, w: 16, h: 16 },
  wolf: { frames: WOLF_SWING_FRAMES, w: SWING_SIZE, h: SWING_SIZE },
  'wolf-shades': { frames: WOLF_SHADES_SWING_FRAMES, w: SWING_SIZE, h: SWING_SIZE },
  logo: { frames: COURSE_LOGO_FRAMES, w: BANNER_W, h: BANNER_H, defs: courseBackdrop },
  'logo-idle': { frames: COURSE_IDLE_FRAMES, w: BANNER_W, h: BANNER_H, defs: courseBackdrop },
  'flag-plant': { frames: COURSE_FLAG_PLANT_FRAMES, w: BANNER_W, h: BANNER_H, defs: courseBackdrop },
  scan: { frames: SCAN_FRAMES, w: 16, h: 16 },
} as const satisfies Record<
  string,
  {
    frames: () => readonly ReactElement[]
    w: number
    h: number
    /** shared across every frame of the strip, drawn once — see `courseArt` */
    defs?: (name: string) => ReactElement
  }
>

export type SpriteName = keyof typeof SPRITES

/**
 * The grid a sprite is drawn on, for callers that have to place it. A layer
 * positioning a sprite needs its real size, and hardcoding 16 was safe only
 * while every sprite shared that grid — the wolf's swing is 32, and the next
 * one need not be either.
 */
export function spriteGrid(name: SpriteName): { w: number; h: number } {
  return { w: SPRITES[name].w, h: SPRITES[name].h }
}

/**
 * The integer scale that renders `name` closest to `px` across.
 *
 * Callers used to hardcode a scale, which silently meant a DIFFERENT size the
 * day a sprite was redrawn at higher fidelity — the coin going from 16 to 32
 * doubled every one of them at once. What a caller actually knows is how big it
 * wants the picture; the grid is the sprite's business.
 */
export function scaleFor(name: SpriteName, px: number): number {
  return Math.max(1, Math.round(px / SPRITES[name].w))
}

/** How many frames a sprite has — for a caller that has to wait one out. */
export function spriteFrames(name: SpriteName): number {
  return SPRITES[name].frames().length
}

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
  /** multiplier on the sprite's own grid — 4 renders a 16-grid sprite at 64px
   *  and a 32-grid one at 128px. Rounded to an integer; see below. */
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
  const entry: { frames: () => readonly ReactElement[]; w: number; h: number; defs?: (n: string) => ReactElement } =
    SPRITES[name]
  const { frames: build, w, h, defs } = entry
  const frames = build()
  const n = frames.length
  // INTEGER SCALE IS THE WHOLE IDIOM, so it is enforced rather than asked for.
  // A fractional scale makes crisp rects snap to DIFFERENT device-pixel widths
  // across the sprite — the coin comes out with one flat side — and the failure
  // is a slightly wrong picture, which nobody files a bug against. Rounded
  // rather than thrown: a celebration is not worth a white screen.
  const scaled = Math.max(1, Math.round(scale))
  const cellW = w * scaled
  const cellH = h * scaled

  // A LOOP runs all N frames and wraps, so it travels a full N cells and the
  // last frame gets its own slice of time before frame 0 comes back. A ONE-SHOT
  // must come to rest ON the final frame, so it travels N-1 cells in N-1 steps
  // and holds — travelling N would park the strip one cell past the art and
  // leave an empty box on screen.
  const steps = loop ? n : Math.max(1, n - 1)
  const travel = -cellW * steps

  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: cellW, height: cellH, overflow: 'hidden', display: 'inline-block' }}
    >
      <svg
        // ON THE ANIMATED ELEMENT, not the wrapper — `animation` does not
        // inherit, so the reduced-motion rule in `index.css` selects this and a
        // `data-sprite` one element up would silently match nothing while
        // looking exactly right. Same placement as `PixelGlyph`'s `data-glyph`.
        data-sprite={name}
        viewBox={`0 0 ${w * n} ${h}`}
        shapeRendering="crispEdges"
        focusable="false"
        style={{
          width: cellW * n,
          height: cellH,
          display: 'block',
          ['--sprite-travel' as string]: `${travel}px`,
          animationName: 'sprite-strip',
          animationDuration: `${frameMs * steps}ms`,
          animationTimingFunction: `steps(${steps})`,
          animationIterationCount: loop ? 'infinite' : 1,
          animationFillMode: 'forwards',
        }}
      >
        {defs && <defs>{defs(name)}</defs>}
        {frames.map((frame, i) => (
          <g key={i} transform={`translate(${i * w}, 0)`}>
            {frame}
          </g>
        ))}
      </svg>
    </span>
  )
}

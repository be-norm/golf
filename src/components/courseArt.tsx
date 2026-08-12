import type { ReactElement } from 'react'
import { once } from '../lib/once'

/**
 * THE COURSE — the app's own picture of itself, and the one drawing behind the
 * home screen's animated mark, the first-tee flourish and `public/icon.svg`.
 *
 * IT MATCHES THE SHIPPED ICON, which is the whole reason this file exists. The
 * icon set was redrawn (bright sky, clouds, a tree line, dithered turf, a cream
 * flagstick and a red pennant carrying a `$`) and the in-app art was not, so the
 * mark on your home screen and the mark at the top of the app were two different
 * logos. They are now one drawing with one palette; `docs/pixel-art.md` holds
 * the palette of record and where it was sampled from.
 *
 * 32 ON A SIDE, because these render at 64px and up — at 16 the same picture
 * reads flat, which is the difference the redraw is for. The scene is generated
 * where it is mechanical (sky bands, the dither, the green's ellipse and its
 * ring) and hand-placed where it is not (clouds, the tree line's ragged top, the
 * flag). Nothing here is a character sprite, so nothing carries an outline: a
 * scene owns its own background and gets depth from tone and dither instead.
 */

/**
 * THE HOME SCREEN'S MARK IS A BANNER, not the icon. The icon is square because
 * a home-screen tile is; the mark at the top of the app has a whole width to
 * fill, and a square there either crops or leaves the sides empty. Same scene,
 * same palette, wider frame — the green and the flag sit right, and the space
 * that buys on the left is what the approach shot flies through.
 *
 * 135 x 40 AT SCALE 4 IS 540 x 160 CSS PIXELS, and every one of those numbers
 * was chosen from the screen rather than the drawing.
 *
 * 540 wide because the number to beat is 532 — `max-w-md` against this app's
 * NINETEEN-pixel root, not the sixteen it would be anywhere else. Wider than the
 * container on every screen means the banner always fills the width and always
 * crops a little, instead of filling it on a small handset and leaving a gutter
 * on a large one. It cannot stretch to fit: a fluid width is a fractional scale
 * (`docs/pixel-art.md`, rule 1). What crops is fairway off the left and a rim of
 * green off the right, and the hole sits far enough inside to survive 375px.
 *
 * AND FOUR RATHER THAN FIVE, which is the whole reason for 135 and 40. The
 * banner had to hold a flag small enough not to shout and a `$` legible enough
 * to be a dollar, and at 32 rows those two wanted the same pixels: a dollar
 * needs its stem to OVERSHOOT the S — that is the difference between `$` and
 * the numeral 5 — and the two rows that costs left nothing for the cloth. More
 * art pixels at a smaller scale is the same picture size with finer grain, so
 * both the flag and the mark come down while the mark gains the rows it needed.
 */
export const BANNER_W = 135
export const BANNER_H = 40

/* ── palette, sampled from public/pwa-512x512.png ────────── */
const SKY_HIGH = '#1983f4'
const SKY_LOW = '#228dfa'
const CLOUD = '#f9f0d7'
const TREES = '#044a22'
const TREES_LIT = '#0a5f2b'
const TURF_LIGHT = '#77d217'
const TURF = '#5bbf17'
const TURF_DEEP = '#2a9c1c'
const GREEN = '#35a421'
const OUTLINE = '#112711'
const FLAG = '#ec0e12'
const FLAG_SHADE = '#71140c'

const LEGEND: Record<string, string> = {
  s: SKY_HIGH,
  S: SKY_LOW,
  c: CLOUD,
  t: TREES,
  T: TREES_LIT,
  L: TURF_LIGHT,
  G: TURF,
  g: TURF_DEEP,
  p: GREEN,
  o: OUTLINE,
  f: FLAG,
  d: FLAG_SHADE,
  k: CLOUD, // flagstick, ball and the dollar are all the same cream
}

type Grid = string[][]

/**
 * BOUNDS COME FROM THE GRID, not from a constant. They were a fixed 32 when
 * every frame was square, and the banner then drew its whole right-hand two
 * thirds — green, flag, cup — into a check that silently threw it away.
 */
function put(g: Grid, x: number, y: number, ch: string) {
  const px = Math.round(x)
  const py = Math.round(y)
  const row = g[py]
  if (row !== undefined && px >= 0 && px < row.length) row[px] = ch
}

function fill(g: Grid, x0: number, y0: number, w: number, h: number, ch: string) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(g, x, y, ch)
}

/** filled ellipse — the putting surface and the cup are both one */
function ellipse(g: Grid, cx: number, cy: number, rx: number, ry: number, ch: string) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1.04) put(g, x, y, ch)
    }
  }
}

/**
 * The horizon's ragged top, so the tree line reads as a mass rather than a bar.
 * A REPEATING PATTERN rather than a fixed-length table, because the same scene
 * is drawn 32 wide for the icon and 80 wide for the banner.
 */
const TREE_JITTER = [0, -1, -1, 0, -2, -1, 0, -1, -2, -2, -1, 0, -1, -2, -1, 0]
const treeTop = (x: number, horizon: number) => horizon + TREE_JITTER[x % TREE_JITTER.length]!

/**
 * Cloud puffs: x as a FRACTION of the width so they spread with the frame, y as
 * an explicit ROW. They were fractions of the horizon, and two fractions a
 * twentieth apart round to the same row on a thirteen-row sky — which flattened
 * four of the five two-row puffs into single bars.
 */
const CLOUDS: readonly (readonly [at: number, row: number, w: number])[] = [
  [0.06, 1, 5], [0.03, 2, 8],
  [0.66, 0, 4], [0.63, 1, 7],
  [0.20, 3, 3], [0.17, 4, 6],
  [0.84, 2, 4], [0.81, 3, 6],
  [0.40, 1, 3], [0.37, 2, 5],
]

/**
 * THE GROUND, from the horizon down. The dither is a fixed checker rather than
 * anything random: it has to be identical every render or the favicon and the
 * home screen disagree by a pixel, and a "random" texture regenerated per build
 * is a diff nobody can review.
 */
/**
 * THE GUST, as a diagonal band of brighter turf sweeping across. Grass does not
 * wave a blade at a time at this size — what reads as wind is a lighter streak
 * travelling over the field, which is how every 16-bit outdoor tileset did it.
 * `undefined` means still air, which is what the one-shot approach plays in.
 */
const GUST_PERIOD = 72
const GUST_WIDTH = 5

function ground(g: Grid, w: number, h: number, horizon: number, gust?: number) {
  for (let y = horizon - 2; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const top = treeTop(x, horizon)
      if (y < top) continue
      if (y <= top + 1) {
        // blocked like the turf's, and for the same reason — a per-pixel
        // pattern across the horizon is another few thousand unmergeable nodes
        put(g, x, y, (Math.floor(x / 3) + y) % 3 === 0 ? 'T' : 't')
        continue
      }
      // the turf lightens toward the viewer, with a checker over the top
      const near = (y - top) / (h - top)
      const base = near < 0.35 ? 'g' : 'G'
      // THREE BY THREE, not per pixel. A single-pixel checker is unmergeable in
      // both directions by construction, and the turf is nearly two thirds of
      // every frame — it alone put the home screen's strip past twenty thousand
      // rects. Coarser is also closer to the icon, whose dither blocks are
      // chunky at 512.
      const bx = Math.floor(x / 3)
      const by = Math.floor(y / 3)
      const lit = (bx + by) % 2 === 0 && (bx * 7 + by * 3) % 5 !== 0
      let ch = lit && near > 0.2 ? (base === 'G' ? 'L' : 'G') : base
      if (gust !== undefined) {
        const d = (((x + 2 * (y - top) - gust) % GUST_PERIOD) + GUST_PERIOD) % GUST_PERIOD
        if (d < GUST_WIDTH) ch = ch === 'g' ? 'G' : 'L'
      }
      put(g, x, y, ch)
    }
  }
}

/**
 * WHERE EVERYTHING SITS, for a frame of a given size. The square icon centres
 * the hole; the banner pushes it right and leaves the left two thirds as
 * fairway for a ball to come in over.
 */
interface Layout {
  w: number
  h: number
  horizon: number
  stickX: number
  cupY: number
  greenX: number
  greenRx: number
  greenRy: number
  flagTop: number
}

/** the icon's frame — square, because a home-screen tile is */
const SQUARE: Layout = {
  w: 32, h: 32, horizon: 13, stickX: 14, cupY: 24,
  greenX: 16, greenRx: 12.6, greenRy: 5.7, flagTop: 3,
}
const BANNER: Layout = {
  w: BANNER_W, h: BANNER_H, horizon: 14, stickX: 90, cupY: 26,
  greenX: 90, greenRx: 28, greenRy: 7, flagTop: 3,
}

function blankOf(l: Layout): Grid {
  return Array.from({ length: l.h }, () => Array<string>(l.w).fill('s'))
}

function scene(l: Layout, gust?: number): Grid {
  const g = blankOf(l)
  fill(g, 0, Math.round(l.horizon * 0.45), l.w, l.horizon, 'S')
  for (const [at, row, w] of CLOUDS) fill(g, Math.round(at * l.w), row, w, 1, 'c')
  ground(g, l.w, l.h, l.horizon, gust)
  ellipse(g, l.greenX, l.cupY + 2, l.greenRx + 1, l.greenRy + 0.8, 'o')
  ellipse(g, l.greenX, l.cupY + 2, l.greenRx, l.greenRy, 'p')
  ellipse(g, l.stickX, l.cupY, 2.4, 1.2, 'o')
  return g
}

/**
 * THE PENNANT, in two shapes. A flag's whole animation is its ripple, so the
 * two differ only in where the trailing point sits — and the `$` stays put,
 * because a three-pixel-wide glyph that moves is a three-pixel-wide smear.
 */
function flag(g: Grid, l: Layout, furled: boolean) {
  // A PENNANT, hung off the pole and coming to a point on the right. Widest in
  // the middle, not at the bottom — a flag that tapers downward reads as a
  // banner, and the icon's does not.
  // Nine rows deep, because the `$` needs five of them and has to sit INSIDE
  // the cloth — at six rows its stem fell off the bottom edge and left a cream
  // pixel floating in the sky.
  // ELEVEN ROWS on the finer grid, which is a SMALLER flag than the ten it
  // replaces — ten at scale 5 was 50 CSS pixels, eleven at scale 4 is 44 — and
  // it still has room for a dollar with stems.
  const shape: readonly (readonly [dy: number, w: number])[] = furled
    ? [[0, 5], [1, 9], [2, 12], [3, 14], [4, 15], [5, 15], [6, 14], [7, 12], [8, 9], [9, 6], [10, 3]]
    : [[0, 6], [1, 10], [2, 13], [3, 15], [4, 15], [5, 14], [6, 12], [7, 10], [8, 7], [9, 4], [10, 2]]
  const rows = shape.map(([dy, w]) => [l.flagTop + dy, w] as const)
  for (const [y, w] of rows) fill(g, l.stickX + 1, y, w, 1, 'f')
  // SHADOW IS AN EDGE, NOT A HALF. Flooding every row below the middle turned
  // the bottom of the flag into a dark slab; what the icon has is a dark
  // trailing point and a dark underside one pixel deep.
  const last = rows[rows.length - 1]!
  for (const [y, w] of rows) put(g, l.stickX + w, y, 'd')
  fill(g, l.stickX + 1, last[0], last[1], 1, 'd')
  for (const [y, w] of rows) if (y === last[0] - 1) fill(g, l.stickX + w - 1, y, 1, 1, 'd')

  // THE DOLLAR IT FLIES FOR. Five rows is the least an S can be drawn in, and
  // it has to actually be an S — a bar/stem/bar checker reads as a ladder,
  // which is what the first attempt put on the flag.
  // A DOLLAR IS AN S WITH A STEM THROUGH IT, and the stem has to come out the
  // other side. Without the overshoot the glyph is legibly the numeral 5 — which
  // is what a flag flew for one round of this — and thinning the S's arms to one
  // pixel breaks the stem and makes it worse. So it keeps its weight and gets
  // its two rows; the finer grid is what paid for them.
  const D = ['kkk', 'kk.', 'kkk', '.kk', 'kkk']
  //
  // IT HAS TO FIT INSIDE THE CLOTH, and checking that is the code's job rather
  // than mine: the pennant narrows toward the bottom, so a stem placed by eye
  // hung off the last row and left a cream pixel in the sky. Every mark is
  // tested against the row it lands on and dropped if the flag has run out.
  const onCloth = (x: number, y: number) => {
    const row = rows.find(([ry]) => ry === y)
    return row !== undefined && x > l.stickX && x <= l.stickX + row[1] - 1
  }
  const ink = (x: number, y: number) => {
    if (onCloth(x, y)) put(g, x, y, 'k')
  }
  //
  // A ROW HIGHER THAN CENTRE, deliberately. The pennant tapers, so its visual
  // mass is all in the top half; a mark centred on the cloth's rows sits low on
  // the shape you actually see.
  D.forEach((row, i) => {
    for (let x = 0; x < row.length; x++) if (row[x] === 'k') ink(l.stickX + 3 + x, l.flagTop + 2 + i)
  })
  ink(l.stickX + 4, l.flagTop + 1)
  ink(l.stickX + 4, l.flagTop + 7)
}

function stick(g: Grid, l: Layout, fromY: number) {
  fill(g, l.stickX, fromY, 1, l.cupY - fromY + 1, 'k')
}

/**
 * THE BALL IS THE ONE CHARACTER IN A SCENE, so it is the one thing here that
 * takes a rim (`docs/pixel-art.md`, rule 3). It flies over sky, cloud, tree
 * line, fairway and green in the space of one loop, and it is cream — the same
 * cream the clouds are, which is where it started its flight and where it
 * promptly disappeared.
 */
function ball(g: Grid, x: number, y: number) {
  // ROUNDED, NOT BOXED. A full ring around a two-pixel ball is half its radius
  // in outline, and it read as a dark tile with a white middle. Dropping the
  // four corners costs nothing and turns the same rim into a curve.
  for (const [i, j] of [
    [0, -1], [1, -1], [-1, 0], [2, 0], [-1, 1], [2, 1], [0, 2], [1, 2],
  ] as const) {
    put(g, x + i, y + j, 'o')
  }
  put(g, x, y, 'k')
  put(g, x + 1, y, 'k')
  put(g, x, y + 1, 'k')
  put(g, x + 1, y + 1, 'c')
}

/**
 * The grid to rects, merged in BOTH directions — greedily: widen, then deepen
 * while the whole span still matches.
 *
 * Row runs alone were the obvious thing and are not enough at this size. A
 * banner is 5,400 cells and there are twenty-eight frames of it; sky and turf
 * are vast flat fields that a row-at-a-time emitter re-states forty times over.
 * The output is identical pixels either way — this is purely how many nodes the
 * browser is asked to hold.
 */
function pixels(g: Grid, key: string): ReactElement {
  const h = g.length
  const w = g[0]!.length
  const taken = Array.from({ length: h }, () => Array<boolean>(w).fill(false))
  const out: ReactElement[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (taken[y]![x]) continue
      const ch = g[y]![x]!
      const paint = LEGEND[ch]
      if (paint === undefined) {
        taken[y]![x] = true
        continue
      }
      let rw = 1
      while (x + rw < w && !taken[y]![x + rw] && g[y]![x + rw] === ch) rw += 1
      let rh = 1
      grow: while (y + rh < h) {
        for (let i = 0; i < rw; i++) {
          if (taken[y + rh]![x + i] || g[y + rh]![x + i] !== ch) break grow
        }
        rh += 1
      }
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) taken[y + j]![x + i] = true
      out.push(
        <rect key={`${key}-${y}-${x}`} x={x} y={y} width={rw} height={rh} fill={paint} />,
      )
    }
  }
  return <>{out}</>
}

/**
 * THE APPROACH THAT GOES IN. The ball comes in high from the left, lands short,
 * bounces twice with the arc dying each time, releases onto the green and drops.
 * Then it is gone and the loop sends another one — which is the shot everybody
 * is actually here for.
 *
 * Hand-placed rather than simulated. A parabola computed from a gravity
 * constant looks correct and reads as nothing, because at this size what sells
 * a bounce is the SPACING — long, then short, then a roll — and those are three
 * numbers you choose, not one you derive.
 */
const APPROACH: readonly (readonly [x: number, y: number])[] = [
  [2, 6], [15, 11], [27, 16], [40, 21],
  [51, 25], // pitches on the fairway
  [61, 20], [70, 25], // and again, lower, onto the green
  [78, 22], [84, 25], // a last hop
  [87, 25], // running at it
]

export const COURSE_LOGO_FRAMES = once(() =>
  APPROACH.concat([[-1, -1]]).map(([x, y], i) => {
    // GUST 0, NOT STILL AIR. The wind strip opens on phase zero, so an intro
    // that ends in `undefined` hands over a turf that differs by a hundred-odd
    // cells — a lit band that pops into the grass at the instant of the swap.
    // Matching flag shapes across the handover was never the whole of it.
    const g = scene(BANNER, 0)
    stick(g, BANNER, BANNER.flagTop)
    flag(g, BANNER, i % 2 === 1)
    // the last frame has no ball: it is in the hole, which is the whole point.
    // Nothing else marks the moment — three white specks over the green was the
    // first attempt at a cheer and read as dirt on the screen.
    if (x >= 0) ball(g, x, y)
    return pixels(g, `logo${i}`)
  }),
)

/**
 * AFTER IT DROPS: the flag flaps and a gust crosses the grass, forever.
 *
 * A SECOND STRIP RATHER THAN A LONGER ONE, because the two halves have
 * different jobs. The approach happens ONCE — a ball that keeps holing out
 * every two seconds stops being a shot and becomes a metronome — and the wind
 * has to run for as long as anybody is looking at the screen. One strip can
 * loop or play once; it cannot do the first thing and then the second, so the
 * screen swaps sprites when the ball is down.
 *
 * The flag holds each shape for two frames: alternating every frame at this
 * rate is a flutter, and what is wanted is a flap. The gust's phase carries it
 * exactly one period across the strip whatever the frame count, so the loop has
 * no seam — and the count is as low as it can be while the gust still travels
 * smoothly, because every frame of a banner this size is thousands of nodes.
 */
const IDLE_FRAMES = 8

export const COURSE_IDLE_FRAMES = once(() => Array.from(
  { length: IDLE_FRAMES },
  (_, i) => {
    const g = scene(BANNER, i * (GUST_PERIOD / IDLE_FRAMES))
    stick(g, BANNER, BANNER.flagTop)
    // frame 0 wears the shape the approach's last frame left, so the swap from
    // one strip to the other has nothing to see
    flag(g, BANNER, i % 4 >= 2)
    return pixels(g, `idle${i}`)
  },
))

/**
 * FIRST TEE — the flag goes in. The stick drops from above and the pennant
 * unfurls behind it, which is the picture of a hole being made ready to play.
 *
 * THE SAME BANNER THE HOME SCREEN WEARS, and for the same reason it stopped
 * being a square there: this is a header across a column, not a tile. It plays
 * once and hands over to the wind, so the two screens differ in their CEREMONY
 * — a ball holing out, a flag going in — and agree on everything after it. An
 * approach shot on the FIRST tee would have been the wrong story told with the
 * right picture.
 */
export const COURSE_FLAG_PLANT_FRAMES = once(() =>
  [0, 1, 2, 3, 4].map((i) => {
  const l = BANNER
  const g = scene(l)
  if (i === 0) return pixels(g, `plant${i}`)
  if (i === 1) {
    // still falling, out of the top of the frame
    fill(g, l.stickX, 0, 1, Math.round(l.cupY * 0.5), 'k')
    return pixels(g, `plant${i}`)
  }
  stick(g, l, l.flagTop)
  if (i === 2) fill(g, l.stickX + 1, l.flagTop + 2, 3, 1, 'f')
  else flag(g, l, i === 3)
    // the last frame wears the shape AND the gust phase the wind strip opens
    // on, so the swap from the ceremony to the loop has nothing to see
    return pixels(g, `plant${i}`)
  }),
)

/**
 * `public/icon.svg`, AS A STRING, from this same drawing.
 *
 * The favicon and the in-app mark are one picture and have drifted before —
 * the PNG icon set was redrawn and neither of the other two moved, which is how
 * the home screen ended up showing a different logo from the one on your home
 * screen. A comment saying "change both" was the previous arrangement and it is
 * what failed, so the SVG is GENERATED from the frames and a test holds the
 * committed file to it.
 *
 * Regenerating: the test prints this string when it disagrees; paste it in.
 */
export function courseIconSvg(): string {
  const g = scene(SQUARE)
  stick(g, SQUARE, SQUARE.flagTop)
  flag(g, SQUARE, false)
  const out: string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">',
    '  <!-- GENERATED from src/components/courseArt.tsx — see courseIconSvg() -->',
  ]
  g.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x]!
      const paint = LEGEND[ch]
      if (paint === undefined) {
        x += 1
        continue
      }
      let w = 1
      while (row[x + w] === ch) w += 1
      out.push(`  <rect x="${x}" y="${y}" width="${w}" height="1" fill="${paint}"/>`)
      x += w
    }
  })
  out.push('</svg>')
  return out.join('\n') + '\n'
}

export { LEGEND as COURSE_LEGEND }

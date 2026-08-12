import type { ReactElement } from 'react'

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

export const COURSE_SIZE = 32

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
const SPARK = '#f9f0d7' // cream: the burst lands on bright turf, not dark sky

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
  '*': SPARK,
}

type Grid = string[][]

const blank = (): Grid =>
  Array.from({ length: COURSE_SIZE }, () => Array<string>(COURSE_SIZE).fill('s'))

const inside = (x: number, y: number) =>
  x >= 0 && x < COURSE_SIZE && y >= 0 && y < COURSE_SIZE

function put(g: Grid, x: number, y: number, ch: string) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (inside(px, py)) g[py]![px] = ch
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

/** the horizon's ragged top, so the tree line reads as a mass rather than a bar */
const TREE_TOP = [13, 12, 12, 13, 11, 12, 13, 12, 11, 11, 12, 13, 12, 11, 12, 13,
  12, 12, 11, 12, 13, 12, 11, 12, 12, 13, 12, 11, 12, 13, 12, 12]

/** cloud blobs: [x, y, width] rows, stacked into puffs */
const CLOUDS: readonly (readonly [x: number, y: number, w: number])[] = [
  [2, 4, 5], [1, 5, 8], [3, 3, 3],
  [21, 2, 4], [20, 3, 7], [23, 1, 2],
  [6, 8, 3], [5, 9, 6],
  [26, 7, 4], [25, 8, 6],
]

/**
 * THE GROUND, from the horizon down. The dither is a fixed checker rather than
 * anything random: it has to be identical every render or the favicon and the
 * home screen disagree by a pixel, and a "random" texture regenerated per build
 * is a diff nobody can review.
 */
function ground(g: Grid) {
  for (let y = 11; y < COURSE_SIZE; y++) {
    for (let x = 0; x < COURSE_SIZE; x++) {
      if (y < TREE_TOP[x]!) continue
      if (y <= TREE_TOP[x]! + 1) {
        put(g, x, y, (x + y) % 3 === 0 ? 'T' : 't')
        continue
      }
      // the turf lightens toward the viewer, with a checker over the top
      const base = y < 19 ? 'g' : 'G'
      const lit = (x + y) % 2 === 0 && (x * 7 + y * 3) % 5 !== 0
      put(g, x, y, lit && y > 15 ? (base === 'G' ? 'L' : 'G') : base)
    }
  }
}

/** the putting surface: a flatter, darker green ringed in near-black */
function green(g: Grid) {
  ellipse(g, 16, 26, 12.6, 5.7, 'o')
  ellipse(g, 16, 26, 11.6, 4.9, 'p')
}

const STICK_X = 14
const CUP_Y = 24

function scene(): Grid {
  const g = blank()
  fill(g, 0, 6, COURSE_SIZE, 8, 'S')
  for (const [x, y, w] of CLOUDS) fill(g, x, y, w, 1, 'c')
  ground(g)
  green(g)
  ellipse(g, STICK_X, CUP_Y, 2.4, 1.2, 'o')
  return g
}

/**
 * THE PENNANT, in two shapes. A flag's whole animation is its ripple, so the
 * two differ only in where the trailing point sits — and the `$` stays put,
 * because a three-pixel-wide glyph that moves is a three-pixel-wide smear.
 */
function flag(g: Grid, furled: boolean) {
  // A PENNANT, hung off the pole and coming to a point on the right. Widest in
  // the middle, not at the bottom — a flag that tapers downward reads as a
  // banner, and the icon's does not.
  // Nine rows deep, because the `$` needs five of them and has to sit INSIDE
  // the cloth — at six rows its stem fell off the bottom edge and left a cream
  // pixel floating in the sky.
  const rows: readonly (readonly [y: number, w: number])[] = furled
    ? [[3, 6], [4, 9], [5, 11], [6, 12], [7, 12], [8, 10], [9, 7], [10, 4]]
    : [[3, 7], [4, 10], [5, 12], [6, 12], [7, 11], [8, 9], [9, 6], [10, 3]]
  for (const [y, w] of rows) fill(g, STICK_X + 1, y, w, 1, 'f')
  // SHADOW IS AN EDGE, NOT A HALF. Flooding every row below the middle turned
  // the bottom of the flag into a dark slab; what the icon has is a dark
  // trailing point and a dark underside one pixel deep.
  const last = rows[rows.length - 1]!
  for (const [y, w] of rows) put(g, STICK_X + w, y, 'd')
  fill(g, STICK_X + 1, last[0], last[1], 1, 'd')
  for (const [y, w] of rows) if (y === last[0] - 1) fill(g, STICK_X + w - 1, y, 1, 1, 'd')

  // THE DOLLAR IT FLIES FOR. Five rows is the least an S can be drawn in, and
  // it has to actually be an S — a bar/stem/bar checker reads as a ladder,
  // which is what the first attempt put on the flag.
  const D = ['kkk', 'kk.', 'kkk', '.kk', 'kkk']
  D.forEach((row, i) => {
    for (let x = 0; x < row.length; x++) if (row[x] === 'k') put(g, STICK_X + 3 + x, 5 + i, 'k')
  })
  put(g, STICK_X + 4, 4, 'k')
  put(g, STICK_X + 4, 10, 'k')
}

function stick(g: Grid, fromY: number) {
  fill(g, STICK_X, fromY, 1, CUP_Y - fromY + 1, 'k')
}

function ball(g: Grid, x: number) {
  put(g, x, 22, 'k')
  put(g, x + 1, 22, 'k')
  put(g, x, 23, 'k')
  put(g, x + 1, 23, 'c')
}

function pixels(g: Grid, key: string): ReactElement {
  const out: ReactElement[] = []
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
      out.push(<rect key={`${key}-${y}-${x}`} x={x} y={y} width={w} height={1} fill={paint} />)
      x += w
    }
  })
  return <>{out}</>
}

/** The ball finds the cup, the flag ripples the whole way. Five frames. */
export const COURSE_LOGO_FRAMES: readonly ReactElement[] = [0, 1, 2, 3, 4].map((i) => {
  const g = scene()
  stick(g, 4)
  flag(g, i % 2 === 1)
  if (i < 4) ball(g, 6 + i * 3)
  else {
    put(g, 12, 20, '*')
    put(g, 20, 19, '*')
    put(g, 16, 17, '*')
  }
  return pixels(g, `logo${i}`)
})

/**
 * FIRST TEE — the flag goes in. The stick drops from above and the pennant
 * unfurls behind it, which is the picture of a hole being made ready to play.
 */
export const COURSE_FLAG_PLANT_FRAMES: readonly ReactElement[] = [0, 1, 2, 3, 4].map((i) => {
  const g = scene()
  if (i === 0) return pixels(g, `plant${i}`)
  if (i === 1) {
    fill(g, STICK_X, 0, 1, 10, 'k')
    return pixels(g, `plant${i}`)
  }
  stick(g, 4)
  if (i === 2) fill(g, STICK_X + 1, 5, 3, 1, 'f')
  else flag(g, i === 3)
  if (i === 4) {
    put(g, 8, 12, '*')
    put(g, 26, 15, '*')
  }
  return pixels(g, `plant${i}`)
})

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
  const g = scene()
  stick(g, 4)
  flag(g, false)
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

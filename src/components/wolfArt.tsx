import type { ReactElement } from 'react'

/**
 * THE WOLF, DRAWN — both of him. `PixelGlyph` renders the still head that marks
 * whose tee it is; `PixelSprite` plays the swing that celebrates a hole somebody
 * took alone. They are two pictures of one animal, so they live in one file and
 * share one palette: the fur, the gold eye and the black lens have to match, or
 * the mark in the ledger and the wolf on the coins read as different wolves.
 *
 * Both are 16×16 `shape-rendering="crispEdges"` rects on the integer grid, in
 * the idiom `public/icon.svg` set.
 *
 * THE SWING IS AUTHORED AS A PICTURE, not as a list of rects. Seven frames of a
 * wolf, a club and a ball is more art than a wall of coordinates can hold in a
 * reader's head — the first version of this file was tuples, and re-shaping an
 * ear meant counting. `pixels()` takes character maps and collapses horizontal
 * runs into the same rects everything else emits, so the source stays something
 * you can look at and the output is unchanged.
 */

export const FUR = '#a8a29e'
export const FUR_DARK = '#57534e'
export const MUZZLE = '#d6d3d1'
export const INK = '#1c1917'
export const EYE = '#ffd23e'
export const LENS = '#0c0a09'
export const GLINT = '#f5f5f4'
/** club shaft and ball, borrowed from the icon's own palette */
const STICK = '#e7e5e4'
const BALL = '#fafaf9'
const BALL_LIT = '#ffffff'
const SPARK = '#7dff66' // felt-300, the same green the logo's putt bursts with

/* ── the still head, for the glyph ───────────────────────── */

/** The head every variant shares — ears, taper, muzzle. Eyes are the variable. */
export function wolfHead(eyes: ReactElement) {
  return (
    <>
      {/* ear tips */}
      <rect x="2" y="1" width="2" height="1" fill={FUR} />
      <rect x="12" y="1" width="2" height="1" fill={FUR} />
      <rect x="1" y="2" width="4" height="1" fill={FUR} />
      <rect x="11" y="2" width="4" height="1" fill={FUR} />
      <rect x="1" y="3" width="5" height="1" fill={FUR} />
      <rect x="10" y="3" width="5" height="1" fill={FUR} />
      {/* inner ear */}
      <rect x="2" y="2" width="2" height="2" fill={FUR_DARK} />
      <rect x="12" y="2" width="2" height="2" fill={FUR_DARK} />
      {/* skull, then the taper down to the snout */}
      <rect x="1" y="4" width="14" height="4" fill={FUR} />
      <rect x="2" y="8" width="12" height="2" fill={FUR} />
      <rect x="3" y="10" width="10" height="1" fill={FUR} />
      <rect x="4" y="11" width="8" height="1" fill={FUR} />
      <rect x="5" y="12" width="6" height="1" fill={FUR} />
      <rect x="6" y="13" width="4" height="1" fill={FUR} />
      {eyes}
      {/* muzzle + nose */}
      <rect x="6" y="11" width="4" height="2" fill={MUZZLE} />
      <rect x="7" y="12" width="2" height="1" fill={INK} />
    </>
  )
}

export const WOLF_EYES = (
  <>
    <rect x="4" y="6" width="2" height="2" fill={EYE} />
    <rect x="10" y="6" width="2" height="2" fill={EYE} />
  </>
)

/**
 * Two lenses JOINED BY A BRIDGE, with the temple arms reaching for the ears.
 * The connection is what makes it read as one object worn on the face rather
 * than as dark eyes — and the lenses stay INSET, with fur on all four sides.
 * A band spanning the full head width was the first attempt, and since the
 * lens colour is near the page's, it cut the head in half: ears floating
 * above a muzzle.
 */
export const SHADES_EYES = (
  <>
    <rect x="3" y="6" width="4" height="2" fill={LENS} />
    <rect x="9" y="6" width="4" height="2" fill={LENS} />
    <rect x="7" y="6" width="2" height="1" fill={LENS} />
    <rect x="2" y="6" width="1" height="1" fill={LENS} />
    <rect x="13" y="6" width="1" height="1" fill={LENS} />
    <rect x="3" y="6" width="1" height="1" fill={GLINT} />
    <rect x="9" y="6" width="1" height="1" fill={GLINT} />
  </>
)

/* ── the swing, for the sprite ───────────────────────────── */

/**
 * WHAT WINNING A HOLE ALONE LOOKS LIKE: the wolf turns on it and the ball comes
 * straight at you, growing until it fills the frame.
 *
 * The whole animal, not the head mark — a swing needs somebody to make it, and
 * a floating club under a portrait reads as nothing at all (that was the first
 * attempt). Seven frames is one swing at the house frame rate, which is very
 * nearly the length of the flight the celebration layer gives it, so it plays
 * through about once on the way to the winner's row.
 *
 * THE HEAD IS SIZED BY THE SHADES. Blind Wolf is the difference between this
 * sprite and its twin, so the eye band has to survive at 16px: seven pixels of
 * skull gives a five-pixel bar, which is twenty screen pixels at the scale the
 * layer renders. Shrink the wolf any further and the two celebrations become
 * the same picture.
 *
 * THE BALL IS PAINTED LAST because it is the nearest thing to the camera, and
 * it is allowed to swallow the wolf: by the last frame only his ears and feet
 * are left. That is the point of the shot.
 */
const WOLF_BODY = [
  '................',
  '.F.....F........',
  '.FD...DF........',
  '.FFFFFFF........',
  '.FeeseeF........',
  '.FFFFFFFM.......',
  'F.FFFFF.........',
  'FFFFFFF.........',
  'F.FFFFFF........',
  '..FFFFFF........',
  '..FFFFF.........',
  '..FF.FF.........',
  '..FF.FF.........',
  '..F...F.........',
  '.FFF.FFF........',
  '................',
] as const

interface SwingFrame {
  /** weight transfer: the wolf steps a pixel into the ball at contact */
  lean: number
  /** the reaching arm, drawn as fur so it joins the body to the grip */
  arm: readonly (readonly [x: number, y: number])[]
  shaft: readonly (readonly [x: number, y: number])[]
  /** top-left of the 2×2 club head, or null once the ball has swallowed it */
  club: readonly [x: number, y: number] | null
  /** top-left and diameter; anything 4 wide or more is masked to a circle */
  ball: readonly [x: number, y: number, size: number]
  spark: readonly (readonly [x: number, y: number])[]
}

const SWING: readonly SwingFrame[] = [
  // top of the backswing — club up and behind, ball waiting on the deck
  { lean: 0, arm: [[8, 8]], shaft: [[9, 7], [10, 6], [11, 5]], club: [12, 3], ball: [11, 13, 2], spark: [] },
  // coming down
  { lean: 0, arm: [[8, 8]], shaft: [[9, 8], [10, 9], [11, 10]], club: [12, 11], ball: [11, 13, 2], spark: [] },
  // contact: he steps into it and the turf goes with it
  { lean: 1, arm: [[8, 9]], shaft: [[9, 10], [10, 11]], club: [11, 12], ball: [11, 13, 2], spark: [[13, 12], [14, 14]] },
  // gone — and from here every frame is the ball getting closer
  { lean: 1, arm: [[8, 10]], shaft: [[11, 11], [12, 10]], club: [13, 8], ball: [9, 10, 3], spark: [[13, 13], [14, 15]] },
  { lean: 1, arm: [[8, 11]], shaft: [[12, 9], [13, 8]], club: [14, 6], ball: [7, 8, 5], spark: [] },
  { lean: 1, arm: [], shaft: [], club: [14, 5], ball: [5, 6, 8], spark: [] },
  { lean: 1, arm: [], shaft: [], club: null, ball: [2, 3, 12], spark: [] },
]

const LEGEND: Record<string, string> = {
  F: FUR,
  D: FUR_DARK,
  M: MUZZLE,
  E: EYE,
  L: LENS,
  G: GLINT,
  C: STICK,
  B: BALL,
  W: BALL_LIT,
  S: MUZZLE, // the ball's shaded side and its dimples
  '*': SPARK,
}

/**
 * A character map to rects, collapsing horizontal runs. One rect per run keeps
 * the output the same shape as the hand-written art elsewhere in the house
 * idiom, and every value is on the integer grid by construction.
 */
function pixels(rows: readonly string[], key: string): ReactElement {
  const out: ReactElement[] = []
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x]!
      const fill = LEGEND[ch]
      if (fill === undefined) {
        x += 1
        continue
      }
      let w = 1
      while (row[x + w] === ch) w += 1
      out.push(<rect key={`${key}-${y}-${x}`} x={x} y={y} width={w} height={1} fill={fill} />)
      x += w
    }
  })
  return <>{out}</>
}

function swingFrame(f: SwingFrame, blind: boolean, key: string): ReactElement {
  const g: string[][] = Array.from({ length: 16 }, () => Array<string>(16).fill('.'))
  const put = (x: number, y: number, ch: string) => {
    if (x >= 0 && x < 16 && y >= 0 && y < 16) g[y]![x] = ch
  }

  // the wolf, leaned — `e` is the eye and `s` the bridge between the two, so
  // one drawing gives both sprites: gold eyes with fur between them, or one
  // unbroken lens across all five pixels
  WOLF_BODY.forEach((row, y) => {
    for (let x = 0; x < 16; x++) {
      const ch = row[x]!
      if (ch === '.') continue
      put(x + f.lean, y, ch === 'e' ? (blind ? 'L' : 'E') : ch === 's' ? (blind ? 'L' : 'F') : ch)
    }
  })
  if (blind) put(2 + f.lean, 4, 'G')

  for (const [x, y] of f.arm) put(x, y, 'F')
  for (const [x, y] of f.shaft) put(x, y, 'C')
  if (f.club) {
    const [cx, cy] = f.club
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) put(cx + i, cy + j, 'C')
  }
  for (const [x, y] of f.spark) put(x, y, '*')

  const [bx, by, n] = f.ball
  const r = (n - 1) / 2
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // masked to a circle from 4px up; below that a square IS the circle
      if (n >= 4 && Math.hypot(i - r, j - r) > r + 0.35) continue
      put(bx + i, by + j, 'B')
    }
  }
  if (n >= 4) {
    put(bx + 1, by + 1, 'W')
    put(bx + 2, by + 1, 'W')
    put(bx + 1, by + 2, 'W')
    put(bx + n - 2, by + n - 2, 'S')
    put(bx + n - 3, by + n - 2, 'S')
    put(bx + n - 2, by + n - 3, 'S')
    // two dimples, so it reads as a golf ball rather than a moon
    put(bx + n - 3, by + 2, 'S')
    put(bx + 2, by + n - 3, 'S')
  } else {
    put(bx, by, 'W')
  }

  return pixels(g.map((row) => row.join('')), key)
}

export const WOLF_SWING_FRAMES: readonly ReactElement[] = SWING.map((f, i) =>
  swingFrame(f, false, `w${i}`),
)
export const WOLF_SHADES_SWING_FRAMES: readonly ReactElement[] = SWING.map((f, i) =>
  swingFrame(f, true, `b${i}`),
)

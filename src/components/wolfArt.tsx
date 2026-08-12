import type { ReactElement } from 'react'

/**
 * THE WOLF, DRAWN — both of him. `PixelGlyph` renders the still head that marks
 * whose tee it is; `PixelSprite` plays the swing that celebrates a hole somebody
 * took alone. They are two pictures of one animal, so they live in one file and
 * share one palette: the fur, the gold eye and the black lens have to match, or
 * the mark in the ledger and the wolf on the coins read as different wolves.
 *
 * THE TWO ARE DRAWN AT DIFFERENT RESOLUTIONS ON PURPOSE. The glyph is 16×16
 * because it sits inline in a sentence at 16 CSS pixels, where one art pixel is
 * one screen pixel and detail would just be mud. The swing is 32×32 because it
 * plays centre screen at five times that, where 16×16 reads as flat and cheap —
 * the SNES-era answer to exactly this problem, and the reason for the three fur
 * tones and the one-pixel dark outline below rather than the flat two-tone
 * silhouette this started as.
 */

/* ── palette ─────────────────────────────────────────────── */
export const FUR = '#a8a29e'
export const FUR_DARK = '#57534e'
export const MUZZLE = '#d6d3d1'
export const INK = '#1c1917'
export const EYE = '#ffd23e'
export const LENS = '#0c0a09'
export const GLINT = '#f5f5f4'

/**
 * The swing's extra tones. Shadows shift COOL rather than simply darkening,
 * which is the difference between fur and grey paint.
 */
const OUTLINE = '#100c14'
const FUR_HI = '#e8e2dc'
const FUR_SH = '#6a6470'
const GLOVE = '#fafafa'
const CLUB = '#d4d4d8'
const CLUB_HEAD = '#a1a1aa'
/**
 * THE BALL IS COOL AND THE WOLF IS WARM, which is the only reason a white ball
 * reads against grey fur at all. Matched in value they vanish into each other
 * the moment they overlap — and they overlap for four frames out of seven,
 * which is the whole second half of the animation.
 */
const BALL = '#eef1f7'
const BALL_HI = '#ffffff'
const BALL_SH = '#9aa3b8'
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

/* ── the swing ───────────────────────────────────────────── */

export const SWING_SIZE = 32

/**
 * THE WOLF IN PROFILE, ADDRESSING THE BALL. Silhouette only — the tones are
 * applied below, because edge-shading a shape is mechanical work and doing it
 * by hand across a figure this size is how a highlight ends up one pixel out on
 * one row and nowhere else.
 *
 * `e` is the eye, `n` the nose, `i` the inside of an ear. Everything else is
 * body. Drawn inside a one-pixel margin so the outline pass has somewhere to go.
 */
const WOLF_FIGURE = [
  '                                ',
  '                                ',
  '   #      ##                    ',
  '   ##    #ii#                   ',
  '  #ii#  #iii#                   ',
  '  ###########                   ',
  '  ##ee########                  ',
  '  ###############               ',
  '   ################n            ',
  '    ##############              ',
  '     ##########                 ',
  '      ########                  ',
  '     #########                  ',
  '  #  #########                  ',
  ' ### ##########                 ',
  ' ###############                ',
  '  ##############                ',
  '  #############                 ',
  '  #############                 ',
  '  #############                 ',
  '   ############                 ',
  '   ###########                  ',
  '   ####  ######                 ',
  '   ####  ######                 ',
  '   ####   #####                 ',
  '  #####   #####                 ',
  '  ####    #####                 ',
  '  ####    #####                 ',
  ' ######  #######                ',
  ' ######  #######                ',
  '                                ',
  '                                ',
] as const

/** where the shades sit in profile: one bar across the eye, back to the ear */
const SHADES_BAR: readonly (readonly [x: number, y: number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
  [8, 6],
  [9, 6],
  [3, 5],
]
const SHADES_GLINT: readonly [x: number, y: number] = [8, 6]

/**
 * THE SWING, AS A LEVER. The shoulder is a pivot, the club head travels an arc
 * around it, and the hands sit part-way out — so the arms and the shaft are
 * DRAWN, not authored, and the pose cannot forget a limb the way a hand-drawn
 * frame can.
 *
 * TWO HANDS STACK ALONG THE SHAFT. They do not sit side by side, and that is
 * the whole reason this reads as a golf grip rather than as a wolf holding a
 * stick. Drawing both arms to a single point produced one limb every time —
 * in true profile the near arm simply covers the far one, and no amount of
 * separating the SHOULDERS fixes it, because the two lines still converge.
 * They now terminate at two different points, one up the shaft and one down it,
 * about three pixels apart: the far arm takes the top hand, the near arm the
 * bottom, and the shaft passes between them exactly as a real grip does.
 *
 * `GRIP_ALONG` is where that pair sits on the lever. Two thirds out, because the
 * arms are longer than the club is — put the hands halfway and they end up
 * inside the wolf's own chest on every frame.
 */
const PIVOT: readonly [x: number, y: number] = [15, 14]
/**
 * NEAR AND FAR SHOULDER, pulled deliberately apart. Anatomically they sit
 * almost on top of each other in profile, and drawn that way the two arms
 * converge into a single limb about four pixels along — which is a one-armed
 * golfer again, by a different route. Spreading them is the standard sprite
 * cheat: the far arm emerges high and behind, the near one low and forward,
 * and the internal edge between them is what makes the pair legible.
 */
const NEAR_SHOULDER: readonly [x: number, y: number] = [15, 17]
const FAR_SHOULDER: readonly [x: number, y: number] = [12, 12]
const GRIP_ALONG = 0.62
/**
 * How far apart the two hands sit along the shaft — adjacent, as a real grip
 * is. They still read as two because each is stamped on its own layer and the
 * second one's outline cuts a dark seam between them; sharing a layer merged
 * them into a single mitten, which is what "swinging one-handed" looked like.
 */
const HAND_GAP = 1.4
/**
 * How far the butt of the club stands proud of the top hand. Comfortably more
 * than the hands are apart, or the shaft starts inside the grip and there is
 * no club butt at all.
 */
const BUTT = 4.2

interface SwingFrame {
  /** where the club head is, in art pixels */
  club: readonly [x: number, y: number]
  /** top-left and diameter of the ball, masked to a circle */
  ball: readonly [x: number, y: number, size: number]
  spark: readonly (readonly [x: number, y: number])[]
}

/**
 * ADDRESS, TOP, IMPACT, then four frames of the ball on its way to you — the
 * order every golf game since the 8-bit ones has used, because it is the fewest
 * poses that still read as a swing.
 *
 * Address FIRST rather than starting at the top of the backswing, for two
 * reasons. It is the pose that says "a wolf is about to hit a golf ball" with no
 * motion at all, and frame 0 is exactly what a reduced-motion viewer is left
 * looking at. And a backswing opening frame put the hands behind the head on the
 * very first thing you see, which is the one pose in the swing where the arms
 * are least legible.
 *
 * The club head keeps roughly the same distance from the pivot throughout — it
 * is one lever swinging, and a shaft that grows and shrinks reads as elastic.
 */
const SWING: readonly SwingFrame[] = [
  { club: [21, 28], ball: [22, 28, 2], spark: [] },
  { club: [3, 3], ball: [22, 28, 2], spark: [] },
  { club: [21, 28], ball: [22, 28, 2], spark: [[25, 26], [26, 29], [25, 31]] },
  { club: [27, 21], ball: [20, 24, 4], spark: [[25, 27], [28, 30]] },
  { club: [28, 8], ball: [16, 18, 8], spark: [] },
  { club: [20, 1], ball: [8, 11, 14], spark: [] },
  { club: [12, 1], ball: [5, 9, 20], spark: [] },
]

type Grid = string[][]

const blank = (): Grid =>
  Array.from({ length: SWING_SIZE }, () => Array<string>(SWING_SIZE).fill(' '))

const inside = (x: number, y: number) =>
  x >= 0 && x < SWING_SIZE && y >= 0 && y < SWING_SIZE

function put(g: Grid, x: number, y: number, ch: string) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (inside(px, py)) g[py]![px] = ch
}

/** Bresenham, optionally widened — a limb is thicker than a hairline. */
function stroke(
  g: Grid,
  [x0, y0]: readonly [number, number],
  [x1, y1]: readonly [number, number],
  ch: string,
  width = 1,
) {
  let x = Math.round(x0)
  let y = Math.round(y0)
  const ex = Math.round(x1)
  const ey = Math.round(y1)
  const dx = Math.abs(ex - x)
  const dy = Math.abs(ey - y)
  const sx = x < ex ? 1 : -1
  const sy = y < ey ? 1 : -1
  let err = dx - dy
  for (;;) {
    put(g, x, y, ch)
    if (width > 1) put(g, x + 1, y, ch)
    if (width > 2) put(g, x, y + 1, ch)
    if (x === ex && y === ey) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
}

function disc(g: Grid, cx: number, cy: number, r: number, ch: string) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if (Math.hypot(x - cx, y - cy) <= r + 0.35) put(g, x, y, ch)
    }
  }
}

/**
 * A ONE-PIXEL DARK EDGE, which is the single largest difference between a
 * sprite that reads and one that doesn't. Two passes exist for a reason:
 *
 * `edge` runs against EMPTY SPACE and gives the whole figure its silhouette.
 * `edgeAgainst` runs a layer against WHATEVER IS UNDER IT, which is how the
 * arms stay legible where they cross the wolf's own chest — at the top of the
 * backswing the hands really are behind the head, and without an internal edge
 * the limbs dissolve into the body exactly when the pose is hardest to read.
 */
function edge(g: Grid, ch: string): Grid {
  const out = g.map((row) => [...row])
  for (let y = 0; y < SWING_SIZE; y++) {
    for (let x = 0; x < SWING_SIZE; x++) {
      if (g[y]![x] !== ' ') continue
      const touching = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => {
        const a = x + dx
        const b = y + dy
        return inside(a, b) && g[b]![a] !== ' ' && g[b]![a] !== ch
      })
      if (touching) out[y]![x] = ch
    }
  }
  return out
}

/** Stamp `layer` onto `base`, drawing a dark edge wherever it overlaps. */
function stampWithEdge(base: Grid, layer: Grid, ch: string) {
  for (let y = 0; y < SWING_SIZE; y++) {
    for (let x = 0; x < SWING_SIZE; x++) {
      if (layer[y]![x] !== ' ') continue
      const touching = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => {
        const a = x + dx
        const b = y + dy
        return inside(a, b) && layer[b]![a] !== ' '
      })
      if (touching) base[y]![x] = ch
    }
  }
  for (let y = 0; y < SWING_SIZE; y++) {
    for (let x = 0; x < SWING_SIZE; x++) {
      const ch2 = layer[y]![x]!
      if (ch2 !== ' ') base[y]![x] = ch2
    }
  }
}

/**
 * ROUNDING THE FIGURE OFF: light along the top edge, cool shadow along the
 * bottom. Derived from the silhouette rather than painted by hand, so it can't
 * drift out of register with the shape it is shading.
 */
function shade(g: Grid) {
  const solid = g.map((row) => row.map((ch) => ch === 'F'))
  for (let y = 0; y < SWING_SIZE; y++) {
    for (let x = 0; x < SWING_SIZE; x++) {
      if (!solid[y]![x]) continue
      const above = y > 0 && solid[y - 1]![x]
      const below = y < SWING_SIZE - 1 && solid[y + 1]![x]
      if (!above) g[y]![x] = 'H'
      else if (!below) g[y]![x] = 'S'
    }
  }
}

function swingFrame(f: SwingFrame, blind: boolean): Grid {
  const g = blank()

  WOLF_FIGURE.forEach((row, y) => {
    for (let x = 0; x < SWING_SIZE; x++) {
      const ch = row[x]!
      if (ch === '#') put(g, x, y, 'F')
      else if (ch === 'i') put(g, x, y, 'D')
      else if (ch === 'n') put(g, x, y, 'N')
      else if (ch === 'e') put(g, x, y, blind ? ' ' : 'E')
    }
  })
  shade(g)
  // the eye and the ear linings survive shading; re-stamp them
  WOLF_FIGURE.forEach((row, y) => {
    for (let x = 0; x < SWING_SIZE; x++) {
      const ch = row[x]!
      if (ch === 'i') put(g, x, y, 'D')
      else if (ch === 'n') put(g, x, y, 'N')
      else if (ch === 'e' && !blind) put(g, x, y, 'E')
    }
  })
  if (blind) {
    for (const [x, y] of SHADES_BAR) put(g, x, y, 'L')
    put(g, SHADES_GLINT[0], SHADES_GLINT[1], 'G')
  }

  // arms, hands and club go on their own layer so they can be edged against
  // the body they cross
  //
  // FOUR LAYERS, BACK TO FRONT, each edged as it lands: far arm, club, near arm
  // with the hands, then the ball. One layer for all of them was the first
  // attempt and it put the near arm straight on top of the far one — two arms
  // drawn, one arm visible, which is the exact complaint this redraw is for.
  const reach = [f.club[0] - PIVOT[0], f.club[1] - PIVOT[1]] as const
  const len = Math.hypot(reach[0], reach[1])
  const dir = [reach[0] / len, reach[1] / len] as const
  const grip = [PIVOT[0] + GRIP_ALONG * reach[0], PIVOT[1] + GRIP_ALONG * reach[1]] as const
  const topHand = [grip[0] - dir[0] * HAND_GAP, grip[1] - dir[1] * HAND_GAP] as const
  const lowHand = [grip[0] + dir[0] * HAND_GAP, grip[1] + dir[1] * HAND_GAP] as const
  const butt = [grip[0] - dir[0] * BUTT, grip[1] - dir[1] * BUTT] as const

  // FIVE LAYERS, BACK TO FRONT, each outlined as it lands. The two hands get
  // one each and go on LAST, after the shaft, so every hand carries its own
  // dark ring and a pixel of club shows between them. Sharing a layer let the
  // two blobs merge into a single mitten — which is precisely what reading as
  // "one hand on the club" looked like.
  const farArm = blank()
  stroke(farArm, FAR_SHOULDER, topHand, 'S', 2)
  stampWithEdge(g, farArm, '#')

  const club = blank()
  stroke(club, butt, f.club, 'C', 2)
  disc(club, f.club[0], f.club[1], 1.6, 'K')
  stampWithEdge(g, club, '#')

  const nearArm = blank()
  stroke(nearArm, NEAR_SHOULDER, lowHand, 'H', 3)
  stampWithEdge(g, nearArm, '#')

  // THE HANDS GO LAST, one layer each. Last, because an arm drawn over them
  // erases the grip — which is how the top hand vanished and left a wolf
  // holding a club with one. One layer EACH, because two hands on a golf club
  // are adjacent, and sharing a layer merges them into a single mitten; stamped
  // separately, the outline of the second cuts the seam between them.
  const top = blank()
  disc(top, topHand[0], topHand[1], 1, 'W')
  stampWithEdge(g, top, '#')

  const low = blank()
  disc(low, lowHand[0], lowHand[1], 1, 'W')
  stampWithEdge(g, low, '#')

  for (const [x, y] of f.spark) put(g, x, y, '*')

  const [bx, by, n] = f.ball
  const r = (n - 1) / 2
  const ball = blank()
  disc(ball, bx + r, by + r, r, 'B')
  if (n >= 4) {
    disc(ball, bx + r * 0.6, by + r * 0.6, r * 0.4, 'b') // lit shoulder
    disc(ball, bx + r * 1.45, by + r * 1.45, r * 0.34, 's') // shaded underside
    put(ball, bx + Math.round(r * 1.3), by + Math.round(r * 0.55), 's')
    put(ball, bx + Math.round(r * 0.55), by + Math.round(r * 1.35), 's')
  } else {
    put(ball, bx, by, 'b')
  }
  stampWithEdge(g, ball, '#')

  return edge(g, '#')
}

const LEGEND: Record<string, string> = {
  '#': OUTLINE,
  H: FUR_HI,
  F: FUR,
  S: FUR_SH,
  D: FUR_DARK,
  N: INK,
  E: EYE,
  L: LENS,
  G: GLINT,
  W: GLOVE,
  C: CLUB,
  K: CLUB_HEAD,
  B: BALL,
  b: BALL_HI,
  s: BALL_SH,
  '*': SPARK,
}

/**
 * A character grid to rects, collapsing horizontal runs. One rect per run keeps
 * the output the same shape as the hand-written art elsewhere in the house
 * idiom, and every value is on the integer grid by construction.
 */
function pixels(g: Grid, key: string): ReactElement {
  const out: ReactElement[] = []
  g.forEach((row, y) => {
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

export const WOLF_SWING_FRAMES: readonly ReactElement[] = SWING.map((f, i) =>
  pixels(swingFrame(f, false), `w${i}`),
)
export const WOLF_SHADES_SWING_FRAMES: readonly ReactElement[] = SWING.map((f, i) =>
  pixels(swingFrame(f, true), `b${i}`),
)

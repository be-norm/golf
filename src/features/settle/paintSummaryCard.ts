import { formatCents, formatCentsSigned } from '../../engine/core/money'
import type { ScorecardHalf, SummaryCard } from './summaryCard'

/**
 * Paints a round summary onto a canvas, by hand.
 *
 * Deliberately NOT a DOM screenshot. Rasterising the live screen means
 * `foreignObject`, which means fighting Tailwind v4's `oklch()` colours, the
 * woff2 files Vite leaves un-inlined, and iOS Safari — for a design that is
 * rectangles and monospace text. Drawing it directly costs less and is exact.
 *
 * The trade-off: jsdom has no 2D context, so nothing here is unit-tested. That
 * is why every number arrives pre-computed in `SummaryCard` (which IS tested)
 * and this file only decides where things sit. Keep it that way — don't add a
 * canvas polyfill to test the pixels, and don't move logic in here.
 */

/** Mirrors the @theme block in src/app/index.css. Canvas can't read Tailwind. */
const C = {
  bg: '#052e16', // felt-950
  panelFelt: '#0b3d20', // felt-900
  panelStone: '#1c1917', // stone-900
  borderFelt: '#22c55e', // felt-500
  borderStone: '#44403c', // stone-700
  rule: '#292524', // stone-800
  green: '#7dff66', // felt-300
  red: '#ff4444', // flag-500
  gold: '#ffd23e', // coin-400
  text: '#fafaf9', // stone-50
  dim: '#d6d3d1', // stone-300
  faint: '#a8a29e', // stone-400
  ghost: '#78716c', // stone-500
  shadow: 'rgba(0,0,0,0.6)',
} as const

const DISPLAY = '"Press Start 2P"'
const BODY = 'VT323'

const W = 480
const PAD = 16
const INNER = W - PAD * 2
const GAP = 14

/** What iOS Safari actually allows a canvas to be — the binding constraint is area. */
const MAX_DIM = 8192
const MAX_AREA = 16_777_216

interface Block {
  height: number
  draw(g: Ctx, y: number): void
}

type Ctx = CanvasRenderingContext2D

/**
 * Canvas silently falls back to the generic monospace if the face isn't loaded
 * yet — the single most likely way this ships looking wrong. Both faces are
 * bundled, so this resolves offline.
 */
async function loadFonts(): Promise<void> {
  if (!document.fonts) return
  await Promise.all([
    document.fonts.load(`400 12px ${DISPLAY}`),
    document.fonts.load(`400 20px ${BODY}`),
  ])
}

interface TextOpts {
  size: number
  display?: boolean
  color?: string
  align?: CanvasTextAlign
  /** hard 8-bit drop shadow, as `.pixel` does for panels */
  shadow?: number
}

function setFont(g: Ctx, o: TextOpts): void {
  g.font = `400 ${o.size}px ${o.display ? DISPLAY : BODY}`
}

/** Draws with y as the vertical CENTRE of the line — layout here is row-based. */
function text(g: Ctx, s: string, x: number, y: number, o: TextOpts): void {
  setFont(g, o)
  g.textAlign = o.align ?? 'left'
  g.textBaseline = 'middle'
  if (o.shadow) {
    g.fillStyle = C.shadow
    g.fillText(s, x + o.shadow, y + o.shadow)
  }
  g.fillStyle = o.color ?? C.text
  g.fillText(s, x, y)
}

function width(g: Ctx, s: string, o: TextOpts): number {
  setFont(g, o)
  return g.measureText(s).width
}

/** The `.pixel` utility: 2px border, 4px hard shadow, no radius, ever. */
function panel(g: Ctx, y: number, h: number, border: string, fill: string): void {
  g.fillStyle = C.shadow
  g.fillRect(PAD + 4, y + 4, INNER, h)
  g.fillStyle = fill
  g.fillRect(PAD, y, INNER, h)
  g.lineWidth = 2
  g.strokeStyle = border
  g.strokeRect(PAD + 1, y + 1, INNER - 2, h - 2)
}

function ellipsize(g: Ctx, s: string, max: number, o: TextOpts): string {
  if (width(g, s, o) <= max) return s
  let cut = s
  while (cut.length > 1 && width(g, `${cut}…`, o) > max) cut = cut.slice(0, -1)
  return `${cut}…`
}

/**
 * Greedy word wrap that also breaks a token with no break opportunity — a
 * hyphen-free course name, say, or a long single-word player name inside a
 * Nassau line. Without the inner chop, a word wider than the column is
 * accepted whole and simply runs off the panel edge.
 *
 * Pure and measure-injected so the one loop in this file with a termination
 * condition can be tested without a canvas. See paintSummaryCard.test.ts.
 */
export function wrapText(
  measure: (s: string) => number,
  s: string,
  max: number,
): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (measure(next) <= max) {
      line = next
      continue
    }
    if (line) lines.push(line)
    // No break opportunity left: chop the token itself. `cut` is floored at 1 —
    // on a one-character remainder `rest.length - 1` is 0, which would emit an
    // empty line and leave `rest` untouched, i.e. spin forever. The floor is
    // what makes `rest` strictly shrink, so this terminates even when `max` is
    // narrower than a single glyph.
    let rest = word
    while (measure(rest) > max) {
      let cut = Math.max(1, rest.length - 1)
      while (cut > 1 && measure(rest.slice(0, cut)) > max) cut--
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines
}

function wrap(g: Ctx, s: string, max: number, o: TextOpts): string[] {
  return wrapText((t) => width(g, t, o), s, max)
}

// ── sections ────────────────────────────────────────────────────────────────

function headerBlock(g: Ctx, card: SummaryCard): Block {
  const nameLines = wrap(g, card.course, INNER, { size: 24 })
  const height = 34 + 10 + nameLines.length * 26 + 22
  return {
    height,
    draw(g, y) {
      text(g, 'GOLF', W / 2, y + 16, {
        size: 22,
        display: true,
        color: C.green,
        align: 'center',
        shadow: 4,
      })
      let cursor = y + 44
      for (const line of nameLines) {
        text(g, line, W / 2, cursor + 13, { size: 24, color: C.text, align: 'center' })
        cursor += 26
      }
      text(g, card.subtitle, W / 2, cursor + 11, { size: 19, color: C.faint, align: 'center' })
    },
  }
}

function standingsBlock(card: SummaryCard): Block {
  const ROW = 30
  const body = card.standings.length * ROW
  const height = 20 + 26 + body + 16
  return {
    height,
    draw(g, y) {
      panel(g, y, height, C.borderFelt, C.panelFelt)
      text(g, '★ FINAL STANDINGS ★', W / 2, y + 26, {
        size: 12,
        display: true,
        color: C.gold,
        align: 'center',
      })
      card.standings.forEach((s, i) => {
        const mid = y + 62 + i * ROW
        const amount = formatCentsSigned(s.cents)
        const amountOpts: TextOpts = {
          size: 13,
          display: true,
          color: s.cents > 0 ? C.green : s.cents < 0 ? C.red : C.faint,
        }
        text(g, `${i + 1}P`, PAD + 14, mid + 1, { size: 10, display: true, color: C.ghost })
        const nameX = PAD + 46
        const room = INNER - 46 - 14 - width(g, amount, amountOpts) - 12
        const label = `${s.leader ? '🏆 ' : ''}${s.name}`
        text(g, ellipsize(g, label, room, { size: 22 }), nameX, mid, { size: 22 })
        text(g, amount, W - PAD - 14, mid + 1, { ...amountOpts, align: 'right' })
      })
    },
  }
}

function settleBlock(card: SummaryCard): Block {
  const HEAD = 26
  const SUB = 22
  const body = card.settle.reduce((h, c) => h + HEAD + c.from.length * SUB + 8, 0)
  const height = 18 + 20 + body + 8
  return {
    height,
    draw(g, y) {
      panel(g, y, height, C.borderStone, C.panelStone)
      text(g, 'SETTLE UP', PAD + 14, y + 24, { size: 10, display: true, color: C.faint })
      let cursor = y + 44
      for (const c of card.settle) {
        const total = formatCents(c.totalCents)
        const totalOpts: TextOpts = { size: 13, display: true, color: C.gold }
        const room = INNER - 28 - width(g, total, totalOpts) - 12
        text(
          g,
          ellipsize(g, `${c.name} collects`, room, { size: 21 }),
          PAD + 14,
          cursor + HEAD / 2,
          { size: 21 },
        )
        text(g, total, W - PAD - 14, cursor + HEAD / 2 + 1, { ...totalOpts, align: 'right' })
        cursor += HEAD
        // the indent rule, matching the screen's border-l-2
        g.fillStyle = C.rule
        g.fillRect(PAD + 16, cursor, 2, c.from.length * SUB)
        for (const f of c.from) {
          const amount = formatCents(f.cents)
          const amountOpts: TextOpts = { size: 11, display: true, color: C.faint }
          const sub = INNER - 44 - width(g, amount, amountOpts) - 12
          text(
            g,
            ellipsize(g, `← ${f.name}`, sub, { size: 19 }),
            PAD + 28,
            cursor + SUB / 2,
            { size: 19, color: C.dim },
          )
          text(g, amount, W - PAD - 14, cursor + SUB / 2 + 1, { ...amountOpts, align: 'right' })
          cursor += SUB
        }
        cursor += 8
      }
    },
  }
}

function gameBlock(g: Ctx, game: SummaryCard['games'][number]): Block {
  const LINE = 24
  const LABEL_W = 96
  // a ledger is two columns (gold chip left, value right); plain lines are a
  // list and read left-aligned, as they do on screen
  const ledger = game.kind === 'ledger'
  // long values wrap rather than overrun the panel — Nassau's are the longest
  const wrapped = game.lines.map((l) => {
    const indent = l.depth ? 16 : 0
    const max = INNER - 28 - indent - (ledger ? LABEL_W : 0)
    return { ...l, indent, rows: wrap(g, l.value, max, { size: 19 }) }
  })
  const body = wrapped.reduce((h, l) => h + l.rows.length * LINE, 0) || LINE
  const height = 16 + 22 + body + 12
  return {
    height,
    draw(g, y) {
      panel(g, y, height, C.borderStone, C.panelStone)
      const titleOpts: TextOpts = { size: 12, display: true, color: C.green }
      text(g, game.name.toUpperCase(), PAD + 14, y + 24, titleOpts)
      if (game.allowance) {
        text(g, game.allowance, PAD + 22 + width(g, game.name.toUpperCase(), titleOpts), y + 24, {
          size: 11,
          display: true,
          color: C.faint,
        })
      }
      let cursor = y + 40
      if (wrapped.length === 0) {
        text(g, 'No money moved.', PAD + 14, cursor + LINE / 2, { size: 19, color: C.ghost })
        return
      }
      for (const line of wrapped) {
        const x = PAD + 14 + line.indent
        if (ledger && line.label) {
          text(g, line.label.toUpperCase(), x, cursor + LINE / 2 + 1, {
            size: 9,
            display: true,
            color: C.gold,
          })
        }
        line.rows.forEach((row, i) => {
          text(g, row, ledger ? W - PAD - 14 : x, cursor + LINE / 2 + i * LINE, {
            size: 19,
            color: C.dim,
            align: ledger ? 'right' : 'left',
          })
        })
        cursor += line.rows.length * LINE
      }
    },
  }
}

function scorecardBlock(half: ScorecardHalf): Block {
  const NAME_W = 74
  const TOTAL_W = 38
  const ROW = 26
  const cellW = (INNER - 28 - NAME_W - TOTAL_W) / half.holes.length
  const titleH = half.title ? 22 : 0
  const height = 12 + titleH + ROW * 2 + half.rows.length * ROW + 12

  const colCentre = (i: number) => PAD + 14 + NAME_W + cellW * (i + 0.5)
  const totalCentre = W - PAD - 14 - TOTAL_W / 2

  return {
    height,
    draw(g, y) {
      panel(g, y, height, C.borderStone, C.panelStone)
      let cursor = y + 12
      if (half.title) {
        text(g, half.title.toUpperCase(), PAD + 14, cursor + 11, {
          size: 9,
          display: true,
          color: C.gold,
        })
        cursor += titleH
      }

      // hole numbers
      text(g, 'HOLE', PAD + 14, cursor + ROW / 2, { size: 9, display: true, color: C.faint })
      half.holes.forEach((h, i) => {
        text(g, String(h), colCentre(i), cursor + ROW / 2, {
          size: 19,
          color: C.faint,
          align: 'center',
        })
      })
      text(g, '—', totalCentre, cursor + ROW / 2, { size: 19, color: C.faint, align: 'center' })
      cursor += ROW

      // par
      text(g, 'PAR', PAD + 14, cursor + ROW / 2, { size: 9, display: true, color: C.ghost })
      half.pars.forEach((p, i) => {
        text(g, String(p), colCentre(i), cursor + ROW / 2, {
          size: 18,
          color: C.ghost,
          align: 'center',
        })
      })
      text(g, String(half.parTotal), totalCentre, cursor + ROW / 2, {
        size: 18,
        color: C.ghost,
        align: 'center',
      })
      cursor += ROW

      for (const row of half.rows) {
        g.fillStyle = C.rule
        g.fillRect(PAD + 14, cursor, INNER - 28, 1)
        text(g, ellipsize(g, row.name, NAME_W - 6, { size: 20 }), PAD + 14, cursor + ROW / 2, {
          size: 20,
        })
        row.scores.forEach((s, i) => {
          const diff = s === undefined ? 0 : s - half.pars[i]!
          text(g, s === undefined ? '·' : String(s), colCentre(i), cursor + ROW / 2, {
            size: 20,
            align: 'center',
            color: s === undefined ? C.ghost : diff < 0 ? C.green : diff > 0 ? C.gold : C.text,
          })
        })
        // handicap strokes, marked the way the scorecard screen marks them
        row.strokes.forEach((has, i) => {
          if (!has) return
          g.fillStyle = C.borderFelt
          g.fillRect(colCentre(i) - cellW / 2 + 3, cursor + ROW - 4, cellW - 6, 2)
        })
        text(g, row.total > 0 ? String(row.total) : '', totalCentre, cursor + ROW / 2, {
          size: 20,
          align: 'center',
        })
        cursor += ROW
      }
    },
  }
}

function footerBlock(card: SummaryCard): Block {
  const noteH = card.strokeNote ? 20 : 0
  const height = noteH + 24
  return {
    height,
    draw(g, y) {
      if (card.strokeNote) {
        text(g, card.strokeNote, W / 2, y + 10, { size: 16, color: C.ghost, align: 'center' })
      }
      text(g, 'golf.mainspring.fyi', W / 2, y + noteH + 10, {
        size: 9,
        display: true,
        color: C.ghost,
        align: 'center',
      })
    },
  }
}

/**
 * The CRT overlay the app wears full-screen. Alpha is the app's two factors
 * multiplied out — `.scanlines` paints black at 0.5 and the layer that carries
 * it runs at opacity 0.13 (AppLayout). Painting 0.5 flat here would dim the
 * whole card and fur up the text.
 */
function scanlines(g: Ctx, height: number): void {
  g.fillStyle = 'rgba(0,0,0,0.065)'
  for (let y = 2; y < height; y += 3) g.fillRect(0, y, W, 1)
}

// ── entry point ─────────────────────────────────────────────────────────────

export async function paintSummaryCard(card: SummaryCard): Promise<Blob> {
  await loadFonts()

  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('canvas 2d context unavailable')

  const blocks: Block[] = [
    headerBlock(measure, card),
    standingsBlock(card),
    ...(card.settle.length > 0 ? [settleBlock(card)] : []),
    ...card.games.map((game) => gameBlock(measure, game)),
    ...card.cards.map((half) => scorecardBlock(half)),
    footerBlock(card),
  ]

  const height = Math.ceil(
    PAD + blocks.reduce((h, b) => h + b.height, 0) + GAP * (blocks.length - 1) + PAD,
  )

  // Integer scale keeps the pixel grid honest. Retina matters here — the card
  // is read on a phone — so only drop to 1× when 2× genuinely won't fit, and
  // measure "fit" against what iOS Safari actually enforces: 8192 per side and
  // ~16.7M pixels of area. Clamping on the legacy 4096-per-side figure instead
  // put the cliff at 2048 logical px, which a 4-player 3-game round clears —
  // it shipped those rounds at 480px wide.
  const fits = (s: number) =>
    W * s <= MAX_DIM && height * s <= MAX_DIM && W * s * height * s <= MAX_AREA
  const scale = fits(2) ? 2 : 1

  const canvas = document.createElement('canvas')
  canvas.width = W * scale
  canvas.height = height * scale
  const g = canvas.getContext('2d')
  if (!g) throw new Error('canvas 2d context unavailable')
  g.scale(scale, scale)
  g.imageSmoothingEnabled = false

  g.fillStyle = C.bg
  g.fillRect(0, 0, W, height)

  let y = PAD
  for (const block of blocks) {
    block.draw(g, y)
    y += block.height + GAP
  }

  scanlines(g, height)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no image'))),
      'image/png',
    )
  })
}

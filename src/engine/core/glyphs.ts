/**
 * PIXEL GLYPHS INSIDE ENGINE TEXT.
 *
 * An engine is pure TypeScript (invariant #1) and cannot emit React, but some
 * of what it says is better shown than spelled — Wolf's lone and blind marks.
 * So a glyph travels as a TOKEN inside the string (`:wolf-shades:`) and the app
 * swaps in artwork at render time (`GlyphText` → `PixelGlyph`).
 *
 * This is strictly LESS presentational than what it replaces: these strings
 * already carried emoji, and a token is a name the app resolves rather than a
 * picture the engine picked.
 *
 * TWO RULES, both enforced rather than remembered:
 *
 * 1. TOKENS ONLY IN CHANNELS THAT DECODE THEM — `holeSummary` and
 *    `requiredInputs`. The pinned bar renders `summary` / `summaryParts` raw,
 *    and the share card is a PAINTED PNG built from `settlement.lines`,
 *    `detailLines` and `notes` — a token there would be rasterised as a literal
 *    `:wolf:` into an image people send each other. `glyphs.test.ts` derives
 *    every registered engine and fails on a token found anywhere else.
 * 2. THE WORD GOES WITH THE PICTURE. A 16px graphic cannot teach that blind
 *    wolf means "called before anyone hit, so the hole triples", so every
 *    string using a glyph also says it in words. That is why the artwork is
 *    decorative (`aria-hidden`) rather than labelled: the words are already
 *    there, and labelling it would announce them twice.
 */

export const GLYPH_NAMES = ['wolf', 'wolf-shades'] as const

export type GlyphName = (typeof GLYPH_NAMES)[number]

/** `:wolf-shades:` — the token as it appears in engine text. */
export function glyph(name: GlyphName): string {
  return `:${name}:`
}

/**
 * Token SHAPE, deliberately wider than the known names: a typo like
 * `:wolf-shdes:` must be caught by the leak guard and rendered visibly by
 * `GlyphText`, not silently treated as prose.
 *
 * Non-global on purpose — a `/g` regex carries `lastIndex` between calls, which
 * makes `.test()` alternate true/false on the same input. `parseGlyphs` builds
 * its own splitter.
 */
export const GLYPH_TOKEN_RE = /:([a-z][a-z-]*[a-z]|[a-z]):/

export type GlyphPart =
  | { kind: 'text'; value: string }
  | { kind: 'glyph'; name: GlyphName }
  /** token-shaped but not a glyph we have art for — rendered literally */
  | { kind: 'unknown'; value: string }

const isGlyphName = (s: string): s is GlyphName => (GLYPH_NAMES as readonly string[]).includes(s)

/**
 * Split engine text into renderable parts. ONE parser, shared by the renderer
 * and the leak guard, so the thing the test proves is the thing the screen
 * runs.
 */
export function parseGlyphs(text: string): GlyphPart[] {
  const parts: GlyphPart[] = []
  const splitter = new RegExp(GLYPH_TOKEN_RE.source, 'g')
  let last = 0
  for (const m of text.matchAll(splitter)) {
    const at = m.index
    if (at > last) parts.push({ kind: 'text', value: text.slice(last, at) })
    parts.push(isGlyphName(m[1]!) ? { kind: 'glyph', name: m[1] } : { kind: 'unknown', value: m[0] })
    last = at + m[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) })
  return parts
}

/** Does this string carry anything token-shaped? The leak guard's question. */
export function hasGlyphToken(text: string): boolean {
  return parseGlyphs(text).some((p) => p.kind !== 'text')
}

import type { ReactElement } from 'react'
import type { GlyphName } from '../engine/core/glyphs'
import { SHADES_EYES, WOLF_EYES, wolfHead } from './wolfArt'

/**
 * Hand-drawn 16×16 pixel art, in the house idiom already set by
 * `public/icon.svg`: `shape-rendering="crispEdges"` rects on a 16-unit grid, in
 * the theme palette. The drawing itself lives in `wolfArt.tsx`, shared with the
 * animated `PixelSprite` — one animal, so the still and the moving picture
 * cannot drift apart.
 *
 * RENDERED IN A 16px BOX so one art pixel is exactly one CSS pixel. A
 * fractional scale is what makes crisp-edged pixel art look uneven — the rects
 * still snap to device pixels, but they snap to DIFFERENT widths, and a wolf
 * with one fat ear is worse than a slightly small one.
 *
 * LABELLED, NOT DECORATIVE — and that reversed once the mark moved onto the
 * wolf's name. While a glyph only ever led a solo line ("Ben (lone)"), the words
 * beside it said everything and `aria-hidden` kept the Lone Wolf button from
 * announcing "Lone Wolf Lone Wolf". But "Ann 🐺 & Bob" has no word for which of
 * the two holds the tee — the picture IS the fact — so a hidden glyph would
 * simply drop it. The button's small redundancy is the cheaper of the two.
 *
 * `data-glyph` is the handle tests use.
 */

const LABEL: Record<GlyphName, string> = {
  wolf: 'the wolf',
  'wolf-shades': 'blind wolf',
}

const ART: Record<GlyphName, ReactElement> = {
  wolf: wolfHead(WOLF_EYES),
  'wolf-shades': wolfHead(SHADES_EYES),
}

export function PixelGlyph({ name }: { name: GlyphName }) {
  return (
    <svg
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      role="img"
      aria-label={LABEL[name]}
      focusable="false"
      data-glyph={name}
      style={{ width: 16, height: 16, verticalAlign: -1, display: 'inline-block' }}
    >
      {ART[name]}
    </svg>
  )
}

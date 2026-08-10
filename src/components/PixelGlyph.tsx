import type { ReactElement } from 'react'
import type { GlyphName } from '../engine/core/glyphs'

/**
 * Hand-drawn 16×16 pixel art, in the house idiom already set by
 * `public/icon.svg`: `shape-rendering="crispEdges"` rects on a 16-unit grid, in
 * the theme palette.
 *
 * RENDERED IN A 16px BOX so one art pixel is exactly one CSS pixel. A
 * fractional scale is what makes crisp-edged pixel art look uneven — the rects
 * still snap to device pixels, but they snap to DIFFERENT widths, and a wolf
 * with one fat ear is worse than a slightly small one.
 *
 * DECORATIVE BY CONTRACT — `aria-hidden`, because every engine string carrying
 * a glyph also says the word (see `engine/core/glyphs.ts`). Labelling it would
 * make the accessible name of the Lone Wolf button "Lone Wolf Lone Wolf".
 * `data-glyph` is the handle tests use, since there is no accessible name.
 */

const FUR = '#a8a29e'
const FUR_DARK = '#57534e'
const MUZZLE = '#d6d3d1'
const INK = '#1c1917'
const EYE = '#ffd23e'
const LENS = '#0c0a09'
const GLINT = '#f5f5f4'

/** The head every variant shares — ears, taper, muzzle. Eyes are the variable. */
function head(eyes: ReactElement) {
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

const ART: Record<GlyphName, ReactElement> = {
  wolf: head(
    <>
      <rect x="4" y="6" width="2" height="2" fill={EYE} />
      <rect x="10" y="6" width="2" height="2" fill={EYE} />
    </>,
  ),
  'wolf-shades': head(
    <>
      {/* one band across the whole head, notched at the bridge so it reads as
          two lenses rather than a blindfold */}
      <rect x="1" y="6" width="14" height="2" fill={LENS} />
      <rect x="7" y="6" width="2" height="1" fill={FUR} />
      <rect x="3" y="6" width="1" height="1" fill={GLINT} />
      <rect x="11" y="6" width="1" height="1" fill={GLINT} />
    </>,
  ),
}

export function PixelGlyph({ name }: { name: GlyphName }) {
  return (
    <svg
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      data-glyph={name}
      style={{ width: 16, height: 16, verticalAlign: -1, display: 'inline-block' }}
    >
      {ART[name]}
    </svg>
  )
}

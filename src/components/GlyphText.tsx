import { Fragment } from 'react'
import { parseGlyphs } from '../engine/core/glyphs'
import { PixelGlyph } from './PixelGlyph'

/**
 * Engine text, with `:wolf:`-style tokens swapped for pixel art.
 *
 * Sited beside `DetailLines` and `GameSummary`, the other text primitives —
 * which deliberately do NOT route through this, because they render channels
 * that must stay token-free (see `engine/core/glyphs.ts`). Use this only where
 * `holeSummary` or `requiredInputs` text is rendered.
 *
 * An unrecognised token renders literally rather than vanishing: a glyph that
 * silently disappears takes the sentence's meaning with it.
 */
export function GlyphText({ text }: { text: string }) {
  return (
    <>
      {parseGlyphs(text).map((part, i) =>
        part.kind === 'glyph' ? (
          <PixelGlyph key={i} name={part.name} />
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        ),
      )}
    </>
  )
}

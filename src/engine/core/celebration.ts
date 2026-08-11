import type { Uuid } from './types'

/**
 * THE CELEBRATION CHANNEL — "this hole is worth a small noise, and here is what
 * kind of noise it is."
 *
 * The fourth read channel, after `holeSummary` (narration), `requiredInputs`
 * (blocking pulls) and `awards` (per-hole grants). It exists because the app
 * layer has zero per-game branching (invariant #7) and yet each game is meant
 * to celebrate in its OWN way: the only way both hold is for the engine to name
 * its animation and for the app to own the drawing.
 *
 * So a sprite is a TOKEN, exactly as a glyph is (`glyphs.ts`). Engines are pure
 * TypeScript and cannot emit React; `PixelSprite` maps the token to art and
 * fails to compile if a token has none.
 *
 * WHAT BELONGS HERE, and what does not: a celebration marks a hole whose
 * outcome the group would remark on — a skin won, a bet closed, an award taken.
 * It is NOT a second settlement channel and nothing derives from it; like every
 * other `meta`/presentation surface, `deriveRound` never reads it. An engine
 * that returned a celebration for every hole would be wrong in the same way a
 * game that badged every action as `recommended` is wrong: a thing that fires
 * constantly stops meaning anything, and the ticket's own constraint is
 * "short / non-distracting".
 */
export const CELEBRATION_SPRITES = ['coin'] as const

export type CelebrationSprite = (typeof CELEBRATION_SPRITES)[number]

export interface Celebration {
  /** which art plays; the app owns the drawing, the engine owns the choice */
  sprite: CelebrationSprite
  /**
   * WHOSE HOLE THIS WAS — the animation anchors to these players' score rows.
   * Empty is legal (a hole that decided nothing for anyone in particular) and
   * simply plays at the bar.
   */
  playerIds: readonly Uuid[]
  /**
   * MAGNITUDE — three skins throws three coins. The renderer clamps it, so an
   * engine cannot turn a large pot into a screenful; but it is the engine's job
   * to say how big the moment was, because only the engine knows.
   */
  count: number
  /**
   * The game's own words for what happened, e.g. "Rob wins 2 skins".
   *
   * A DECODING CHANNEL — rendered through `GlyphText`, so glyph tokens are
   * legal here (see `glyphs.ts`). That is safe precisely because a celebration
   * is transient DOM and never reaches `paintSummaryCard`'s canvas, which is
   * what makes tokens unsafe in `settlement.lines` / `detailLines` / `notes`.
   *
   * Say it in the fewest words that are still true: this rides beside a 48px
   * sprite on a phone, not in a ledger.
   */
  text: string
  /**
   * WHICH HOLE — required, and load-bearing rather than informational. The
   * scoring screen fires at most one celebration per append and picks it by
   * hole, so a celebration that misreported this would animate for the wrong
   * hole or be suppressed entirely. Same rule, and the same reason, as
   * `GameEventOffer.data` having to carry `hole`.
   */
  hole: number
}

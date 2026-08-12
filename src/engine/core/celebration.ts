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
/**
 * The wolf tokens deliberately share their names with the GLYPHS of the same
 * animal (`glyphs.ts`), because they are the same animal: a Wolf hole shows the
 * still wolf in its ledger line and throws the moving one when it decides. Two
 * token namespaces, one drawing (`components/wolfArt.tsx`).
 */
export const CELEBRATION_SPRITES = ['coin', 'wolf', 'wolf-shades'] as const

export type CelebrationSprite = (typeof CELEBRATION_SPRITES)[number]

/**
 * HOW IT IS SHOWN, which is not the same question as what plays.
 *
 * `toss` — N countable things thrown from the pinned bar to a player's row. A
 * garnish, read in peripheral vision while you carry on entering scores. Skins'
 * coins: three skins is three coins, and the pile IS the magnitude.
 *
 * `scene` — one picture, centre screen, held still and played slowly enough to
 * watch. For a sprite that is a little film rather than an object: Wolf's wolf
 * clubs a ball at the camera, and a thing like that tossed across a phone in
 * six tenths of a second is a smear nobody can read.
 *
 * IT IS A DECLARED DISCRIMINATOR, not something the layer infers. `count === 1`
 * would have been free and is wrong twice over — a one-skin hole is still a
 * toss, and it would silently change how a game is presented the day its
 * arithmetic changed. Same rule as `GamePanel.kind`: carry the intent, don't
 * overload a field.
 */
export const CELEBRATION_STYLES = ['toss', 'scene'] as const

export type CelebrationStyle = (typeof CELEBRATION_STYLES)[number]

export interface CelebrationBase {
  /** which art plays; the app owns the drawing, the engine owns the choice */
  sprite: CelebrationSprite
  /**
   * WHOSE HOLE THIS WAS. Empty is legal (a hole that decided nothing for anyone
   * in particular) and simply plays at the bar.
   *
   * NAMING SEVERAL IS NOT ANIMATING SEVERAL. The burst has one anchor:
   * `CelebrationLayer.anchorFor` takes the FIRST of these whose score row is
   * mounted. List everyone the hole belonged to anyway — Wolf's pack wins do —
   * because this list is also what the layer's seen-key is built from, so it is
   * what makes a correction that moves somebody between the sides read as a new
   * event rather than the same one.
   */
  playerIds: readonly Uuid[]
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

/**
 * `count` LIVES ON THE TOSS AND NOWHERE ELSE, because it is a toss idea: three
 * skins throws three coins. The renderer clamps it, so an engine cannot turn a
 * large pot into a screenful; but it is the engine's job to say how big the
 * moment was, because only the engine knows.
 *
 * A scene has no count — one picture is the whole of it, and a field that would
 * have to be documented as "ignored here" is a field in the wrong place.
 */
export type Celebration =
  | (CelebrationBase & { style: 'toss'; count: number })
  | (CelebrationBase & { style: 'scene' })

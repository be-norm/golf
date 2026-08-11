/**
 * THE HOUSE EASING SIGNATURE: motion snaps to a grid, it does not ease on a
 * curve. Both CSS keyframes in `index.css` use `steps()` for the same reason —
 * choppiness is what reads as 8-bit, and a smooth cubic-bezier on pixel art
 * reads as a modern app wearing a costume.
 *
 * Quantizes a Motion ease function into `n` discrete jumps. Lower `n` is
 * chunkier: `stepped(3)` is a hard three-frame move, `stepped(12)` is nearly
 * smooth. Match `n` to the distance travelled — a 400px fall wants more steps
 * than a 40px nudge, or the jumps read as dropped frames rather than as style.
 *
 * Lived inline in three places before it lived here (`Sheet` at 5, the settle
 * standings at 3, `Confetti` parameterised), which is two too many for the one
 * decision that makes the app's motion look like itself.
 */
export const stepped =
  (n: number) =>
  (t: number): number =>
    Math.ceil(t * n) / n

/**
 * Frame counts for the sprite strips (`PixelSprite`) — a sprite animates by
 * translating a horizontal strip one cell at a time under `steps(frames)`, so
 * the step count and the frame count are THE SAME NUMBER. Naming it once keeps
 * a strip from being drawn with four frames and animated with three, which
 * shows up as a permanently missing pose rather than as an error.
 */
export const FRAME_MS = 90

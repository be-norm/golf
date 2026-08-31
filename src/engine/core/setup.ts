import type { GameConfig } from './types'

/**
 * Setup-time validation helpers shared by the engines. Nothing here is reachable
 * from `derive` — these answer "is this round buildable?", never "who owes what".
 */

/**
 * A stable string for any settings value — the one definition of "these two are
 * the same setting".
 *
 * Object keys are sorted so two configs built by different routes (defaults vs.
 * a field the user touched and set back) compare equal, while ARRAYS keep their
 * order — Wolf's `rotation` is a running order, so a different order is a
 * genuinely different game, not the same one spelled differently.
 *
 * Exported because THREE things now ask this question and must answer it the
 * same way: `settingsKey` below (is this game a duplicate of its sibling?),
 * `amendRound`'s locked-field check (did this amendment touch Wolf's rotation?),
 * and the settings editor (did anything actually change, or is Save a no-op?).
 * A second implementation would let the editor write an amendment the fold then
 * silently drops, or refuse one it would have accepted.
 */
export function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, entry]) => [k, canonical(entry)]),
      )
    }
    return v
  }
  // `JSON.stringify(undefined)` is `undefined`, not a string — so a top-level
  // absent value (a config key one side doesn't have) would break the return
  // type and compare by luck. Named rather than coerced, so it stays distinct
  // from `null`, which is a value a config can legitimately hold (nassau's
  // `teams`).
  return JSON.stringify(canonical(value)) ?? 'undefined'
}

/**
 * Everything that makes one instance of a game different from another: its
 * handicap policy and its config.
 */
function settingsKey(game: GameConfig): string {
  return canonicalJson({ handicap: game.handicap, config: game.config })
}

/**
 * "You've added this game twice with the same settings."
 *
 * Setup can hold several instances of one game (MAI-44), which is the point —
 * gross Skins beside net Skins is a real round, and the reason `gameLabel` has a
 * discriminator ladder at all. So this compares the FULL settings, not the type:
 * two Skins differing by a single cent, or by net vs gross, are two games. Two
 * that differ by nothing are a mistap, and they are also indistinguishable
 * everywhere downstream — `gameLabel` would fall through to "#1"/"#2".
 *
 * Both instances report it, so the caller is expected to dedupe (identical
 * strings collapse); reporting once would mean picking which of the two is "the
 * duplicate", and neither is.
 */
export function duplicateInstanceProblems(
  game: GameConfig,
  siblings: readonly GameConfig[],
  gameName: string,
): string[] {
  const key = settingsKey(game)
  const duplicated = siblings.some((s) => s.type === game.type && settingsKey(s) === key)
  return duplicated
    ? [`Two ${gameName} games have identical settings — change one or remove it`]
    : []
}

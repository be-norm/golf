import type { GameConfig } from './types'

/**
 * Setup-time validation helpers shared by the engines. Nothing here is reachable
 * from `derive` — these answer "is this round buildable?", never "who owes what".
 */

/**
 * A stable string for everything that makes one instance of a game different
 * from another: its handicap policy and its config.
 *
 * Object keys are sorted so two configs built by different routes (defaults vs.
 * a field the user touched and set back) compare equal, while ARRAYS keep their
 * order — Wolf's `rotation` is a running order, so a different order is a
 * genuinely different game, not the same one spelled differently.
 */
function settingsKey(game: GameConfig): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      )
    }
    return value
  }
  return JSON.stringify(canonical({ handicap: game.handicap, config: game.config }))
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

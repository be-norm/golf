import { getEngine, type GameEngine } from './catalog'
import { formatCents } from './core/money'
import type { GameConfig } from './core/types'

/**
 * What to call a game on screen — ONE source, because there were three.
 *
 * Six Point rendered as "SixPoint" in the pinned bar and "sixPoint" on the
 * scorecard, from two different ad-hoc transforms of `type`. `meta.name` is the
 * name; nothing else gets to invent one (MAI-42).
 *
 * `gameId` is an instance id precisely so a round can hold two of the same game
 * — gross skins and net skins is the request that motivated it — and at that
 * point `meta.name` alone paints two identical rows in the bar, the standings,
 * the actions sheet and the scorecard chips. So a repeated type earns a
 * discriminator, and ONLY a repeated type: a round with one Skins game must
 * still just say "Skins".
 */
export function gameLabel(game: GameConfig, allGames: readonly GameConfig[]): string {
  const engine = getEngine(game.type)
  const name = engine?.meta.name ?? game.type
  const siblings = allGames.filter((g) => g.type === game.type)
  if (siblings.length < 2) return name
  const tag = discriminator(game, siblings, engine)
  return tag === undefined ? name : `${name} · ${tag}`
}

/**
 * The shortest true difference between this instance and its siblings, in the
 * order a player would notice it.
 *
 * Deliberately DECLARATIVE — the money field is read off `configFields` rather
 * than named per game, so this keeps working for the two dozen games still to
 * land without any of them touching it.
 */
function discriminator(
  game: GameConfig,
  siblings: readonly GameConfig[],
  engine: GameEngine | undefined,
): string | undefined {
  // net vs gross is the request that started this, and the difference a golfer
  // is most likely to be holding in their head
  if (new Set(siblings.map((g) => g.handicap.mode)).size > 1) return game.handicap.mode
  if (new Set(siblings.map((g) => g.handicap.allowancePct)).size > 1) {
    return `${game.handicap.allowancePct}%`
  }

  const moneyKey = engine?.configFields.find((f) => f.kind === 'money')?.key
  if (moneyKey !== undefined) {
    const valueOf = (g: GameConfig) => (g.config as Record<string, unknown>)[moneyKey]
    if (new Set(siblings.map(valueOf)).size > 1) {
      const cents = valueOf(game)
      if (typeof cents === 'number') return formatCents(cents)
    }
  }

  // Identical in every way we can name. Still label them, because two rows
  // reading exactly "Skins" is worse than two reading "Skins · #1" and
  // "Skins · #2" — the player at least knows there are two bets running.
  const index = siblings.findIndex((g) => g.gameId === game.gameId)
  return index === -1 ? undefined : `#${index + 1}`
}

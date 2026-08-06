import { getEngine, type ConfigFieldSpec, type GameEngine } from './catalog'
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
 *
 * The separator is ASCII PARENTHESES, not the "·" this app uses elsewhere. This
 * string is drawn onto the share card in the Press Start 2P display font, which
 * every other display-font string has kept to plain ASCII; a middle dot the
 * pixel font lacks would fall back per-glyph to the system face and render the
 * separator in the wrong typeface, mid-title. jsdom has no canvas, so no test
 * would catch it (paintSummaryCard.ts).
 */
export function gameLabel(game: GameConfig, allGames: readonly GameConfig[]): string {
  const engine = getEngine(game.type)
  const name = engine?.meta.name ?? game.type
  const siblings = allGames.filter((g) => g.type === game.type)
  if (siblings.length < 2) return name
  const tag = discriminator(game, siblings, engine)
  return tag === undefined ? name : `${name} (${tag})`
}

/**
 * The shortest difference that actually tells this instance apart from every
 * one of its siblings.
 *
 * "Actually" is the whole job. An axis merely VARYING across the siblings is not
 * enough: with skins net, gross and gross, handicap mode varies — and labelling
 * each game with its own mode produces "gross" twice, which is the exact
 * duplicate this function exists to prevent. So a candidate is used only when it
 * separates ALL of them, and otherwise the next one is tried.
 *
 * Deliberately DECLARATIVE below the handicap tier — config fields are read off
 * `configFields` rather than named per game, so this keeps working for the two
 * dozen games still to land without any of them touching it.
 *
 * Handicap ALLOWANCE is deliberately not a candidate. Both surfaces that show
 * this label already render allowance as its own element beside it (the
 * standings heading, and `GamePanel.allowance` on the share card), so using it
 * here prints "Skins (90%) 90%".
 */
function discriminator(
  game: GameConfig,
  siblings: readonly GameConfig[],
  engine: GameEngine | undefined,
): string | undefined {
  /** a candidate is only usable if it gives every sibling a different answer */
  const separates = (of: (g: GameConfig) => unknown) =>
    new Set(siblings.map(of)).size === siblings.length

  // net vs gross is the request that started this, and the difference a golfer
  // is most likely to be holding in their head
  if (separates((g) => g.handicap.mode)) return game.handicap.mode

  for (const field of engine?.configFields ?? []) {
    const valueOf = (g: GameConfig) => (g.config as Record<string, unknown>)[field.key]
    if (!separates(valueOf)) continue
    const rendered = renderFieldValue(field, valueOf(game))
    if (rendered !== undefined) return rendered
  }

  // Alike in every way we can name. Still label them, because two rows reading
  // exactly "Skins" is worse than "Skins (#1)" and "Skins (#2)" — the player at
  // least learns there are two bets running.
  const index = siblings.findIndex((g) => g.gameId === game.gameId)
  return index === -1 ? undefined : `#${index + 1}`
}

/** A config value as a chip-sized phrase, or undefined if it has no short form. */
function renderFieldValue(field: ConfigFieldSpec, value: unknown): string | undefined {
  switch (field.kind) {
    case 'money':
      return typeof value === 'number' ? formatCents(value) : undefined
    case 'boolean':
      // the field's own label carries the meaning: "Carryovers" / "no carryovers"
      return value === true ? field.label.toLowerCase() : `no ${field.label.toLowerCase()}`
    case 'select':
      return field.options.find((o) => o.value === value)?.label
    // teams and rotation are player assignments — no short phrase names them,
    // and two games differing only in who is on which side need the index
    default:
      return undefined
  }
}

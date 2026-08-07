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
  // A REGISTERED engine's name is guaranteed paintable by catalog.test.ts. The
  // fallback is not: an imported round validates `type` as any string
  // (exportRound.ts), so a card naming a game this build doesn't ship could put
  // arbitrary text — 'スキンズ' — straight into the painted title. Sanitised, so
  // the one path around the choke point below is closed too.
  const name = engine?.meta.name ?? paintableOrPlaceholder(game.type)
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
    // Rendered ONCE per sibling and reused for both checks and the answer.
    // Distinctness is judged on the RENDERED phrase, not the raw value: two
    // select options can carry the same display label, and separating on the
    // values behind them would commit to a field that shows both games the same
    // word — the duplicate this whole function exists to prevent.
    const phrases = siblings.map((g) => renderFieldValue(field, valueOf(g)))
    // and every sibling must actually GET a phrase. `undefined` counts as
    // distinct in a Set, so a field one game cannot render (a legacy config
    // missing the key, a select value not in `options`) would otherwise commit
    // the field and leave that game falling through to "#1" beside a sibling
    // named "$5" — two rows named on different axes, with a #1 and no #2.
    if (phrases.some((p) => p === undefined)) continue
    if (new Set(phrases).size !== siblings.length) continue
    const mine = phrases[siblings.findIndex((g) => g.gameId === game.gameId)]
    if (mine !== undefined) return mine
  }

  // Allowance LAST, not never. It is skipped above the config tier because the
  // standings heading and the share-card panel render it beside this label, so
  // preferring it would print "Skins (90%) 90%". But two of the four surfaces
  // that show a label — the scorecard's chips and the actions sheet — render no
  // allowance at all, so refusing it outright leaves two net games at 100% and
  // 90% as "#1" and "#2": meaningless everywhere, rather than redundant in two
  // places and useful in two.
  if (separates((g) => g.handicap.allowancePct)) return `${game.handicap.allowancePct}%`

  // Alike in every way we can name. Still label them, because two rows reading
  // exactly "Skins" is worse than "Skins (#1)" and "Skins (#2)" — the player at
  // least learns there are two bets running.
  const index = siblings.findIndex((g) => g.gameId === game.gameId)
  return index === -1 ? undefined : `#${index + 1}`
}

/**
 * A config value as a chip-sized phrase, or undefined if it has no short form
 * OR cannot safely be painted.
 *
 * THE ASCII RULE IS ENFORCED HERE, not asked for. Boolean and select phrases
 * are engine-authored free text, and this repo already writes "·" into exactly
 * that kind of string — `nassau`'s teams field is literally
 * `'Teams (best ball · 2v2 or 2v1)'`, kept off the share card today only by the
 * accident that `teams` has no short form. A convention would have caught that
 * the day someone added a boolean labelled the same way; a choke point catches
 * it always. A rejected label simply falls through to the next candidate, so
 * the worst case is "Skins (#1)" rather than a glyph rendered in the system
 * face halfway through a painted title (see gameLabel's note).
 */
function renderFieldValue(field: ConfigFieldSpec, value: unknown): string | undefined {
  const phrase = fieldPhrase(field, value)
  return phrase !== undefined && isPaintable(phrase) ? phrase : undefined
}

/**
 * Printable ASCII only — the range Press Start 2P is known to cover. Exported
 * so the tests that claim to verify this rule check the SAME predicate the
 * painter's input is filtered by, instead of three copies of a regex that can
 * drift apart the day the font's coverage is revised.
 */
export const isPaintable = (s: string) => /^[\x20-\x7E]+$/.test(s)

/** Strip what the pixel font cannot draw; 'Game' if nothing survives. */
function paintableOrPlaceholder(raw: string): string {
  if (isPaintable(raw)) return raw
  const stripped = [...raw].filter((c) => isPaintable(c)).join('').trim()
  return stripped.length > 0 ? stripped : 'Game'
}

function fieldPhrase(field: ConfigFieldSpec, value: unknown): string | undefined {
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
    case 'teams':
    case 'rotation':
      return undefined
    default: {
      // EXHAUSTIVE on purpose. `RoundStartScreen.configChips` renders the same
      // specs with a different framing (it names the field, and skips false
      // booleans), so a new `ConfigFieldSpec` kind has two places to reach —
      // and a `default: return undefined` here would swallow it silently,
      // quietly downgrading a real difference to "#1"/"#2". This makes it a
      // compile error instead.
      const exhaustive: never = field
      void exhaustive
      return undefined
    }
  }
}

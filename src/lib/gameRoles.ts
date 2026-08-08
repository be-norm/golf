import { roleOf } from '../engine/catalog'
import type { GameConfig, Round } from '../engine/core/types'

/**
 * THE default game, for every surface that has to pick one.
 *
 * Three screens used to answer this three different ways — the scoring screen's
 * stroke dots took the first NET game, the scorecard took `games[0]`, and the
 * share card took the first net game or nothing. A round whose `games[0]` was
 * gross therefore showed no underlines until the user tapped a chip, while the
 * shared image underlined a different game's allocation (MAI-50).
 *
 * The rule, in order:
 *
 * 1. the first MAIN game that allocates strokes — a net side bet must not
 *    capture the scoring screen just by being cheap and net;
 * 2. failing that, the first main game — a gross round still has a subject;
 * 3. failing that, `games[0]` — every game is a side bet, so the first one is
 *    as good an answer as exists;
 * 4. failing that, nothing. `round.games` can genuinely be empty: an import may
 *    carry none, and only setup enforces at least one.
 *
 * Steps 1–2 are why this takes the ROUND and not a game list: `roleOf` cannot
 * answer 'either' without seeing the whole round (CLAUDE.md invariant #7).
 */
export function primaryGame(round: Round): GameConfig | undefined {
  const isMain = (g: GameConfig) => roleOf(g, round.games) === 'main'
  return (
    round.games.find((g) => isMain(g) && g.handicap.mode === 'net') ??
    round.games.find(isMain) ??
    round.games[0]
  )
}

/**
 * The primary game, but only when it actually allocates strokes.
 *
 * `primaryGame` falls back to a game that may be gross, which is right for
 * "which game is this screen about" and wrong for "which game do these
 * underlines belong to". The share card prints its answer as prose —
 * `underline = handicap stroke: Skins` — so a gross game there labels an
 * underline that was never drawn, on the image people actually send each other.
 * Undefined is the honest answer, and every consumer already handles it.
 */
export function strokeGame(round: Round): GameConfig | undefined {
  const game = primaryGame(round)
  return game?.handicap.mode === 'net' ? game : undefined
}

export interface RolePartition {
  main: GameConfig[]
  side: GameConfig[]
}

/** Split a round's games by `roleOf`, preserving `round.games` order in both halves. */
export function partitionByRole(games: readonly GameConfig[]): RolePartition {
  const main: GameConfig[] = []
  const side: GameConfig[] = []
  for (const game of games) {
    ;(roleOf(game, games) === 'main' ? main : side).push(game)
  }
  return { main, side }
}

/**
 * Whether the side bets should collapse into one aggregated row/panel.
 *
 * Only when it actually saves space. Nassau + one Skins is the most common
 * two-game round there is, and collapsing there costs the bar its latest-hole
 * recap ("H4 · Rob wins 2 skins" — the convention every stroke-decided game
 * follows) while saving no row at all. Two or more is where the density problem
 * MAI-50 describes actually starts.
 *
 * The `main >= 1` half is the ticket's own rule: a round whose only games are
 * side bets has nothing to collapse them under, and one row reading "SIDE BETS"
 * for the entire round says nothing.
 *
 * Takes COUNTS, because the two callers count different things — the bar counts
 * games, the share card counts rendered panels, and a game whose engine isn't
 * registered produces no panel at all. Counting games there would wrap a lone
 * survivor in a "Side bets" heading.
 */
export function shouldGroupSideBets(counts: { main: number; side: number }): boolean {
  return counts.side >= 2 && counts.main >= 1
}

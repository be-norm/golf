import type { GameDerivation } from '../../engine/catalog'
import { gameLabel } from '../../engine/label'
import type { RoundContext } from '../../engine/core/context'
import {
  collectorsFrom,
  combineSettlements,
  formatCentsSigned,
  minimalTransfers,
} from '../../engine/core/money'
import type { Round, Uuid } from '../../engine/core/types'
import { formatDate } from '../../lib/date'
import { partitionByRole, shouldGroupSideBets, strokeGame } from '../../lib/gameRoles'
import { holeLoop, ordinal } from '../scoring/holeLoop'

/**
 * Everything a finished round has to say, as data — the one derivation behind
 * both the settle screen and the shareable image. Two renderers of the same
 * numbers drift; one model with two painters cannot.
 *
 * Rows keep `playerId` and raw cents alongside the display strings because the
 * screen needs React keys and its own colour logic, while the canvas painter
 * needs neither. Formatting that both agree on lives here.
 *
 * This is a presentation model, so it sits in features rather than the engine:
 * it needs `holeLoop` for the nine-played-twice case, and the engine may not
 * import from app layers (CLAUDE.md invariant 1).
 */
export interface SummaryCard {
  course: string
  /** "18 holes · 3 Aug 2026" */
  subtitle: string
  standings: StandingRow[]
  settle: CollectorRow[]
  games: GamePanel[]
  cards: ScorecardHalf[]
  /** why some scores are underlined — omitted when no game allocates strokes */
  strokeNote?: string
}

export interface StandingRow {
  playerId: Uuid
  name: string
  cents: number
  /** exactly one player, and only when they're actually up */
  leader: boolean
}

export interface CollectorRow {
  playerId: Uuid
  name: string
  totalCents: number
  from: { playerId: Uuid; name: string; cents: number }[]
}

export interface GamePanel {
  gameId: Uuid
  name: string
  /** allowance chip, only when it isn't the default 100% */
  allowance?: string
  /**
   * How `lines` should read. A 'ledger' is the two-column gold-chip form
   * (Nassau's per-bet breakdown); 'lines' is a plain list of money movements.
   * Carried explicitly rather than inferred from whether a label happens to be
   * non-empty — that would make an engine's label a layout switch by accident.
   */
  kind: 'ledger' | 'lines'
  /**
   * Empty means "No money moved."
   *
   * On a `'lines'` panel these ARE the settlement lines, so every one of them
   * moved money (enforced in replay.test.ts). A `'ledger'` panel is the game's
   * own bet breakdown instead, which deliberately lists bets that moved nothing
   * — a pushed Nassau bet still belongs in its ledger — so an all-push round
   * shows three "push" rows rather than "No money moved."
   */
  lines: { label: string; value: string; depth: number }[]
  /**
   * WHAT THIS GAME MOVED, per player — the tier that decomposes FINAL
   * STANDINGS (MAI-88).
   *
   * Without it a panel says who won each bet and never what it paid, so the
   * standings total is a number the reader cannot take apart. The round that
   * prompted this had a Nassau whose two nines cancelled and whose 18 pushed:
   * three bets listed as won, contributing exactly nothing, with nothing on the
   * card saying so.
   *
   * NON-ZERO ENTRIES ONLY, richest first, matching the standings' order.
   * EMPTY therefore means the game moved nothing at all — which the renderers
   * state in words (`ALL_SQUARE`) rather than as a row of "$0"s, the same
   * reasoning that keeps zero-cent rows out of `settlement.lines` (MAI-40).
   *
   * A derived display figure, deliberately separate from `lines`: on a
   * 'ledger' panel `lines` are bets (a push belongs there and moved nothing),
   * and on a 'lines' panel they are individual payments. Neither is a per-player
   * total.
   */
  money: MoneyRow[]
  /**
   * What the game has to say that isn't money — "3 skins died unwon". Rendered
   * apart from `lines` so a note can never be mistaken for a payout, and so
   * `lines` can keep its promise about what it contains.
   */
  notes: string[]
}

export interface MoneyRow {
  playerId: Uuid
  name: string
  cents: number
}

/** A game that settled to nothing, in words — see `GamePanel.money`. */
export const ALL_SQUARE = 'all square — nothing moved'

/**
 * The per-game money tier as one line, for renderers that lay out text rather
 * than elements.
 *
 * A NON-BREAKING SPACE joins each name to its amount, and ordinary spaces
 * surround the separators — so the line breaks BETWEEN players and never
 * between a player and their money. The painter word-wraps on spaces, and
 * "John" stranded above "+$10" would be worse than not showing the money at
 * all; `closeMargin` writes "2 up" with one for exactly this reason.
 */
export function moneyLine(money: readonly MoneyRow[]): string {
  if (money.length === 0) return ALL_SQUARE
  // THE PAIR is the unbreakable unit, so every space inside it becomes a
  // non-breaking one — not just the join. Half the players in a real round are
  // entered as "Ben Norman", and joining only name-to-amount left the wrap free
  // to break inside the NAME instead: "Ben" alone on one line, "Norman +$10" on
  // the next. Same stranded-token failure, one word earlier.
  //
  // Escaped rather than typed: a load-bearing invisible character is one a
  // later edit silently replaces with a plain space.
  const NBSP = '\u00A0'
  return money
    .map((m) => `${m.name} ${formatCentsSigned(m.cents)}`.replace(/ /g, NBSP))
    .join(' \u00B7 ')
}

/**
 * Per-player totals for one game, richest first. Zero entries are dropped: they
 * are what "this player was not involved" and "this player came out level" both
 * look like, and neither is worth a column on a shared card.
 *
 * Ties keep roster order, so two players sitting level cannot swap places
 * between re-derives.
 */
function moneyRowsFrom(
  perPlayerCents: Record<Uuid, number>,
  players: readonly { playerId: Uuid; name: string }[],
): MoneyRow[] {
  return players
    .map((p) => ({ playerId: p.playerId, name: p.name, cents: perPlayerCents[p.playerId] ?? 0 }))
    .filter((m) => m.cents !== 0)
    .sort((a, b) => b.cents - a.cents)
}

export interface ScorecardHalf {
  /** "1st time round" when the round is a nine played twice */
  title?: string
  holes: number[]
  pars: number[]
  parTotal: number
  rows: ScorecardRow[]
}

export interface ScorecardRow {
  playerId: Uuid
  name: string
  /** undefined = not scored */
  scores: (number | undefined)[]
  /** parallel to `scores`; true where the player gets a handicap stroke */
  strokes: boolean[]
  total: number
}

/**
 * Fold several side-bet panels into one, as a ledger: each game's name becomes
 * the gold chip beside its own money.
 *
 * Three things this deliberately does NOT do:
 *
 * - It never emits an empty `value`. A name-only header row would be the
 *   obvious layout, but `wrapText` returns `[]` for an empty string, so the
 *   painter reserves zero height for that row and draws the next line straight
 *   on top of it (paintSummaryCard.ts, `gameBlock`). The name rides the game's
 *   first line instead.
 * - It never merges `notes` into `lines`. `lines` is money that MOVED, and
 *   `lines.length === 0` is the "No money moved." signal — smuggling narration
 *   in is exactly what MAI-40 undid. Notes are prefixed with the game name
 *   instead, because in a grouped panel an unattributed note has no owner.
 * - It never drops a game. One that moved nothing says so on its own row rather
 *   than silently vanishing from the card.
 */
function groupSideBets(panels: readonly GamePanel[]): GamePanel {
  return {
    // key only — the panel represents several games, and nothing looks it up
    gameId: panels[0]!.gameId,
    name: 'Side bets',
    // `allowance` has one slot per panel but the games have one each, so it
    // moves onto each game's own chip. Left up here it would describe the first
    // side bet and quietly misdescribe the rest.
    kind: 'ledger',
    lines: panels.flatMap((p) => {
      const chip = p.allowance ? `${p.name} ${p.allowance}` : p.name
      if (p.lines.length === 0) return [{ label: chip, value: 'No money moved.', depth: 0 }]
      return p.lines.map((l, i) => ({
        label: i === 0 ? chip : '',
        // A side bet can ship its own ledger (a Nassau played as the side bet),
        // whose labels are F9/B9/18. The outer chip is spoken for by the game
        // name, so fold the inner one into the value rather than lose it.
        value: l.label ? `${l.label} · ${l.value}` : l.value,
        depth: l.depth,
      }))
    }),
    // The group's money is its members' summed, so the per-panel tier still
    // decomposes FINAL STANDINGS exactly when side bets are folded together.
    // Re-filtered after summing: a player up $5 in one side bet and down $5 in
    // another moved nothing overall, and a "$0" would be noise.
    money: sumMoney(panels),
    notes: panels.flatMap((p) => p.notes.map((n) => `${p.name}: ${n}`)),
  }
}

/** Per-player totals across several panels, richest first, non-zero only. */
function sumMoney(panels: readonly GamePanel[]): MoneyRow[] {
  const byPlayer = new Map<Uuid, MoneyRow>()
  for (const p of panels) {
    for (const m of p.money) {
      const seen = byPlayer.get(m.playerId)
      if (seen) seen.cents += m.cents
      else byPlayer.set(m.playerId, { ...m })
    }
  }
  // Insertion order is whatever the panels were built in — not roster order,
  // since each panel is already sorted by cents. It is DETERMINISTIC, though,
  // and `sort` is stable, so two players sitting level cannot swap places
  // between re-derives. That is the property this needs; roster order is not.
  return [...byPlayer.values()].filter((m) => m.cents !== 0).sort((a, b) => b.cents - a.cents)
}

export function buildSummaryCard(
  round: Round,
  ctx: RoundContext,
  derivations: ReadonlyMap<Uuid, GameDerivation>,
): SummaryCard {
  const nameOf = new Map(round.players.map((p) => [p.playerId, p.name]))
  const named = (id: Uuid) => nameOf.get(id) ?? '—'

  const combined = combineSettlements(
    round.players.map((p) => p.playerId),
    [...derivations.values()].map((d) => d.settlement),
  )

  const standings: StandingRow[] = [...round.players]
    .sort((a, b) => (combined[b.playerId] ?? 0) - (combined[a.playerId] ?? 0))
    .map((p, i) => ({
      playerId: p.playerId,
      name: p.name,
      cents: combined[p.playerId] ?? 0,
      leader: i === 0 && (combined[p.playerId] ?? 0) > 0,
    }))

  const settle: CollectorRow[] = collectorsFrom(minimalTransfers(combined)).map((c) => ({
    playerId: c.toPlayerId,
    name: named(c.toPlayerId),
    totalCents: c.totalCents,
    from: c.from.map((f) => ({
      playerId: f.fromPlayerId,
      name: named(f.fromPlayerId),
      cents: f.cents,
    })),
  }))

  const panelFor = (g: (typeof round.games)[number]): GamePanel[] => {
    const d = derivations.get(g.gameId)
    if (!d) return []
    // Nassau ships a per-bet ledger (F9/B9/18 + presses) — the complete
    // breakdown. Games without one fall back to their money lines.
    const ledger = d.detailLines !== undefined && d.detailLines.length > 0
    return [
      {
        gameId: g.gameId,
        name: gameLabel(g, round.games),
        allowance:
          g.handicap?.mode === 'net' && g.handicap.allowancePct !== 100
            ? `${g.handicap.allowancePct}%`
            : undefined,
        kind: ledger ? ('ledger' as const) : ('lines' as const),
        lines: ledger
          ? d.detailLines!.map((l) => ({ label: l.label, value: l.value, depth: l.depth ?? 0 }))
          : d.settlement.lines.map((l) => ({ label: '', value: l.label, depth: 0 })),
        // Off `perPlayerCents`, NOT off `lines`: a ledger's lines are bets
        // rather than payments, so summing them would miss a game entirely.
        money: moneyRowsFrom(d.settlement.perPlayerCents, round.players),
        notes: d.notes ?? [],
      },
    ]
  }

  // A round with a main game and several side bets renders one panel per game
  // on a card that is already tall — 5 games is 5 full-width panels, and the
  // 2× retina budget is finite (MAI-50). Grouping happens HERE, in the model,
  // so the settle screen and the painter cannot end up disagreeing about it;
  // both just render whatever panels they are handed.
  // Built ONCE, then partitioned — the ungrouped branch is every round with
  // fewer than two side bets, i.e. almost all of them, so rebuilding the panels
  // there repeated `gameLabel` and every line format for nothing.
  const order = new Map(round.games.map((g, i) => [g.gameId, i]))
  const { main, side } = partitionByRole(round.games)
  const mainPanels = main.flatMap(panelFor)
  const sidePanels = side.flatMap(panelFor)
  const games: GamePanel[] = shouldGroupSideBets({
    main: mainPanels.length,
    side: sidePanels.length,
  })
    ? [...mainPanels, groupSideBets(sidePanels)]
    : // Ungrouped, panels keep `round.games` order rather than main-then-side.
      // Re-sorting a two-game card would be a visible change nobody asked for.
      [...mainPanels, ...sidePanels].sort(
        (a, b) => (order.get(a.gameId) ?? 0) - (order.get(b.gameId) ?? 0),
      )

  // Underlines mark handicap strokes, which are a per-game allocation — pick the
  // game that actually allocates them and say which one, per the "explain WHY"
  // convention. One shared rule with the two scoring screens now (MAI-50); it
  // stays optional throughout, because a gross round allocates nothing and
  // `round.games` can be empty besides (an import may carry none, and only
  // setup enforces at least one).
  const strokes = strokeGame(round)
  const strokeNote = strokes
    ? `underline = handicap stroke: ${gameLabel(strokes, round.games)}`
    : undefined

  const half = (holes: number[]): ScorecardHalf | null => {
    if (holes.length === 0) return null
    const loop = holeLoop(round.courseSnapshot, holes[0]!)
    const pars = holes.map((h) => ctx.par(h))
    return {
      title: loop ? `${ordinal(loop.nth)} time round` : undefined,
      holes,
      pars,
      parTotal: pars.reduce((a, p) => a + p, 0),
      rows: round.players.map((p) => {
        const scores = holes.map((h) => ctx.gross.get(p.playerId)?.get(h))
        return {
          playerId: p.playerId,
          name: p.name,
          scores,
          strokes: holes.map((h) =>
            strokes ? ctx.strokesFor(strokes.gameId, p.playerId, h) > 0 : false,
          ),
          total: scores.reduce<number>((a, s) => a + (s ?? 0), 0),
        }
      }),
    }
  }

  const cards = [
    half(ctx.holesPlayed.filter((h) => h <= 9)),
    half(ctx.holesPlayed.filter((h) => h > 9)),
  ].filter((c): c is ScorecardHalf => c !== null)

  return {
    course: round.courseSnapshot.name,
    subtitle: `${ctx.holesPlayed.length} holes · ${formatDate(round.startedAt)}`,
    standings,
    settle,
    games,
    cards,
    strokeNote,
  }
}

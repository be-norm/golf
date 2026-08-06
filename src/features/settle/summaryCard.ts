import type { GameDerivation } from '../../engine/catalog'
import { gameLabel } from '../../engine/label'
import type { RoundContext } from '../../engine/core/context'
import {
  collectorsFrom,
  combineSettlements,
  minimalTransfers,
} from '../../engine/core/money'
import type { Round, Uuid } from '../../engine/core/types'
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
   * What the game has to say that isn't money — "3 skins died unwon". Rendered
   * apart from `lines` so a note can never be mistaken for a payout, and so
   * `lines` can keep its promise about what it contains.
   */
  notes: string[]
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Fixed format rather than toLocaleDateString — deterministic across locales and in tests. */
function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
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

  const games: GamePanel[] = round.games.flatMap((g) => {
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
          g.handicap.mode === 'net' && g.handicap.allowancePct !== 100
            ? `${g.handicap.allowancePct}%`
            : undefined,
        kind: ledger ? ('ledger' as const) : ('lines' as const),
        lines: ledger
          ? d.detailLines!.map((l) => ({ label: l.label, value: l.value, depth: l.depth ?? 0 }))
          : d.settlement.lines.map((l) => ({ label: '', value: l.label, depth: 0 })),
        notes: d.notes ?? [],
      },
    ]
  })

  // Underlines mark handicap strokes, which are a per-game allocation — pick the
  // game that actually allocates them and say which one, per the "explain WHY"
  // convention. `round.games` can be empty (an import may carry none, and only
  // setup enforces at least one), so this stays optional throughout.
  const strokeGame = round.games.find((g) => g.handicap.mode === 'net')
  const strokeNote = strokeGame
    ? `underline = handicap stroke (${gameLabel(strokeGame, round.games)})`
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
            strokeGame ? ctx.strokesFor(strokeGame.gameId, p.playerId, h) > 0 : false,
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

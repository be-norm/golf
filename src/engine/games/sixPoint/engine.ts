import { z } from 'zod'
import type { GameEngine, GameDerivation, StandingLine } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { addLine, emptySettlement, type Settlement } from '../../core/money'
import { firstName, joinNames, latestHoleSummary, summaryString } from '../../core/summary'
import type { GameConfig, HandicapSettings, RoundPlayer, Uuid } from '../../core/types'

export const sixPointConfigSchema = z.object({
  /** cents per point; a hole always splits 6 points across the three players */
  pointCents: z.number().int().positive(),
})

export type SixPointConfig = z.infer<typeof sixPointConfigSchema>

/** The four ways six points land, richest-first. */
export type SixPointSplit = '4-2-0' | '3-3-0' | '4-1-1' | '2-2-2'

export type SixPointHoleResult =
  | {
      hole: number
      kind: 'scored'
      /** points won this hole, per player (always sums to 6) */
      points: Record<Uuid, number>
      /** the score that ranked each player (net or gross per handicap policy) */
      scores: Record<Uuid, number>
      split: SixPointSplit
    }
  | { hole: number; kind: 'void' }
  | { hole: number; kind: 'pending' }

export interface SixPointDerivation extends GameDerivation {
  holeResults: SixPointHoleResult[]
}

/**
 * Rank slots for three players: best 4, middle 2, worst 0. Ties share the
 * average of the slots they span — the standard split-sixes tie rules fall out:
 *   distinct        → 4 · 2 · 0
 *   two tie for low → (4+2)/2 each → 3 · 3 · 0
 *   two tie for low being alone-best inverted, i.e. two tie for worst
 *                   → 4 · (2+0)/2 each → 4 · 1 · 1
 *   all three tie   → (4+2+0)/3 each → 2 · 2 · 2
 * With these slots every average is a whole number, so points stay integers.
 */
const SLOTS = [4, 2, 0]

function distribute(scored: { id: Uuid; score: number }[]): {
  points: Record<Uuid, number>
  split: SixPointSplit
} {
  const sorted = [...scored].sort((a, b) => a.score - b.score)
  const points: Record<Uuid, number> = {}
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && sorted[j]!.score === sorted[i]!.score) j++
    const span = SLOTS.slice(i, j)
    const avg = span.reduce((a, b) => a + b, 0) / span.length
    for (let k = i; k < j; k++) points[sorted[k]!.id] = avg
    i = j
  }
  const split = Object.values(points)
    .sort((a, b) => b - a)
    .join('-') as SixPointSplit
  return { points, split }
}

function derive(
  game: GameConfig<SixPointConfig>,
  _events: readonly GameScopedEvent[],
  ctx: RoundContext,
): SixPointDerivation {
  const { pointCents } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))
  const isNet = game.handicap.mode === 'net'

  const settlement: Settlement = emptySettlement(playerIds)
  const pointsByPlayer = new Map<Uuid, number>(playerIds.map((id) => [id, 0]))
  const holeResults: SixPointHoleResult[] = []

  // Order a hole's players richest-first (ties broken by lower score, then name).
  const orderByStanding = (points: Record<Uuid, number>, scores: Record<Uuid, number>) =>
    [...playerIds]
      .filter((id) => id in points)
      .sort(
        (a, b) =>
          points[b]! - points[a]! ||
          scores[a]! - scores[b]! ||
          (nameOf.get(a) ?? '').localeCompare(nameOf.get(b) ?? ''),
      )

  // "A 4 · B 1 · C 1" — the richest-first point distribution, used verbatim as
  // both the settle-screen ledger label and the holeSummary headline.
  const distLine = (points: Record<Uuid, number>, scores: Record<Uuid, number>) =>
    orderByStanding(points, scores)
      .map((id) => `${nameOf.get(id)} ${points[id]}`)
      .join(' · ')

  for (const hole of ctx.holesPlayed) {
    // The frontier hole being actively entered stays pending; no premature points.
    if (!ctx.finalized(hole)) {
      holeResults.push({ hole, kind: 'pending' })
      continue
    }
    // Six points always split three ways. The rank slots [4,2,0] and the
    // `points − 2` money math (2 = 6/3, the average) both encode the threesome
    // invariant, so zero-sum only holds with exactly three posted scores — any
    // other count (a missing score, or a mis-rostered game) is void: nobody's
    // number moves and the settlement stays balanced by construction.
    const scored = players
      .map((p) => ({ id: p.playerId, score: ctx.netFor(game.gameId, p.playerId, hole) }))
      .filter((s): s is { id: Uuid; score: number } => s.score !== null)
    if (scored.length !== SLOTS.length) {
      holeResults.push({ hole, kind: 'void' })
      continue
    }

    const { points, split } = distribute(scored)
    const scores = Object.fromEntries(scored.map((s) => [s.id, s.score]))
    for (const s of scored) pointsByPlayer.set(s.id, (pointsByPlayer.get(s.id) ?? 0) + points[s.id]!)
    holeResults.push({ hole, kind: 'scored', points, scores, split })

    // Money is zero-sum against the 2-point average: (points − 2) × stake sums
    // to zero across the three players for every split. 2-2-2 moves nothing.
    if (split !== '2-2-2') {
      // Label names who got what — the settle screen renders this line verbatim,
      // so the point distribution (which implies the split shape) must be here.
      addLine(settlement, {
        label: `Hole ${hole} — ${distLine(points, scores)}`,
        perPlayerCents: Object.fromEntries(
          scored.map((s) => [s.id, (points[s.id]! - 2) * pointCents]),
        ),
      })
    }
  }

  const standings: StandingLine[] = players
    .map((p) => {
      const pts = pointsByPlayer.get(p.playerId) ?? 0
      return {
        id: p.playerId,
        label: p.name,
        detail: `${pts} pt${pts === 1 ? '' : 's'}`,
        amountCents: settlement.perPlayerCents[p.playerId] ?? 0,
      }
    })
    .sort((a, b) => b.amountCents - a.amountCents)

  const orderScored = (r: Extract<SixPointHoleResult, { kind: 'scored' }>) =>
    orderByStanding(r.points, r.scores)

  // Bar recaps the latest decided hole — "H4 · Rob 4 · Al 2 · Ben 0".
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const r = holeResults.find((h) => h.hole === hole)
      if (!r || r.kind === 'pending') return null
      if (r.kind === 'void') return 'void — missing scores'
      return orderScored(r)
        .map((id) => `${firstName(nameOf.get(id))} ${r.points[id]}`)
        .join(' · ')
    },
    'no points yet',
  )

  // holeSummary states the split, then a "↳" line explaining WHY — the scores
  // that ranked the field, and which tie collapsed the points.
  const scoreWord = isNet ? 'nets' : 'scores'
  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r || r.kind === 'pending') return []
    if (r.kind === 'void') return ['Missing scores — hole void']
    const ordered = orderScored(r)
    const line = distLine(r.points, r.scores)
    const tiedAt = (pts: number) => ordered.filter((id) => r.points[id] === pts)
    const scoreTag = (id: Uuid) => (isNet ? `net ${r.scores[id]}` : `${r.scores[id]}`)
    switch (r.split) {
      case '4-2-0':
        return [line, `↳ ${scoreWord} ${ordered.map((id) => r.scores[id]).join(' · ')}`]
      case '3-3-0': {
        const tied = tiedAt(3)
        return [line, `↳ ${joinNames(tied, nameOf)} tied for low (${scoreTag(tied[0]!)}) — top two split 3-3`]
      }
      case '4-1-1': {
        const tied = tiedAt(1)
        return [line, `↳ ${joinNames(tied, nameOf)} tied (${scoreTag(tied[0]!)}) — bottom two split 1-1`]
      }
      case '2-2-2':
        return [line, `↳ three-way tie (${scoreTag(ordered[0]!)}) — 6 points split evenly`]
      default: {
        // Exhaustiveness: adding a SixPointSplit variant without a case fails to
        // compile here; at runtime, degrade to the distribution line, never undefined.
        const _exhaustive: never = r.split
        void _exhaustive
        return [line]
      }
    }
  }

  return {
    standings,
    summary: summaryString(summaryParts),
    summaryParts,
    holeSummary,
    requiredInputs: () => [],
    settlement,
    holeResults,
  }
}

export const sixPointEngine: GameEngine<SixPointConfig> = {
  type: 'sixPoint',
  meta: {
    name: 'Six Point',
    blurb: 'Threesomes only. Six points split every hole by score: 4 · 2 · 0.',
    minPlayers: 3,
    maxPlayers: 3,
    rules: {
      tagline: 'Six points per hole, split three ways by who scores lowest.',
      howToPlay: [
        'Built for a threesome. Every hole is worth six points, handed out by score: 4 to the lowest, 2 to the middle, 0 to the highest.',
        'Two tie for low? They split the top two prizes — 3 points each, 0 to the odd one out.',
        'One player alone lowest, the other two tied? The low player takes 4, the tied pair split the rest — 1 point each.',
        'All three tie? Everyone gets 2. Playing net, handicap strokes land on the hardest holes and the lowest net score wins the points.',
      ],
      scoring: [
        'Each point is worth the per-point stake. Your money on a hole is (points − 2) × stake, so the field is always zero-sum: +2 / 0 / −2 on a clean 4-2-0.',
        'A three-way tie (2-2-2) moves no money.',
        'A hole missing any of the three scores is void — six points need all three players.',
      ],
      terms: [
        { term: 'Split sixes', def: "The game's other name — six points divided among three players every hole." },
        { term: '4-2-0', def: 'The clean split: best score 4 points, middle 2, worst 0.' },
        { term: '3-3-0', def: 'Two tie for low and share the top two prizes (4+2), the third gets nothing.' },
        { term: '4-1-1', def: 'One player lowest takes 4; the other two tie and split the remaining 2.' },
        { term: 'Net / Gross', def: 'Net is your score minus handicap strokes; gross is raw strokes.' },
      ],
    },
  },
  configSchema: sixPointConfigSchema,
  configFields: [{ key: 'pointCents', kind: 'money', label: 'Per point' }],
  defaultConfig: () => ({ pointCents: 25 }),
  defaultHandicap: (): HandicapSettings => ({ mode: 'net', allowancePct: 100, reference: 'offLow' }),
  validateSetup: (config: GameConfig<SixPointConfig>, players: readonly RoundPlayer[]) => {
    const problems: string[] = []
    if (players.length !== 3) problems.push('Six Point is a threesome game — exactly 3 players')
    const parsed = sixPointConfigSchema.safeParse(config.config)
    if (!parsed.success) problems.push('Invalid six point configuration')
    return problems
  },
  eventKinds: {},
  derive,
}

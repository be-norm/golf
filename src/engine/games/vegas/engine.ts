import { z } from 'zod'
import type { GameEngine, GameDerivation, StandingLine } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { addLine, emptySettlement, formatCentsSigned, type Settlement } from '../../core/money'
import type { GameConfig, HandicapSettings, RoundPlayer } from '../../core/types'

export const vegasConfigSchema = z.object({
  /** cents per point of team-number differential */
  pointCents: z.number().int().positive(),
  teams: z.object({ a: z.array(z.string()), b: z.array(z.string()) }),
  /** a natural (gross) birdie flips the OPPONENTS' number high-digit-first */
  birdieFlip: z.boolean(),
  /** a natural eagle also doubles the hole's differential */
  eagleDouble: z.boolean(),
})

export type VegasConfig = z.infer<typeof vegasConfigSchema>

function concatNum(first: number, second: number): number {
  return Number(`${first}${second}`)
}

/** Normal pairing: low digit first — except a 10+ score leads (softens blowups). */
export function pairNormal(x: number, y: number): number {
  const lo = Math.min(x, y)
  const hi = Math.max(x, y)
  return hi >= 10 ? concatNum(hi, lo) : concatNum(lo, hi)
}

/** Flipped pairing (opponent birdied): high digit first — a 10+ score punishes fully. */
export function pairFlipped(x: number, y: number): number {
  const lo = Math.min(x, y)
  const hi = Math.max(x, y)
  return hi >= 10 ? concatNum(lo, hi) : concatNum(hi, lo)
}

export interface VegasHoleResult {
  hole: number
  numA: number
  numB: number
  diff: number
  /** signed points from team A's perspective */
  pointsA: number
  doubled: boolean
  flipped: 'a' | 'b' | null
}

function derive(
  game: GameConfig<VegasConfig>,
  _events: readonly GameScopedEvent[],
  ctx: RoundContext,
): GameDerivation {
  const { pointCents, teams, birdieFlip, eagleDouble } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  const settlement: Settlement = emptySettlement(playerIds)
  const holeResults: VegasHoleResult[] = []
  let totalA = 0

  for (const hole of ctx.holesPlayed) {
    const nets: Record<'a' | 'b', number[]> = { a: [], b: [] }
    const grossDiffs: Record<'a' | 'b', number[]> = { a: [], b: [] }
    let missing = false
    for (const side of ['a', 'b'] as const) {
      for (const id of teams[side]) {
        const net = ctx.netFor(game.gameId, id, hole)
        const gross = ctx.gross.get(id)?.get(hole)
        if (net === null || gross === undefined) {
          missing = true
          break
        }
        nets[side].push(net)
        grossDiffs[side].push(gross - ctx.par(hole))
      }
    }
    if (missing) continue

    // flips key off NATURAL (gross) birdies/eagles even in net games
    const bird = (side: 'a' | 'b') => grossDiffs[side].some((d) => d <= -1)
    const eagle = (side: 'a' | 'b') => grossDiffs[side].some((d) => d <= -2)
    const flipB = birdieFlip && bird('a') && !bird('b')
    const flipA = birdieFlip && bird('b') && !bird('a')
    const doubled = eagleDouble && eagle('a') !== eagle('b')

    const numA = flipA ? pairFlipped(nets.a[0]!, nets.a[1]!) : pairNormal(nets.a[0]!, nets.a[1]!)
    const numB = flipB ? pairFlipped(nets.b[0]!, nets.b[1]!) : pairNormal(nets.b[0]!, nets.b[1]!)
    const diff = Math.abs(numA - numB) * (doubled ? 2 : 1)
    const pointsA = numA < numB ? diff : numA > numB ? -diff : 0
    totalA += pointsA
    holeResults.push({
      hole,
      numA,
      numB,
      diff,
      pointsA,
      doubled,
      flipped: flipA ? 'a' : flipB ? 'b' : null,
    })

    if (pointsA !== 0) {
      const winners = pointsA > 0 ? teams.a : teams.b
      const losers = pointsA > 0 ? teams.b : teams.a
      const cents = Math.abs(pointsA) * pointCents
      addLine(settlement, {
        label: `Hole ${hole} — ${numA} vs ${numB}${doubled ? ' ×2' : ''}${
          holeResults[holeResults.length - 1]!.flipped ? ' (flipped)' : ''
        }`,
        perPlayerCents: Object.fromEntries([
          ...winners.map((id) => [id, cents] as const),
          ...losers.map((id) => [id, -cents] as const),
        ]),
      })
    }
  }

  const teamLabel = (side: 'a' | 'b') => teams[side].map((id) => nameOf.get(id)).join(' & ')

  const standings: StandingLine[] = players
    .map((p) => {
      const onA = teams.a.includes(p.playerId)
      return {
        id: p.playerId,
        label: p.name,
        detail: `${onA ? teamLabel('a') : teamLabel('b')}${onA ? (totalA >= 0 ? ` +${totalA}` : ` ${totalA}`) : totalA <= 0 ? ` +${-totalA}` : ` ${-totalA}`} pts`,
        amountCents: settlement.perPlayerCents[p.playerId] ?? 0,
      }
    })
    .sort((a, b) => b.amountCents - a.amountCents)

  const summary =
    totalA === 0
      ? 'all square'
      : `${teamLabel(totalA > 0 ? 'a' : 'b')} ${formatCentsSigned(Math.abs(totalA) * pointCents)}`

  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r) return []
    const flipNote = r.flipped ? ` — flipped ${teamLabel(r.flipped)}` : ''
    const doubleNote = r.doubled ? ' — eagle ×2' : ''
    if (r.pointsA === 0) return [`${r.numA} vs ${r.numB} — push${flipNote}`]
    return [
      `${r.numA} vs ${r.numB}${flipNote}${doubleNote} → ${teamLabel(r.pointsA > 0 ? 'a' : 'b')} +${Math.abs(r.pointsA)}`,
    ]
  }

  return {
    standings,
    summary,
    holeSummary,
    requiredInputs: () => [],
    settlement,
  }
}

export const vegasEngine: GameEngine<VegasConfig> = {
  type: 'vegas',
  meta: {
    name: 'Vegas',
    blurb: 'Pair up. Team scores combine into one number — birdies flip the other side.',
    minPlayers: 4,
    maxPlayers: 4,
    rules: {
      tagline: "Two teams, one number each. Birdies flip the other side's digits.",
      howToPlay: [
        "2 v 2. Each hole, teammates' scores pair into one number, low digit first: a 4 and a 5 make 45.",
        'Low team number wins the difference in points: 45 vs 62 is 17 points.',
        "A natural birdie flips the OPPONENTS' number high-digit-first — their 47 becomes 74. If both teams birdie, the flips cancel.",
        'An eagle also doubles the points on the hole. A score of 10+ goes in front (a 4 and a 10 make 104) to soften the blowup.',
      ],
      scoring: [
        'Every decided hole moves points × the per-point stake for each player; equal numbers push.',
        'Net vegas applies handicap strokes before pairing — but flips still key off natural (gross) birdies.',
      ],
      terms: [
        { term: 'Team number', def: "Both teammates' scores glued into one number, low digit first." },
        {
          term: 'Flip the bird',
          def: "A natural birdie reversing the opponents' digits to high-first — the punishment for getting birdied.",
        },
        { term: 'Natural', def: 'A gross score — before any handicap strokes.' },
        { term: 'Push', def: 'Equal team numbers — no points move.' },
      ],
    },
  },
  configSchema: vegasConfigSchema,
  configFields: [
    { key: 'pointCents', kind: 'money', label: 'Per point' },
    { key: 'teams', kind: 'teams', label: 'Teams' },
    { key: 'birdieFlip', kind: 'boolean', label: 'Birdie flip', hint: 'Gross birdie flips opponents' },
    { key: 'eagleDouble', kind: 'boolean', label: 'Eagle doubles', hint: 'Eagle doubles the hole' },
  ],
  defaultConfig: (players) => ({
    pointCents: 10,
    teams: {
      a: players.slice(0, 2).map((p) => p.playerId),
      b: players.slice(2, 4).map((p) => p.playerId),
    },
    birdieFlip: true,
    eagleDouble: true,
  }),
  defaultHandicap: (): HandicapSettings => ({ mode: 'net', allowancePct: 100, reference: 'offLow' }),
  validateSetup: (config: GameConfig<VegasConfig>, players: readonly RoundPlayer[]) => {
    if (players.length !== 4) return ['Vegas needs exactly 4 players']
    const parsed = vegasConfigSchema.safeParse(config.config)
    if (!parsed.success) return ['Invalid vegas configuration']
    const { teams } = parsed.data
    const all = [...teams.a, ...teams.b].sort()
    const expected = players.map((p) => p.playerId).sort()
    if (teams.a.length !== 2 || teams.b.length !== 2) return ['Vegas teams need 2 players per side']
    if (JSON.stringify(all) !== JSON.stringify(expected))
      return ['Every player must be on exactly one vegas team']
    return []
  },
  eventKinds: {},
  derive,
}

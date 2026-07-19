import { z } from 'zod'
import type { GameEngine, GameDerivation, InputRequest, StandingLine } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { addLine, emptySettlement, type Settlement } from '../../core/money'
import type { GameConfig, HandicapSettings, RoundPlayer, Uuid } from '../../core/types'

export const nassauConfigSchema = z.object({
  /** per-player stake on each bet (front, back, overall, and every press) */
  stakeCents: z.number().int().positive(),
  /** null = 1v1 (first two players); otherwise 2v2 best ball */
  teams: z.object({ a: z.array(z.string()), b: z.array(z.string()) }).nullable(),
  /** spawn a press automatically whenever a live bet goes exactly 2 down */
  autoPress: z.boolean(),
})

export type NassauConfig = z.infer<typeof nassauConfigSchema>

type Segment = 'front' | 'back' | 'overall'

interface Bet {
  id: string
  segment: Segment
  /** first hole this bet scores (press start) */
  startHole: number
  label: string
  /** press depth: 0 = original bet */
  depth: number
  /** running diff from side A's perspective, over scored holes */
  diff: number
  holesRemaining: number
}

const SEGMENT_LABEL: Record<Segment, string> = { front: 'Front', back: 'Back', overall: 'Overall' }

function segmentHoles(segment: Segment, holesPlayed: readonly number[]): number[] {
  // 9-hole rounds collapse to a single 'overall' bet
  if (holesPlayed.length <= 9) return segment === 'overall' ? [...holesPlayed] : []
  if (segment === 'front') return holesPlayed.filter((h) => h <= 9)
  if (segment === 'back') return holesPlayed.filter((h) => h > 9)
  return [...holesPlayed]
}

function derive(
  game: GameConfig<NassauConfig>,
  events: readonly GameScopedEvent[],
  ctx: RoundContext,
): GameDerivation {
  const { stakeCents, autoPress } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  const sideA: Uuid[] = game.config.teams ? game.config.teams.a : [playerIds[0]!]
  const sideB: Uuid[] = game.config.teams ? game.config.teams.b : [playerIds[1]!]

  /** best net ball among the side's POSTED scores, or null if nobody posted */
  const bestBall = (side: Uuid[], hole: number): number | null => {
    let best: number | null = null
    for (const id of side) {
      const net = ctx.netFor(game.gameId, id, hole)
      if (net !== null && (best === null || net < best)) best = net
    }
    return best
  }

  /** +1 side A, -1 side B, 0 halved, null not yet finalized */
  const holeResult = new Map<number, 1 | -1 | 0 | null>()
  for (const hole of ctx.holesPlayed) {
    if (!ctx.finalized(hole)) {
      holeResult.set(hole, null)
      continue
    }
    const a = bestBall(sideA, hole)
    const b = bestBall(sideB, hole)
    // a side with no posted score can't win the hole; neither side → halved
    if (a === null && b === null) holeResult.set(hole, 0)
    else if (b === null) holeResult.set(hole, 1)
    else if (a === null) holeResult.set(hole, -1)
    else holeResult.set(hole, a < b ? 1 : b < a ? -1 : 0)
  }

  const manualPresses = events
    .filter((e) => e.kind === 'nassau/press')
    .map((e) => e.data as { hole: number; segment: Segment })

  // Walk holes in order; each bet accumulates over its own span. Auto-presses
  // spawn when a bet's diff transitions into exactly ±2 (from a smaller gap),
  // starting the NEXT hole of the same segment (never past the segment's end).
  const bets: Bet[] = (['front', 'back', 'overall'] as const)
    .filter((seg) => segmentHoles(seg, ctx.holesPlayed).length > 0)
    .map((seg) => ({
      id: seg,
      segment: seg,
      startHole: segmentHoles(seg, ctx.holesPlayed)[0]!,
      label: SEGMENT_LABEL[seg],
      depth: 0,
      diff: 0,
      holesRemaining: 0,
    }))

  for (const press of manualPresses) {
    const holes = segmentHoles(press.segment, ctx.holesPlayed)
    if (!holes.includes(press.hole)) continue
    bets.push({
      id: `press-${press.segment}-${press.hole}`,
      segment: press.segment,
      startHole: press.hole,
      label: `Press ${SEGMENT_LABEL[press.segment]} @${press.hole}`,
      depth: 1,
      diff: 0,
      holesRemaining: 0,
    })
  }

  for (const hole of ctx.holesPlayed) {
    const result = holeResult.get(hole)
    if (result === null || result === undefined) continue
    // snapshot: presses spawned this hole start scoring NEXT hole
    const active = bets.filter((b) => {
      const span = segmentHoles(b.segment, ctx.holesPlayed)
      return span.includes(hole) && hole >= b.startHole
    })
    for (const bet of active) {
      const prev = bet.diff
      bet.diff += result
      if (
        autoPress &&
        Math.abs(bet.diff) === 2 &&
        Math.abs(prev) < 2 &&
        segmentHoles(bet.segment, ctx.holesPlayed).some((h) => h > hole)
      ) {
        const nextHole = segmentHoles(bet.segment, ctx.holesPlayed).find((h) => h > hole)!
        bets.push({
          id: `auto-${bet.id}-@${nextHole}`,
          segment: bet.segment,
          startHole: nextHole,
          label: `Press ${SEGMENT_LABEL[bet.segment]} @${nextHole}`,
          depth: bet.depth + 1,
          diff: 0,
          holesRemaining: 0,
        })
      }
    }
  }

  for (const bet of bets) {
    const span = segmentHoles(bet.segment, ctx.holesPlayed).filter((h) => h >= bet.startHole)
    bet.holesRemaining = span.filter((h) => (holeResult.get(h) ?? null) === null).length
  }

  // Money is LOCKED-ONLY: a bet pays when its holes run out (holesRemaining 0
  // — round completion finalizes empty holes, so finishing closes everything).
  // Mid-round a flipped lead moves no money, matching how golfers think.
  const isClosed = (b: Bet) => b.holesRemaining === 0
  const settlement: Settlement = emptySettlement(playerIds)
  for (const bet of bets) {
    if (!isClosed(bet) || bet.diff === 0) continue
    const winners = bet.diff > 0 ? sideA : sideB
    const losers = bet.diff > 0 ? sideB : sideA
    addLine(settlement, {
      label: `${bet.label} — ${winners.map((id) => nameOf.get(id)).join(' & ')} win ↑${Math.abs(bet.diff)}`,
      perPlayerCents: Object.fromEntries([
        ...winners.map((id) => [id, stakeCents] as const),
        ...losers.map((id) => [id, -stakeCents] as const),
      ]),
    })
  }

  const statusFor = (side: 'a' | 'b'): string =>
    bets
      .filter((b) => b.depth === 0)
      .map((b) => {
        const d = side === 'a' ? b.diff : -b.diff
        const seg = b.segment === 'overall' ? '18' : b.segment === 'front' ? 'F9' : 'B9'
        return `${seg} ${d > 0 ? `↑${d}` : d < 0 ? `↓${-d}` : 'AS'}`
      })
      .join(' · ')

  const standings: StandingLine[] = players
    .map((p) => ({
      id: p.playerId,
      label: p.name,
      detail: statusFor(sideA.includes(p.playerId) ? 'a' : 'b'),
      amountCents: settlement.perPlayerCents[p.playerId] ?? 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents)

  // Every bet — parents and presses — reported the way a golfer tracks it:
  // who's up, by how much, holes left; dormie/closed-out/final when apt.
  const firstName = (id: Uuid) => (nameOf.get(id) ?? '').split(' ')[0]
  const sideShort = (side: 'a' | 'b') =>
    (side === 'a' ? sideA : sideB).map(firstName).join(' & ')
  const segLabel = (seg: Segment): string =>
    // a collapsed 9-hole nassau's single bet is the nine that was played
    seg === 'overall'
      ? ctx.holesPlayed.length <= 9
        ? ctx.round.holes === 'back9'
          ? 'B9'
          : 'F9'
        : '18'
      : seg === 'front'
        ? 'F9'
        : 'B9'
  const betLabel = (b: Bet): string =>
    b.depth === 0 ? segLabel(b.segment) : `Press @${b.startHole}`
  const betValue = (b: Bet): string => {
    const n = Math.abs(b.diff)
    const leader = b.diff === 0 ? null : sideShort(b.diff > 0 ? 'a' : 'b')
    if (b.holesRemaining === 0) return leader ? `${leader} wins ↑${n}` : 'push'
    if (leader && n > b.holesRemaining) return `${leader} ↑${n} · closed out`
    if (leader && n === b.holesRemaining) return `${leader} ↑${n} · dormie`
    const status = leader ? `${leader} ↑${n}` : 'AS'
    return `${status} · ${b.holesRemaining} to play`
  }

  // play order: each nine's bet followed by its presses, overall last
  const ordered = (['front', 'back', 'overall'] as const).flatMap((seg) =>
    bets
      .filter((b) => b.segment === seg)
      .sort((a, b) => a.depth - b.depth || a.startHole - b.startHole),
  )
  const detailLines = ordered.map((b) => ({
    label: betLabel(b),
    value: betValue(b),
    depth: b.depth > 0 ? 1 : 0,
  }))

  // Pinned bar has a hard height budget: parent bets in compact form plus a
  // live-press count chip. The full ledger (to play / dormie / presses) is
  // one tap away in the sheet — glanceability beats completeness here.
  const compactValue = (b: Bet): string => {
    const n = Math.abs(b.diff)
    const leader = b.diff === 0 ? null : sideShort(b.diff > 0 ? 'a' : 'b')
    if (b.holesRemaining === 0) return leader ? `${leader} wins ↑${n}` : 'push'
    return leader ? `${leader} ↑${n}` : 'AS'
  }
  const parents = ordered.filter((b) => b.depth === 0)
  const livePresses = ordered.filter((b) => b.depth > 0 && b.holesRemaining > 0).length
  const summaryParts =
    parents.length === 1
      ? parents.map((b) => ({ label: betLabel(b), value: betValue(b) }))
      : parents.map((b) => ({ label: betLabel(b), value: compactValue(b) }))
  if (livePresses > 0) summaryParts.push({ label: 'presses', value: String(livePresses) })
  const summary = summaryParts
    .map((p) => (p.label === 'presses' ? `${p.value} press${p.value === '1' ? '' : 'es'}` : `${p.label}: ${p.value}`))
    .join(' · ')

  // Manual-press affordance: on the active frontier hole, a side that is down
  // in a live bet may press (optional chip — never blocks scoring).
  const requiredInputs = (): InputRequest[] => {
    if (autoPress) return []
    const frontier = ctx.holesPlayed.find((h) => holeResult.get(h) === null)
    if (frontier === undefined) return []
    const pressable = bets.filter((b) => {
      const span = segmentHoles(b.segment, ctx.holesPlayed)
      return b.diff !== 0 && span.includes(frontier) && frontier > b.startHole
    })
    if (pressable.length === 0) return []
    return [
      {
        id: `nassau-press-${frontier}`,
        gameId: game.gameId,
        hole: frontier,
        prompt: 'Press?',
        optional: true,
        options: pressable.map((b) => ({
          value: b.segment,
          label: `Press ${SEGMENT_LABEL[b.segment]}`,
        })),
        eventKind: 'nassau/press',
      },
    ]
  }

  // Per-hole narration for the money ledger: who won the hole, how the bet
  // scores moved, presses starting, bets closing. Money only rides on closes.
  const holeNotes = new Map<number, string[]>()
  const note = (h: number, s: string) => {
    if (!holeNotes.has(h)) holeNotes.set(h, [])
    holeNotes.get(h)!.push(s)
  }
  {
    const running = new Map<string, number>()
    for (const h of ctx.holesPlayed) {
      for (const b of bets) {
        if (b.depth > 0 && b.startHole === h) note(h, `${betLabel(b)} starts`)
      }
      const r = holeResult.get(h)
      if (r === null || r === undefined || r === 0) continue
      const states: string[] = []
      for (const b of ordered) {
        const span = segmentHoles(b.segment, ctx.holesPlayed)
        if (!span.includes(h) || h < b.startHole) continue
        const d = (running.get(b.id) ?? 0) + r
        running.set(b.id, d)
        if (b.depth === 0) {
          states.push(`${betLabel(b)} ${d === 0 ? 'AS' : `${sideShort(d > 0 ? 'a' : 'b')} ↑${Math.abs(d)}`}`)
        }
      }
      if (states.length > 0) note(h, states.join(' · '))
    }
    for (const b of ordered) {
      if (!isClosed(b)) continue
      const span = segmentHoles(b.segment, ctx.holesPlayed).filter((x) => x >= b.startHole)
      const closeAt = span[span.length - 1]
      if (closeAt !== undefined) note(closeAt, `${betLabel(b)} closes — ${betValue(b)}`)
    }
  }

  const holeSummary = (hole: number): string[] => {
    const r = holeResult.get(hole)
    if (r === null || r === undefined) return []
    const notes = holeNotes.get(hole) ?? []
    // an unplayed hole finalized by round completion carries only its notes
    const played = playerIds.some((id) => ctx.gross.get(id)?.get(hole) !== undefined)
    if (!played) return notes
    const side = r === 1 ? sideA : r === -1 ? sideB : null
    const winnerLine = side
      ? `${side.map((id) => nameOf.get(id)).join(' & ')} ${side.length > 1 ? 'win' : 'wins'} the hole`
      : 'Halved'
    return [winnerLine, ...notes]
  }

  return {
    standings,
    summary,
    summaryParts,
    detailLines,
    holeSummary,
    requiredInputs,
    settlement,
  }
}

export const nassauEngine: GameEngine<NassauConfig> = {
  type: 'nassau',
  meta: {
    name: 'Nassau',
    blurb: 'Three match-play bets: front nine, back nine, overall. Press when down.',
    minPlayers: 2,
    maxPlayers: 4,
    rules: {
      tagline: 'Three bets in one round: the front nine, the back nine, and the overall.',
      howToPlay: [
        'Match play: each hole is won, lost, or halved. Lowest net score takes the hole — in 2v2, only the better ball of each team counts.',
        'The front nine, back nine, and full 18 run as three separate bets at the same stake. A hole feeds its nine AND the overall.',
        'Fall 2 down on any bet and a press starts (automatic if auto-press is on): a fresh bet at the same stake from the next hole to the end of that segment. Presses can themselves be pressed.',
        'A 9-hole round collapses to a single overall bet.',
      ],
      scoring: [
        'When a bet runs out of holes, whoever is up wins its stake; a tied bet pushes.',
        'Every player pays or collects the stake — a $5 bet swings $5 per player, in singles or 2v2.',
        'A hole where only one side posts a score goes to that side; no scores at all halves it.',
      ],
      terms: [
        {
          term: 'Press',
          def: "A new same-stake bet started when a side is 2 down, running from the next hole to the end of the original bet's stretch.",
        },
        { term: 'Auto-press', def: 'A press that starts itself the moment any live bet hits 2 down.' },
        { term: 'Halve', def: 'A tied hole — nobody gains ground on any bet.' },
        { term: 'All square (AS)', def: 'A bet where neither side is up.' },
        { term: 'Push', def: 'A bet that ends tied — no money moves.' },
        { term: 'Best ball', def: "In 2v2, each team counts only its lower score on a hole." },
      ],
    },
  },
  configSchema: nassauConfigSchema,
  configFields: [
    { key: 'stakeCents', kind: 'money', label: 'Stake per bet' },
    { key: 'autoPress', kind: 'boolean', label: 'Auto-press', hint: 'New press at 2 down' },
    { key: 'teams', kind: 'teams', label: 'Teams (2v2 best ball)' },
  ],
  defaultConfig: (players) => ({
    stakeCents: 500,
    teams:
      players.length === 4
        ? {
            a: [players[0]!.playerId, players[1]!.playerId],
            b: [players[2]!.playerId, players[3]!.playerId],
          }
        : null,
    autoPress: true,
  }),
  defaultHandicap: (): HandicapSettings => ({ mode: 'net', allowancePct: 100, reference: 'offLow' }),
  validateSetup: (config: GameConfig<NassauConfig>, players: readonly RoundPlayer[]) => {
    const problems: string[] = []
    const parsed = nassauConfigSchema.safeParse(config.config)
    if (!parsed.success) return ['Invalid nassau configuration']
    const teams = parsed.data.teams
    if (teams === null) {
      if (players.length !== 2) problems.push('Nassau without teams needs exactly 2 players')
    } else {
      const all = [...teams.a, ...teams.b].sort()
      const expected = players.map((p) => p.playerId).sort()
      if (teams.a.length !== 2 || teams.b.length !== 2)
        problems.push('Nassau teams need 2 players per side')
      else if (JSON.stringify(all) !== JSON.stringify(expected))
        problems.push('Every player must be on exactly one nassau team')
    }
    return problems
  },
  eventKinds: {
    'nassau/press': z.object({
      hole: z.number().int().min(1).max(18),
      // scoring UI answers prompts with { hole, choice }
      choice: z.enum(['front', 'back', 'overall']).optional(),
      segment: z.enum(['front', 'back', 'overall']).optional(),
    }),
  },
  derive: (game, events, ctx) =>
    derive(
      game,
      events.map((e) => {
        // normalize prompt answers ({hole, choice}) to {hole, segment}
        const data = e.data as { hole: number; choice?: Segment; segment?: Segment }
        return { ...e, data: { hole: data.hole, segment: data.segment ?? data.choice } }
      }),
      ctx,
    ),
}

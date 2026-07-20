import { z } from 'zod'
import type { GameEngine, GameDerivation, InputRequest, StandingLine } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { addLine, emptySettlement, type Settlement } from '../../core/money'
import { teamsSchema, teamPartitionProblems } from '../../core/teams'
import type { GameConfig, HandicapSettings, RoundPlayer, Uuid } from '../../core/types'

export const nassauConfigSchema = z.object({
  /** per-player stake on each bet (front, back, overall, and every press) */
  stakeCents: z.number().int().positive(),
  /** null = 1v1 (first two players); otherwise 2v2 best ball */
  teams: teamsSchema.nullable(),
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
  /** diff after each decided hole, recorded during the single accumulation walk */
  history: Map<number, number>
  holesRemaining: number
}

const SEGMENT_LABEL: Record<Segment, string> = { front: 'Front', back: 'Back', overall: 'Overall' }

function computeSpans(holesPlayed: readonly number[]): Record<Segment, number[]> {
  // 9-hole rounds collapse to a single 'overall' bet
  if (holesPlayed.length <= 9) {
    return { front: [], back: [], overall: [...holesPlayed] }
  }
  return {
    front: holesPlayed.filter((h) => h <= 9),
    back: holesPlayed.filter((h) => h > 9),
    overall: [...holesPlayed],
  }
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
  const spans = computeSpans(ctx.holesPlayed)

  const sideA: Uuid[] = game.config.teams ? game.config.teams.a : [playerIds[0]!]
  const sideB: Uuid[] = game.config.teams ? game.config.teams.b : [playerIds[1]!]

  /** +1 side A, -1 side B, 0 halved, null not yet finalized */
  const holeResult = new Map<number, 1 | -1 | 0 | null>()
  for (const hole of ctx.holesPlayed) {
    if (!ctx.finalized(hole)) {
      holeResult.set(hole, null)
      continue
    }
    const a = ctx.bestNetAmongPosted(game.gameId, sideA, hole)
    const b = ctx.bestNetAmongPosted(game.gameId, sideB, hole)
    // a side with no posted score can't win the hole; neither side → halved
    if (a === null && b === null) holeResult.set(hole, 0)
    else if (b === null) holeResult.set(hole, 1)
    else if (a === null) holeResult.set(hole, -1)
    else holeResult.set(hole, a < b ? 1 : b < a ? -1 : 0)
  }

  // Manual presses dedupe by segment+hole: tapping the offer twice (or a
  // re-imported duplicate event) must not create a double-stake bet.
  const manualPresses = new Map<string, { hole: number; segment: Segment }>()
  for (const e of events) {
    if (e.kind !== 'nassau/press') continue
    const data = e.data as { hole: number; segment: Segment }
    manualPresses.set(`${data.segment}-${data.hole}`, data)
  }

  const bets: Bet[] = (['front', 'back', 'overall'] as const)
    .filter((seg) => spans[seg].length > 0)
    .map((seg) => ({
      id: seg,
      segment: seg,
      startHole: spans[seg][0]!,
      label: SEGMENT_LABEL[seg],
      depth: 0,
      diff: 0,
      history: new Map(),
      holesRemaining: 0,
    }))

  for (const press of manualPresses.values()) {
    if (!spans[press.segment].includes(press.hole)) continue
    bets.push({
      id: `press-${press.segment}-${press.hole}`,
      segment: press.segment,
      startHole: press.hole,
      label: `Press ${SEGMENT_LABEL[press.segment]} @${press.hole}`,
      depth: 1,
      diff: 0,
      history: new Map(),
      holesRemaining: 0,
    })
  }

  // Single accumulation walk. Auto-presses spawn when a bet's diff transitions
  // into exactly ±2 (from a smaller gap), starting the NEXT hole of the same
  // segment (never past the segment's end). Presses spawned this hole don't
  // score it — the `active` snapshot is taken before spawning.
  for (const hole of ctx.holesPlayed) {
    const result = holeResult.get(hole)
    if (result === null || result === undefined) continue
    const active = bets.filter((b) => spans[b.segment].includes(hole) && hole >= b.startHole)
    for (const bet of active) {
      const prev = bet.diff
      bet.diff += result
      bet.history.set(hole, bet.diff)
      if (
        autoPress &&
        Math.abs(bet.diff) === 2 &&
        Math.abs(prev) < 2 &&
        spans[bet.segment].some((h) => h > hole)
      ) {
        const nextHole = spans[bet.segment].find((h) => h > hole)!
        bets.push({
          id: `auto-${bet.id}-@${nextHole}`,
          segment: bet.segment,
          startHole: nextHole,
          label: `Press ${SEGMENT_LABEL[bet.segment]} @${nextHole}`,
          depth: bet.depth + 1,
          diff: 0,
          history: new Map(),
          holesRemaining: 0,
        })
      }
    }
  }

  for (const bet of bets) {
    bet.holesRemaining = spans[bet.segment].filter(
      (h) => h >= bet.startHole && (holeResult.get(h) ?? null) === null,
    ).length
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
  const sideShort = (side: 'a' | 'b') => (side === 'a' ? sideA : sideB).map(firstName).join(' & ')
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
  const betLabel = (b: Bet): string => (b.depth === 0 ? segLabel(b.segment) : `Press @${b.startHole}`)
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
    .map((p) =>
      p.label === 'presses' ? `${p.value} press${p.value === '1' ? '' : 'es'}` : `${p.label}: ${p.value}`,
    )
    .join(' · ')

  // Manual-press affordance: on the active frontier hole, a side that is down
  // in a live bet may press (optional chip — never blocks scoring). Segments
  // already pressed at this hole are not offered again.
  const requiredInputs = (): InputRequest[] => {
    if (autoPress) return []
    const frontier = ctx.holesPlayed.find((h) => holeResult.get(h) === null)
    if (frontier === undefined) return []
    const pressable = bets.filter(
      (b) =>
        b.diff !== 0 &&
        spans[b.segment].includes(frontier) &&
        frontier > b.startHole &&
        !manualPresses.has(`${b.segment}-${frontier}`),
    )
    if (pressable.length === 0) return []
    const segments = [...new Set(pressable.map((b) => b.segment))]
    return [
      {
        id: `nassau-press-${frontier}`,
        gameId: game.gameId,
        hole: frontier,
        prompt: 'Press?',
        optional: true,
        options: segments.map((seg) => ({ value: seg, label: `Press ${SEGMENT_LABEL[seg]}` })),
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
  for (const h of ctx.holesPlayed) {
    for (const b of bets) {
      if (b.depth > 0 && b.startHole === h) {
        // explain WHY the press exists: auto-presses fire at 2 down, manual
        // presses are the trailing side choosing to double down
        const why = b.id.startsWith('auto-') ? '2 down → auto-press' : 'trailing side pressed'
        note(h, `${betLabel(b)} starts (${why})`)
      }
    }
    const r = holeResult.get(h)
    if (r === null || r === undefined || r === 0) continue
    const states = parents
      .filter((b) => b.history.has(h))
      .map((b) => {
        const d = b.history.get(h)!
        return `${betLabel(b)} ${d === 0 ? 'AS' : `${sideShort(d > 0 ? 'a' : 'b')} ↑${Math.abs(d)}`}`
      })
    if (states.length > 0) note(h, states.join(' · '))
  }
  for (const b of ordered) {
    if (!isClosed(b)) continue
    const span = spans[b.segment].filter((x) => x >= b.startHole)
    // a bet closed by round completion closes on its last PLAYED hole —
    // never narrate (or attribute money) on a hole nobody played
    const played = span.filter((h) =>
      playerIds.some((id) => ctx.gross.get(id)?.get(h) !== undefined),
    )
    const closeAt = played[played.length - 1] ?? span[span.length - 1]
    if (closeAt !== undefined) note(closeAt, `${betLabel(b)} closes — ${betValue(b)}`)
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
        { term: 'Best ball', def: 'In 2v2, each team counts only its lower score on a hole.' },
        { term: 'Dormie', def: 'Up exactly as many holes as remain — can no longer lose the bet.' },
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
    const parsed = nassauConfigSchema.safeParse(config.config)
    if (!parsed.success) return ['Invalid nassau configuration']
    const teams = parsed.data.teams
    if (teams === null) {
      return players.length === 2 ? [] : ['Nassau without teams needs exactly 2 players']
    }
    return teamPartitionProblems(teams, players, 'Nassau')
  },
  eventKinds: {
    'nassau/press': z
      .object({
        hole: z.number().int().min(1).max(18),
        // scoring UI answers prompts with { hole, choice }
        choice: z.enum(['front', 'back', 'overall']).optional(),
        segment: z.enum(['front', 'back', 'overall']).optional(),
      })
      .refine((d) => d.choice !== undefined || d.segment !== undefined, {
        message: 'press needs a segment',
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

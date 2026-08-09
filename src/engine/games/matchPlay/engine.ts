import { z } from 'zod'
import type { GameEngine, GameDerivation, InputRequest } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import {
  closeMargin,
  holesRemainingIn,
  matchClosed,
  matchHoleResults,
  matchWonLabel,
  newMatch,
  scoreMatchHole,
  sideStake,
  stretchLabel,
  toPlayAfterIn,
  type MatchSide,
  type MatchSides,
} from '../../core/match'
import { addLine, emptySettlement, type Settlement } from '../../core/money'
import { duplicateInstanceProblems } from '../../core/setup'
import { standingsFromSettlement } from '../../core/standings'
import { firstName, joinNames, summaryString } from '../../core/summary'
import { teamsSchema, nonEmptyPartitionProblems } from '../../core/teams'
import type { GameConfig, HandicapSettings, Uuid } from '../../core/types'

export const matchPlayConfigSchema = z.object({
  /** per-player stake on the match */
  stakeCents: z.number().int().positive(),
  /** null = 1v1 (first two players); otherwise best ball, 2v2 or uneven */
  teams: teamsSchema.nullable(),
})

export type MatchPlayConfig = z.infer<typeof matchPlayConfigSchema>

/**
 * ONE match over the round — deliberately not a Nassau with the segments turned
 * off.
 *
 * Nassau IS segmented match play, so a one-bet, no-press config would settle
 * the same money. It isn't the same game: golfers look for "Match Play" by
 * name, and press identity, auto-press and undo-follows-ownership are dead
 * weight when there is nothing to press. This is the shape core/match.ts was
 * extracted for (MAI-48) — the second caller that proves the kit carries the
 * rules rather than Nassau carrying them.
 *
 * The whole 9-hole story is `span = ctx.holesPlayed`: no `segmentSpans` call,
 * no branch, and "a nine is one match over the nine" falls out.
 */
function derive(
  game: GameConfig<MatchPlayConfig>,
  _events: readonly GameScopedEvent[],
  ctx: RoundContext,
): GameDerivation {
  const { stakeCents } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  const sideA: Uuid[] = game.config.teams ? game.config.teams.a : [playerIds[0]!]
  const sideB: Uuid[] = game.config.teams ? game.config.teams.b : [playerIds[1]!]
  // The two sides as core/match sees them, including the COMPACT name a margin
  // is quoted with — first names, because the pinned bar is where that string
  // has the least room. The hole narration builds its own from full names.
  const sides: MatchSides = {
    a: sideA,
    b: sideB,
    short: (side) =>
      (side === 'a' ? sideA : sideB).map((id) => firstName(nameOf.get(id))).join(' & '),
  }

  /** +1 side A, -1 side B, 0 halved, null not yet finalized */
  const holeResult = matchHoleResults(ctx, game.gameId, sides)

  const span = ctx.holesPlayed
  // `span[0]` and not `span[0]!`: holesPlayed is filtered against the course
  // snapshot (context.ts), so a round whose range names holes the snapshot
  // doesn't have — a back-nine round on a 9-hole card, which importRound will
  // accept because it validates games loosely — genuinely arrives empty. The
  // honest reading is a match with no holes: `newMatch` seeds holesRemaining 0,
  // `matchClosed` calls it decided, `matchWonLabel` returns null at diff 0, and
  // it moves no money while reporting "push". Wrong-looking, but only on a
  // round setup cannot build, and better than a crash on a round the user can
  // still open.
  const startHole = span[0] ?? 1
  const match = newMatch(span, startHole)
  // Precomputed once: read per decided hole, inside a derive that itself runs
  // once per hole in the ledger's prefix replay (core/match.ts).
  const toPlayAfter = toPlayAfterIn(span)

  for (const hole of span) {
    const result = holeResult.get(hole)
    if (result === null || result === undefined) continue
    // No "skip if closed" guard here on purpose — a decided match is inert
    // inside `scoreMatchHole`, at the choke point, precisely so every match
    // game doesn't re-derive that rule and one of them get it wrong.
    // `played` is anyScored, never finalized: it is what decides whether the
    // margin may quote a to-play count (MAI-38).
    scoreMatchHole(match, hole, result, toPlayAfter(hole), ctx.anyScored(hole))
  }
  // `newMatch` seeds holesRemaining to the whole span so a fresh match doesn't
  // read as a push; this is where it becomes true. Without it a level match
  // never closes and never says so.
  match.holesRemaining = holesRemainingIn(span, startHole, holeResult)

  const sideShort = sides.short
  /** "Ann wins 3&2" for a decided match; null while live AND for a push. */
  const won = matchWonLabel(match, sides)

  const settlement: Settlement = emptySettlement(playerIds)
  // The match pays exactly when it is won. Still live, or level at the end (a
  // push), and nothing moves — which is also why no zero-cent line is ever
  // built: `settlement.lines` is money that MOVED.
  if (won !== null) {
    const winSide: MatchSide = match.diff > 0 ? 'a' : 'b'
    const loseSide: MatchSide = winSide === 'a' ? 'b' : 'a'
    const winEach = sideStake(stakeCents, sides, winSide)
    const loseEach = sideStake(stakeCents, sides, loseSide)
    addLine(settlement, {
      // The won label alone: unlike Nassau there is only ever one line, under a
      // panel already titled with the game's name, so a bet prefix would name
      // what the heading just said.
      label: won,
      perPlayerCents: Object.fromEntries([
        ...sides[winSide].map((id) => [id, winEach] as const),
        ...sides[loseSide].map((id) => [id, -loseEach] as const),
      ]),
    })
  }

  /** The match the way a golfer tracks it: who's up, by how much, holes left. */
  const betValue = (): string => {
    // Decided is checked FIRST — a match closed 3&2 still has two holes on the
    // card, and reading holesRemaining before it would call the match live.
    if (won) return won
    if (match.holesRemaining === 0) return 'push'
    const n = Math.abs(match.diff)
    const leader = match.diff === 0 ? null : sideShort(match.diff > 0 ? 'a' : 'b')
    if (leader && n === match.holesRemaining) return `${leader} ↑${n} · dormie`
    const status = leader ? `${leader} ↑${n}` : 'AS'
    return `${status} · ${match.holesRemaining} to play`
  }

  const statusFor = (side: MatchSide): string => {
    const d = side === 'a' ? match.diff : -match.diff
    // A decided match takes ✓/✗ rather than an arrow: "↓2 up" reads as a
    // contradiction, and the margin token itself says the match is over.
    if (match.closedAt !== undefined) {
      return `${d > 0 ? '✓' : '✗'}${closeMargin(Math.abs(d), match.closeToPlay ?? 0)}`
    }
    return d > 0 ? `↑${d}` : d < 0 ? `↓${-d}` : 'AS'
  }

  const standings = standingsFromSettlement(players, settlement, (p) =>
    statusFor(sideA.includes(p.playerId) ? 'a' : 'b'),
  )

  // The stretch, not "Match": every surface prints the game's name beside this
  // already, and the ledger row reserves a label gutter whether or not one is
  // given. "18"/"F9"/"B9" is the one thing the heading doesn't say.
  const label = stretchLabel(span, ctx.round.holes)
  const detailLines = [{ label, value: betValue() }]
  // The bar shows LIVE MATCH STATUS rather than recapping the latest decided
  // hole — the documented match-play exception to the latestHoleSummary
  // convention (catalog.ts), because the stakes here are the running match.
  const summaryParts = [{ label, value: betValue() }]

  // Nothing to choose and nothing to declare: every hole computes from scores.
  const requiredInputs = (): InputRequest[] => []

  const holeNotes = new Map<number, string[]>()
  const note = (h: number, s: string) => {
    if (!holeNotes.has(h)) holeNotes.set(h, [])
    holeNotes.get(h)!.push(s)
  }
  for (const h of span) {
    const r = holeResult.get(h)
    // a halved hole moves nothing, so there is no new position to report
    if (r === null || r === undefined || r === 0) continue
    // `history` is the inertness guard: a decided match records nothing for the
    // holes after its close, so those print the hole winner and no position.
    const d = match.history.get(h)
    if (d === undefined) continue
    note(h, d === 0 ? 'AS' : `${sideShort(d > 0 ? 'a' : 'b')} ↑${Math.abs(d)}`)
  }
  // Narrate the close on the hole the MONEY lands on, which is not always the
  // hole the match was decided on: the ledger derives each hole's delta from a
  // prefix replay, so a close surfaces once its deciding hole counts as final —
  // which for a round finished early is the last hole anybody played.
  // `ctx.finalizedAt` IS that hole, by the same rule the money uses (MAI-38).
  // A pushed match has no closedAt; it is decided when its holes run out, so it
  // reports on the last hole of the span.
  if (matchClosed(match)) {
    const decidedOn = match.closedAt ?? span[span.length - 1]
    const closeAt = decidedOn === undefined ? undefined : ctx.finalizedAt(decidedOn)
    if (closeAt !== undefined) note(closeAt, `Match closes — ${betValue()}`)
  }

  const holeSummary = (hole: number): string[] => {
    const r = holeResult.get(hole)
    if (r === null || r === undefined) return []
    const notes = holeNotes.get(hole) ?? []
    // an unplayed hole finalized by round completion carries only its notes
    if (!ctx.anyScored(hole)) return notes
    const side = r === 1 ? sideA : r === -1 ? sideB : null
    const winnerLine = side
      ? `${joinNames(side, nameOf)} ${side.length > 1 ? 'win' : 'wins'} the hole`
      : 'Halved'
    return [winnerLine, ...notes]
  }

  return {
    standings,
    summary: summaryString(summaryParts),
    summaryParts,
    detailLines,
    holeSummary,
    requiredInputs,
    settlement,
  }
}

/** The one name for this game — `meta.name` and every message that has to say
 *  it. label.ts is the single source of a game's name (MAI-42), so a second
 *  literal in `validateSetup` would drift the moment this is renamed. */
const MATCH_PLAY_NAME = 'Match Play'

export const matchPlayEngine: GameEngine<MatchPlayConfig> = {
  type: 'matchPlay',
  meta: {
    name: MATCH_PLAY_NAME,
    blurb: 'One match over the round. Go up more holes than are left and it is over.',
    minPlayers: 2,
    maxPlayers: 4,
    // 'either', not 'main'. The picker offers a game in the side-bet section
    // only if its category admits one (GamePickerSheet), and a match riding
    // alongside a group game is ordinary: a pair playing skins and a match at
    // the same time, or a four-ball whose main event is the skins pot. 'main'
    // would make both unbuildable. Nothing is lost, either: an 'either' game
    // with no main beside it still reads as the main event (roleOf), and beside
    // a Nassau it correctly reads as the side bet instead of leaving the round
    // with two main events for `primaryGame` to pick between on order alone.
    //
    // What it does NOT buy is a match between two players out of four. Sides
    // are `nonEmptyPartitionProblems` — every player on exactly one of them —
    // so a foursome's match is 2v2, never Ann v Bob with the other two sitting
    // it out. Subset sides would be a change to the shared teams contract.
    category: 'either',
    family: 'match',
    // 1v1 by default, fixed sides when `teams` is set — the same set Nassau
    // declares, and for the same reason: the axis lives in the config.
    shapes: ['headToHead', 'teams'],
    rules: {
      tagline: 'One match over the round — holes won, not strokes counted.',
      howToPlay: [
        'Each hole is won, lost or halved. Lowest net score takes it — on a team, only its better ball counts.',
        'Nothing carries and nothing accumulates: a hole won by one shot counts exactly as much as a hole won by five.',
        'The whole round is a single bet. A 9-hole round is one match over that nine.',
        'No presses. If you want to press when you go down, play Nassau instead.',
      ],
      scoring: [
        'The match is won the moment a side is up more holes than the match has left — 3 up with 2 to play is won 3&2, the margin stops moving there, and the money settles on that hole.',
        'Otherwise it runs to the last hole: whoever is up wins the stake, and a level match pushes.',
        'Every player pays or collects the stake — a $5 match swings $5 per player, in singles or 2v2.',
        'Outnumbered, a lone player plays the stake against each opponent: a $5 match swings $10 against two of them, $15 against three, while each of them swings $5.',
        'A hole where only one side posts a score goes to that side; no scores at all halves it.',
      ],
      terms: [
        {
          term: 'Match play',
          def: 'Scoring by holes won rather than total strokes. The size of a win on any one hole never matters.',
        },
        { term: 'Halve', def: 'A tied hole — neither side gains ground.' },
        { term: 'All square (AS)', def: 'Neither side is up.' },
        { term: 'Push', def: 'A match that ends level — no money moves.' },
        {
          term: 'Dormie',
          def: 'Up exactly as many holes as remain — the match can no longer be lost.',
        },
        {
          term: 'Closed out (3&2)',
          def: 'Up more holes than remain, so the match is over early — 3&2 is three up with two to play. It pays there, and the holes left no longer count.',
        },
        { term: 'Best ball', def: 'On a team, only the lower score on a hole counts.' },
      ],
    },
  },
  configSchema: matchPlayConfigSchema,
  configFields: [
    { key: 'stakeCents', kind: 'money', label: 'Stake', min: 100, step: 100 },
    { key: 'teams', kind: 'teams', label: 'Teams (best ball · two sides)' },
  ],
  defaultConfig: (players) => ({
    stakeCents: 500,
    teams:
      players.length === 4
        ? {
            a: [players[0]!.playerId, players[1]!.playerId],
            b: [players[2]!.playerId, players[3]!.playerId],
          }
        : players.length === 3
          ? { a: [players[0]!.playerId, players[1]!.playerId], b: [players[2]!.playerId] }
          : null,
  }),
  defaultHandicap: (): HandicapSettings => ({
    mode: 'net',
    allowancePct: 100,
    reference: 'offLow',
  }),
  validateSetup: (config, players, siblings) => {
    const dupes = duplicateInstanceProblems(config, siblings, MATCH_PLAY_NAME)
    const parsed = matchPlayConfigSchema.safeParse(config.config)
    if (!parsed.success) return [...dupes, 'Invalid match play configuration']
    const teams = parsed.data.teams
    if (teams === null) {
      return players.length === 2
        ? dupes
        : [...dupes, `${MATCH_PLAY_NAME} without teams needs exactly 2 players`]
    }
    return [...nonEmptyPartitionProblems(teams, players, MATCH_PLAY_NAME), ...dupes]
  },
  // Nothing to record: the match is a pure function of the scores.
  eventKinds: {},
  derive,
}

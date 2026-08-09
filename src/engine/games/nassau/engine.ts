import { z } from 'zod'
import type { GameAction, GameEngine, GameDerivation, InputRequest } from '../../catalog'
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
  segmentSpans,
  sideStake,
  stretchLabel,
  toPlayAfterIn,
  type MatchSegment,
  type MatchSide,
  type MatchSides,
  type MatchState,
} from '../../core/match'
import { addLine, emptySettlement, formatCents, type Settlement } from '../../core/money'
import { duplicateInstanceProblems } from '../../core/setup'
import { standingsFromSettlement } from '../../core/standings'
import { firstName } from '../../core/summary'
import { teamsSchema, nonEmptyPartitionProblems } from '../../core/teams'
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

type Segment = MatchSegment

/**
 * A nassau bet: a match (core/match.ts) plus what makes it THIS bet — which
 * stretch it scores, where it starts, how deep a press it is. The running diff,
 * its per-hole history and the close-out live in `MatchState`, shared with
 * every other match-play game.
 */
interface Bet extends MatchState {
  id: string
  segment: Segment
  /** first hole this bet scores (press start) */
  startHole: number
  /** press depth: 0 = original bet */
  depth: number
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
  const spans = segmentSpans(ctx.holesPlayed)

  const sideA: Uuid[] = game.config.teams ? game.config.teams.a : [playerIds[0]!]
  const sideB: Uuid[] = game.config.teams ? game.config.teams.b : [playerIds[1]!]
  // The two sides as core/match sees them, including the COMPACT name a margin
  // is quoted with. First names, because the pinned bar is where that string
  // has the least room; the hole narration builds its own from full names.
  const sides: MatchSides = {
    a: sideA,
    b: sideB,
    short: (side) =>
      (side === 'a' ? sideA : sideB).map((id) => firstName(nameOf.get(id))).join(' & '),
  }

  /** +1 side A, -1 side B, 0 halved, null not yet finalized */
  const holeResult = matchHoleResults(ctx, game.gameId, sides)

  // Every press event for a slot is kept, not just the last: undoing a press
  // means retracting ALL of them, or a stray duplicate would leave the bet
  // standing after the player toggled it off.
  const manualPresses = new Map<string, { hole: number; segment: Segment; eventIds: Uuid[] }>()
  for (const e of events) {
    if (e.kind !== 'nassau/press') continue
    const data = e.data as { hole: number; segment: Segment }
    const key = `${data.segment}-${data.hole}`
    const seen = manualPresses.get(key)
    if (seen) seen.eventIds.push(e.id)
    else manualPresses.set(key, { ...data, eventIds: [e.id] })
  }

  // PRESS IDENTITY — there is exactly ONE press bet per (segment, startHole),
  // whatever created it. A press IS that pair: a parent and its own presses
  // being down all point at the same new bet over the same holes for the same
  // stake, so a parent-triggered auto-press, a press-triggered auto-press and a
  // hand-tapped press landing on the same segment and hole are one bet, not
  // three. Without this, two bets with identical spans and identical ledger
  // labels both settle and the group pays a press they only wrote down once —
  // and zero-sum still holds, so the property fuzz never sees it (MAI-34).
  // Manual presses are registered first, so a hand-tapped press wins the slot.
  const pressStarts = new Set<string>()
  const pressKey = (segment: Segment, hole: number) => `${segment}-${hole}`
  // Slots the RULES would open on their own, whether or not a hand-tapped press
  // got there first. A press in one of these is not the player's to take back:
  // retracting their event would just let auto-press re-create the same bet, so
  // offering an undo there would be a button that visibly does nothing.
  const autoWanted = new Set<string>()

  const bets: Bet[] = (['front', 'back', 'overall'] as const)
    .filter((seg) => spans[seg].length > 0)
    .map((seg) => ({
      id: seg,
      segment: seg,
      startHole: spans[seg][0]!,
      depth: 0,
      ...newMatch(spans[seg], spans[seg][0]!),
    }))

  for (const press of manualPresses.values()) {
    if (!spans[press.segment].includes(press.hole)) continue
    pressStarts.add(pressKey(press.segment, press.hole))
    bets.push({
      id: `press-${press.segment}-${press.hole}`,
      segment: press.segment,
      startHole: press.hole,
      depth: 1,
      ...newMatch(spans[press.segment], press.hole),
    })
  }

  // Structural holes-after-this lookups, one per segment — precomputed because
  // each is read once per (bet × decided hole) inside the walk, and `derive`
  // itself runs once per hole in the ledger's prefix replay. Why it counts the
  // span rather than what is still undecided, and why a miss must fail towards
  // NOT closing, are documented on `toPlayAfterIn` (core/match.ts).
  const toPlayAfterBySegment: Record<Segment, (hole: number) => number> = {
    front: toPlayAfterIn(spans.front),
    back: toPlayAfterIn(spans.back),
    overall: toPlayAfterIn(spans.overall),
  }

  // Single accumulation walk. Auto-presses spawn when a bet's diff transitions
  // into exactly ±2 (from a smaller gap), starting the NEXT hole of the same
  // segment (never past the segment's end). Presses spawned this hole don't
  // score it — the `active` snapshot is taken before spawning.
  //
  // A bet stops scoring the moment it is decided: a match that is over is over,
  // and the dead holes must not drift the margin the group wrote down (3&2 has
  // to stay 3&2 even if the loser wins the last two).
  for (const hole of ctx.holesPlayed) {
    const result = holeResult.get(hole)
    if (result === null || result === undefined) continue
    const active = bets.filter(
      (b) => b.closedAt === undefined && spans[b.segment].includes(hole) && hole >= b.startHole,
    )
    for (const bet of active) {
      // `prev` is the diff BEFORE this hole. Auto-press fires on CROSSING ±2,
      // not on sitting at it, so the transition is what matters — which is why
      // scoreMatchHole hands it back rather than leaving callers to re-read.
      const prev = scoreMatchHole(
        bet,
        hole,
        result,
        toPlayAfterBySegment[bet.segment](hole),
        // whether a to-play count may be quoted: a bet that runs out of room on
        // a hole nobody played degrades to "2 up" (core/match.ts)
        ctx.anyScored(hole),
      )
      if (
        autoPress &&
        // a bet that just closed is not live, and you cannot press a match
        // that is over — this is the one case where both fire on the same
        // hole (2 down with exactly 1 to play is 2&1, not a press)
        bet.closedAt === undefined &&
        Math.abs(bet.diff) === 2 &&
        Math.abs(prev) < 2 &&
        spans[bet.segment].some((h) => h > hole)
      ) {
        const nextHole = spans[bet.segment].find((h) => h > hole)!
        // recorded even when the slot is already taken — the point is that the
        // rules WANT a press here, which is what makes it non-undoable
        autoWanted.add(pressKey(bet.segment, nextHole))
        // one bet per (segment, startHole) — a parent and one of its own
        // presses can both cross ±2 on this same hole, and both want to open
        // the same press
        if (pressStarts.has(pressKey(bet.segment, nextHole))) continue
        pressStarts.add(pressKey(bet.segment, nextHole))
        bets.push({
          id: `auto-${bet.id}-@${nextHole}`,
          segment: bet.segment,
          startHole: nextHole,
          depth: bet.depth + 1,
          ...newMatch(spans[bet.segment], nextHole),
        })
      }
    }
  }

  for (const bet of bets) {
    bet.holesRemaining = holesRemainingIn(spans[bet.segment], bet.startHole, holeResult)
  }

  // Money is LOCKED-ONLY, and a bet is locked the moment it is DECIDED — up
  // more holes than its stretch has left. That is when golfers shake hands and
  // settle, so it is when the dollars move (MAI-38).
  //
  // The old rule waited for the holes to physically run out, which is the same
  // instant for a bet that goes the distance and hours late for one that closes
  // 3&2. What has NOT changed is the thing that rule was protecting: a merely
  // leading bet still moves no money, because it can still flip. A decided one
  // cannot — that is precisely what makes settling here safe.
  //
  // A bet level at the end never sets closedAt: it pushes, and pays nothing
  // either way. Both that and the "decided" rule live in `matchClosed`.

  // Every bet — parents and presses — reported the way a golfer tracks it:
  // who's up, by how much, holes left; dormie/closed-out/final when apt.
  const sideShort = sides.short
  const segLabel = (seg: Segment): string =>
    // a collapsed 9-hole nassau's single bet is the nine that was played, which
    // is core/match's rule to name (every match game's single bet needs it)
    seg === 'overall'
      ? stretchLabel(ctx.holesPlayed, ctx.round.holes)
      : seg === 'front'
        ? 'F9'
        : 'B9'
  const betLabel = (b: Bet): string => (b.depth === 0 ? segLabel(b.segment) : `Press @${b.startHole}`)
  // Names the bet in full, for contexts that are a flat list rather than rows
  // nested under their segment: settlement lines and the per-hole notes. Goes
  // through segLabel like everything else, so a nine-hole round's single bet
  // isn't called "Overall" in the money while the ledger calls it "B9".
  const betFullLabel = (b: Bet): string =>
    b.depth === 0 ? segLabel(b.segment) : `${segLabel(b.segment)} press @${b.startHole}`

  /**
   * "Ann wins 3&2" for a decided bet; null while it is still live, and null for
   * a push. THE definition of a won bet — shared by the pinned bar, the bet
   * ledger, the settlement label and the hole notes, and now by every other
   * match-play game through core/match.ts.
   */
  const closedLabel = (b: Bet): string | null => matchWonLabel(b, sides)

  const settlement: Settlement = emptySettlement(playerIds)
  for (const bet of bets) {
    // A bet pays exactly when it is won — still live, or level at the end
    // (a push), and nothing moves either way.
    const won = closedLabel(bet)
    if (won === null) continue
    const winSide: MatchSide = bet.diff > 0 ? 'a' : 'b'
    const loseSide: MatchSide = winSide === 'a' ? 'b' : 'a'
    const winners = sides[winSide]
    const losers = sides[loseSide]
    const winEach = sideStake(stakeCents, sides, winSide)
    const loseEach = sideStake(stakeCents, sides, loseSide)
    addLine(settlement, {
      label: `${betFullLabel(bet)} — ${won}`,
      perPlayerCents: Object.fromEntries([
        ...winners.map((id) => [id, winEach] as const),
        ...losers.map((id) => [id, -loseEach] as const),
      ]),
    })
  }

  const statusFor = (side: 'a' | 'b'): string =>
    bets
      .filter((b) => b.depth === 0)
      .map((b) => {
        const d = side === 'a' ? b.diff : -b.diff
        // segLabel, not a local copy of it — a nine-hole round's single bet is
        // the nine that was played, and this line sits beside the bar and the
        // ledger that already call it that
        const seg = segLabel(b.segment)
        // A decided bet takes ✓/✗ rather than an arrow: "↓2 up" reads as a
        // contradiction, and the margin token itself says the match is over.
        if (b.closedAt !== undefined) {
          return `${seg} ${d > 0 ? '✓' : '✗'}${closeMargin(Math.abs(d), b.closeToPlay ?? 0)}`
        }
        return `${seg} ${d > 0 ? `↑${d}` : d < 0 ? `↓${-d}` : 'AS'}`
      })
      .join(' · ')

  const standings = standingsFromSettlement(players, settlement, (p) =>
    statusFor(sideA.includes(p.playerId) ? 'a' : 'b'),
  )

  const betValue = (b: Bet): string => {
    // Decided is checked FIRST — a bet closed 3&2 still has two holes on the
    // card, and reading holesRemaining before closedAt would call it live.
    const won = closedLabel(b)
    if (won) return won
    if (b.holesRemaining === 0) return 'push'
    const n = Math.abs(b.diff)
    const leader = b.diff === 0 ? null : sideShort(b.diff > 0 ? 'a' : 'b')
    if (leader && n === b.holesRemaining) return `${leader} ↑${n} · dormie`
    const status = leader ? `${leader} ↑${n}` : 'AS'
    return `${status} · ${b.holesRemaining} to play`
  }

  /**
   * The deficit that justifies pressing a segment at `asOf`: the worst position
   * ANY live bet in that segment is in, as of the last hole decided before it.
   *
   * Shared by the press offer and the ledger's press explanation, deliberately.
   * A press is very often triggered by another PRESS going 2 down while the
   * parent bet sits all square, so reading the parent alone would report "AS"
   * as the reason a press exists. And two copies of the press rule drifting
   * apart is exactly what MAI-34 was — one helper, two call sites.
   *
   * "Live" is evaluated AS OF the hole asked about, not as of now. Both callers
   * need that and for opposite reasons: the offer must ignore a bet that closed
   * two holes ago, while the ledger's historical explanation must still see a
   * bet that was live back then and has closed since.
   */
  const pressDeficit = (
    segment: Segment,
    asOf: number,
  ): { trailing: 'a' | 'b'; by: number; on: Bet } | null => {
    const decided = spans[segment].filter((h) => h < asOf && (holeResult.get(h) ?? null) !== null)
    const at = decided[decided.length - 1]
    if (at === undefined) return null
    let worst = 0
    let on: Bet | undefined
    for (const b of bets) {
      if (b.segment !== segment || b.startHole >= asOf) continue
      if (b.closedAt !== undefined && b.closedAt < asOf) continue
      const d = b.history.get(at)
      if (d !== undefined && Math.abs(d) > Math.abs(worst)) {
        worst = d
        on = b
      }
    }
    if (worst === 0 || on === undefined) return null
    return { trailing: worst > 0 ? 'b' : 'a', by: Math.abs(worst), on }
  }

  /**
   * "Colby 1 down" — plus WHICH bet, when it isn't the segment's original.
   *
   * Naming it is the whole difference between an offer that makes sense and one
   * that contradicts the screen above it. Once the F9 match is won, the ledger
   * says "F9 · Benjamin wins 3&2" while a live press underneath is still 1 down;
   * an offer reading "Press F9 · Colby 1 down" then looks like the app forgot
   * the match is over. Same for the case N13 documents, where the parent sits
   * all square and it is a PRESS that went 2 down.
   */
  const deficitPhrase = (down: { trailing: 'a' | 'b'; by: number; on: Bet }): string =>
    `${sideShort(down.trailing)} ${down.by} down${down.on.depth > 0 ? ` on ${betLabel(down.on)}` : ''}`

  // play order: each nine's bet followed by its presses, overall last.
  // Presses sort by the hole they START from, not by press depth — a press of a
  // press can begin BEFORE a later press of the parent, and a ledger that lists
  // "@3 · @7 · @5" reads as a mistake to the person holding the phone.
  const ordered = (['front', 'back', 'overall'] as const).flatMap((seg) =>
    bets
      .filter((b) => b.segment === seg)
      .sort((a, b) => a.startHole - b.startHole || a.depth - b.depth),
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
    // The bar is the ONE place a close has to survive being made compact —
    // dropping it here is what let a decided bet read as a running lead.
    const won = closedLabel(b)
    if (won) return won
    if (b.holesRemaining === 0) return 'push'
    const n = Math.abs(b.diff)
    const leader = b.diff === 0 ? null : sideShort(b.diff > 0 ? 'a' : 'b')
    return leader ? `${leader} ↑${n}` : 'AS'
  }
  const parents = ordered.filter((b) => b.depth === 0)
  // a press that closed early is settled, not live — the chip counts bets
  // still capable of moving money
  const livePresses = ordered.filter((b) => b.depth > 0 && !matchClosed(b)).length
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

  // Nassau blocks on nothing: every hole computes from scores alone.
  const requiredInputs = (): InputRequest[] => []

  /**
   * The press offer. AVAILABILITY, not recommendation — a press is legal
   * whenever a side is behind, which is most holes, so this lives behind a
   * button and only `recommended` (the traditional 2 down) gets badged.
   *
   * Offered on the frontier hole, i.e. while the group is standing on that tee,
   * and the press runs from there. Deliberately independent of `autoPress`:
   * auto covers the convention, this covers judgment (knowing your man is
   * fading, knowing you own the back nine) — reasons no threshold can see.
   * One offer per segment, since a press IS (segment, startHole) however many
   * of that segment's bets are down.
   */
  const availableActions = (): GameAction[] => {
    const frontier = ctx.holesPlayed.find((h) => holeResult.get(h) === null)
    if (frontier === undefined) return []
    const actions: GameAction[] = []
    for (const seg of ['front', 'back', 'overall'] as const) {
      if (!spans[seg].includes(frontier)) continue
      const taken = pressStarts.has(pressKey(seg, frontier))
      const down = pressDeficit(seg, frontier)
      // all square and unpressed: nothing to catch up on, and no side owns
      // the decision. A press already running still shows, so it can be undone.
      if (!taken && !down) continue
      const toPlay = spans[seg].filter(
        (h) => h >= frontier && (holeResult.get(h) ?? null) === null,
      ).length
      const last = spans[seg][spans[seg].length - 1]!
      const span = frontier === last ? `hole ${last}` : `holes ${frontier}–${last}`
      const why = down ? `${deficitPhrase(down)} · ${toPlay} to play` : `${toPlay} to play`
      // Quote the stake to the side being INVITED to press — the one that's
      // down. In a 2-v-1 the lone player books this bet against each opponent,
      // so a "$5" press costs them $10; telling them $5 in the one line meant
      // to say what they're signing up for would be the wrong number.
      const stake = down ? sideStake(stakeCents, sides, down.trailing) : stakeCents
      actions.push({
        id: `nassau-press-${seg}-${frontier}`,
        gameId: game.gameId,
        hole: frontier,
        label: `Press ${segLabel(seg)}`,
        detail: why,
        effect: `${taken ? 'Running' : 'New'} ${formatCents(stake)} bet · ${span}`,
        // nothing to recommend once it's running
        recommended: !taken && (down?.by ?? 0) >= 2,
        // The badge beside a gold row, in Nassau's own words. Two down is the
        // traditional moment and the only one the game pushes; the offer itself
        // stands at any deficit.
        recommendedReason: '2 down',
        eventKind: 'nassau/press',
        data: { hole: frontier, segment: seg },
        ...(taken && {
          taken: true,
          // Undoable only when the player's tap is the ONLY reason this bet
          // exists. An auto-press has no event behind it; and a hand-tapped
          // press sitting in a slot the rules also want would simply be
          // re-created the instant it was retracted.
          undoEventIds: autoWanted.has(pressKey(seg, frontier))
            ? []
            : (manualPresses.get(pressKey(seg, frontier))?.eventIds ?? []),
        }),
      })
    }
    return actions
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
        // explain WHY the press exists, in the terms the group argued it in:
        // who was down and by how much — read from the same rules that drive
        // the offer, so the ledger and the sheet never tell different stories.
        // Authorship is OWNERSHIP, not who tapped first: a hand-tapped press in
        // a slot auto-press also wanted is an auto-press, because it would be
        // there either way. Reading `b.id` instead would badge that bet "auto"
        // in the sheet while calling it "pressed" here.
        const down = pressDeficit(b.segment, h)
        const auto = autoWanted.has(pressKey(b.segment, h))
        const why = down
          ? `${deficitPhrase(down)}${auto ? ' → auto-press' : ' → pressed'}`
          : auto
            ? 'auto-press'
            : 'pressed'
        // NAME THE SEGMENT here, unlike `betLabel`. Several segments can open a
        // press on the same hole (the front nine and the overall move in
        // lockstep, so they hit 2 down together), and these notes are a flat
        // list — two bare "Press @3 starts…" lines with different reasons is
        // unreadable. detailLines can stay terse because it nests under its bet.
        note(h, `${betFullLabel(b)} starts (${why})`)
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
  // Narrate a close on the hole the MONEY lands on, which is not always the
  // hole the bet was decided on. The ledger derives each hole's delta from a
  // prefix replay, so a close only surfaces once its deciding hole counts as
  // final — which can be a later hole entirely. Put the note anywhere else and
  // the two come apart: the money appears on a row with nothing explaining it,
  // and the sentence sits on a row the ledger may drop for having neither a
  // score nor a delta.
  //
  // `ctx.finalizedAt` IS that hole, by the same rule the money uses. Deriving
  // it here instead — from "the next hole anybody played", say — gets a subtly
  // different answer whenever the deciding hole was only partly scored.
  //
  // A pushed bet has no closedAt: it is decided when its own holes run out, so
  // it reports on the last hole of ITS stretch, not the round's.
  for (const b of ordered) {
    if (!matchClosed(b)) continue
    const span = spans[b.segment].filter((x) => x >= b.startHole)
    const decidedOn = b.closedAt ?? span[span.length - 1]
    const closeAt = decidedOn === undefined ? undefined : ctx.finalizedAt(decidedOn)
    if (closeAt !== undefined) note(closeAt, `${betFullLabel(b)} closes — ${betValue(b)}`)
  }

  const holeSummary = (hole: number): string[] => {
    const r = holeResult.get(hole)
    if (r === null || r === undefined) return []
    const notes = holeNotes.get(hole) ?? []
    // an unplayed hole finalized by round completion carries only its notes
    if (!ctx.anyScored(hole)) return notes
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
    availableActions,
    settlement,
  }
}

/** The one name for this game — `meta.name` and every message that has to
 *  say it. label.ts is the single source of a game's name (MAI-42), so a
 *  second literal in `validateSetup` would drift the moment this is renamed. */
const NASSAU_NAME = 'Nassau'

export const nassauEngine: GameEngine<NassauConfig> = {
  type: 'nassau',
  meta: {
    name: NASSAU_NAME,
    blurb: 'Three match-play bets: front nine, back nine, overall. Press when down.',
    minPlayers: 2,
    maxPlayers: 4,
    category: 'main',
    family: 'match',
    // BOTH, declared as a set — the case that ruled a single-value team axis
    // out of `meta` entirely: teams: null is 1v1, teams: {...} is 2v2 or 2v1.
    shapes: ['headToHead', 'teams'],
    actions: {
      verb: 'Press',
      plural: 'Presses',
      blurb:
        'A press is a new bet at the same stake, running from that hole to the end of the ' +
        "stretch. You can press any bet you're down on.",
      // States the RULE, not one of its causes. "Every bet is level" was true
      // until bets could close: a decided bet isn't level, it's over, and this
      // is the sheet that answers "why can't I press?" honestly.
      emptyState: "Nothing to press — a press needs a live bet you're down on.",
    },
    rules: {
      tagline: 'Three bets in one round: the front nine, the back nine, and the overall.',
      howToPlay: [
        'Match play: each hole is won, lost, or halved. Lowest net score takes the hole — on a team, only its better ball counts.',
        'The front nine, back nine, and full 18 run as three separate bets at the same stake. A hole feeds its nine AND the overall.',
        "Down on a bet? Tap PRESS to start a fresh bet at the same stake, running from the next hole to the end of that bet's stretch. Presses can themselves be pressed.",
        'You may press any bet you are behind on, by any margin — 2 down is the traditional moment, and the button flags it, but the call is yours. With auto-press on, a press also starts by itself at 2 down.',
        'A 9-hole round collapses to a single overall bet.',
      ],
      scoring: [
        'A bet is won the moment a side is up more holes than the bet has left — 3 up with 2 to play is won 3&2, the margin stops moving there, and the money settles on that hole.',
        'Otherwise the bet runs to the end of its stretch: whoever is up wins its stake, and a tied bet pushes.',
        'Every player pays or collects the stake — a $5 bet swings $5 per player, in singles or 2v2.',
        'In a 2-v-1, the solo player plays each opponent for the stake: a $5 bet swings $10 for them, $5 for each of the pair.',
        'A hole where only one side posts a score goes to that side; no scores at all halves it.',
      ],
      terms: [
        {
          term: 'Press',
          def: "A new same-stake bet the trailing side starts, running from that hole to the end of the original bet's stretch. Traditionally taken at 2 down, but available whenever you're behind.",
        },
        { term: 'Auto-press', def: 'A press that starts itself the moment any live bet hits 2 down. Optional — you can still press by hand on top of it.' },
        { term: 'Halve', def: 'A tied hole — nobody gains ground on any bet.' },
        { term: 'All square (AS)', def: 'A bet where neither side is up.' },
        { term: 'Push', def: 'A bet that ends tied — no money moves.' },
        { term: 'Best ball', def: 'In 2v2, each team counts only its lower score on a hole.' },
        { term: 'Dormie', def: 'Up exactly as many holes as remain — can no longer lose the bet.' },
        {
          term: 'Closed out (3&2)',
          def: 'Up more holes than remain, so the bet is over early — 3&2 is three up with two to play. It pays there, and its remaining holes no longer count for it (though they still count for every other live bet).',
        },
      ],
    },
  },
  configSchema: nassauConfigSchema,
  configFields: [
    { key: 'stakeCents', kind: 'money', label: 'Stake per bet', min: 100, step: 100 },
    { key: 'autoPress', kind: 'boolean', label: 'Auto-press', hint: 'New press at 2 down' },
    { key: 'teams', kind: 'teams', label: 'Teams (best ball · 2v2 or 2v1)' },
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
    autoPress: true,
  }),
  defaultHandicap: (): HandicapSettings => ({ mode: 'net', allowancePct: 100, reference: 'offLow' }),
  validateSetup: (
    config: GameConfig<NassauConfig>,
    players: readonly RoundPlayer[],
    siblings: readonly GameConfig[],
  ) => {
    const dupes = duplicateInstanceProblems(config, siblings, NASSAU_NAME)
    const parsed = nassauConfigSchema.safeParse(config.config)
    if (!parsed.success) return [...dupes, 'Invalid nassau configuration']
    const teams = parsed.data.teams
    if (teams === null) {
      return players.length === 2
        ? dupes
        : [...dupes, `${NASSAU_NAME} without teams needs exactly 2 players`]
    }
    // teams may be uneven (2v1) — the lone side just plays for more per the
    // settlement rule; only require a real two-sided partition of everyone.
    return [...nonEmptyPartitionProblems(teams, players, NASSAU_NAME), ...dupes]
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

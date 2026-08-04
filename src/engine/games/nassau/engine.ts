import { z } from 'zod'
import type { GameAction, GameEngine, GameDerivation, InputRequest, StandingLine } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { addLine, emptySettlement, formatCents, type Settlement } from '../../core/money'
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
  /**
   * The hole this bet became mathematically decided on — up more holes than
   * its stretch has left. Undefined means still live, OR level at the end
   * (a push, which never "closes" because nobody won it). So
   * `closedAt !== undefined` is exactly "this bet pays".
   */
  closedAt?: number
  /** holes that still remained in the stretch at `closedAt` — the "2" in 3&2 */
  closeToPlay?: number
}

/**
 * A finished match in golf's own notation: 3&2 is three up with two to play,
 * 2 up is a match that went the distance. One formatter, because the pinned
 * bar, the ledger, the standings detail and the settlement labels must all
 * name the same margin the same way.
 *
 * The margin is ONE UNBREAKABLE TOKEN. The share card is painted by hand and
 * word-wraps on spaces (paintSummaryCard.ts), so a plain "3 & 2" splits across
 * two lines, and so does "1 up" — leaving a card that reads "Ann wins 1" with
 * the "up" stranded below. Hence the bare ampersand and the non-breaking space.
 */
function closeMargin(up: number, toPlay: number): string {
  return toPlay > 0 ? `${up}&${toPlay}` : `${up}\u00A0up`
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
      label: SEGMENT_LABEL[seg],
      depth: 0,
      diff: 0,
      history: new Map(),
      holesRemaining: 0,
    }))

  for (const press of manualPresses.values()) {
    if (!spans[press.segment].includes(press.hole)) continue
    pressStarts.add(pressKey(press.segment, press.hole))
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

  /**
   * How many of a segment's holes come after this one — STRUCTURAL, not "how
   * many are still undecided". The two agree mid-round, but `round/completed`
   * finalizes every hole at once (core/context.ts), so an undecided count
   * would report every finished bet as won "3&0". A match won 3&2 was three up
   * with two holes left in it, whether or not those holes were played out.
   *
   * Precomputed: it is read once per (bet × decided hole) inside the walk, and
   * `derive` itself runs once per hole in the ledger's prefix replay.
   */
  const toPlayAfterBySegment: Record<Segment, Map<number, number>> = {
    front: new Map(),
    back: new Map(),
    overall: new Map(),
  }
  for (const segment of ['front', 'back', 'overall'] as const) {
    const span = spans[segment]
    span.forEach((hole, i) => toPlayAfterBySegment[segment].set(hole, span.length - 1 - i))
  }
  const toPlayAfter = (segment: Segment, hole: number) =>
    toPlayAfterBySegment[segment].get(hole) ?? 0

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
      const prev = bet.diff
      bet.diff += result
      bet.history.set(hole, bet.diff)
      const left = toPlayAfter(bet.segment, hole)
      if (Math.abs(bet.diff) > left) {
        bet.closedAt = hole
        // "3&2" is a claim that a REAL hole clinched it with two left to play.
        // A bet can also run out of room on a hole nobody played — most often
        // when the group finishes early and `round/completed` finalizes the
        // rest of the card at once. Quoting a to-play count there invents golf:
        // an 18 abandoned after 5 holes would announce "won 2&1" about a match
        // whose last 13 holes never happened. Fall back to the plain "2 up",
        // which is the honest statement — that is where the bet ended.
        bet.closeToPlay = ctx.anyScored(hole) ? left : 0
      }
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
  // either way. `holesRemaining === 0` is kept in the predicate so that case
  // reads as closed rather than perpetually live.
  const isClosed = (b: Bet) => b.closedAt !== undefined || b.holesRemaining === 0
  // A full side collectively wagers ONE stake (the 1v1/2v2 convention: a $5 bet
  // swings $5 per player). An outnumbered lone player instead plays that stake
  // against EACH opponent, so their swing scales with the other side's size —
  // this keeps an uneven 2v1 zero-sum and mirrors Wolf's lone-wolf math. With
  // ≤4 players the only uneven split is a lone side, so it stays integer.
  const sideStake = (self: readonly Uuid[], other: readonly Uuid[]) =>
    self.length === 1 ? stakeCents * other.length : stakeCents

  // Every bet — parents and presses — reported the way a golfer tracks it:
  // who's up, by how much, holes left; dormie/closed-out/final when apt.
  const sideShort = (side: 'a' | 'b') =>
    (side === 'a' ? sideA : sideB).map((id) => firstName(nameOf.get(id))).join(' & ')
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
  // Names the bet in full, for contexts that are a flat list rather than rows
  // nested under their segment: settlement lines and the per-hole notes. Goes
  // through segLabel like everything else, so a nine-hole round's single bet
  // isn't called "Overall" in the money while the ledger calls it "B9".
  const betFullLabel = (b: Bet): string =>
    b.depth === 0 ? segLabel(b.segment) : `${segLabel(b.segment)} press @${b.startHole}`

  /**
   * "Ann wins 3&2" for a decided bet; null while it is still live, and null for
   * a push (nobody won it). THE definition of a won bet, shared by the pinned
   * bar, the bet ledger, the settlement label and the hole notes — the same
   * one-helper-many-callers rule the press logic learned in MAI-34.
   *
   * The verb agrees with the side: a pair WIN, a lone player WINS. Reading it
   * off the winning side rather than hardcoding "wins" is the difference
   * between "Ann & Bob win 3&2" and the bar announcing "Ann & Bob wins 3&2"
   * on every 2v2 close.
   */
  const closedLabel = (b: Bet): string | null => {
    if (b.closedAt === undefined || b.diff === 0) return null
    const side = b.diff > 0 ? 'a' : 'b'
    const plural = (side === 'a' ? sideA : sideB).length > 1
    return `${sideShort(side)} ${plural ? 'win' : 'wins'} ${closeMargin(Math.abs(b.diff), b.closeToPlay ?? 0)}`
  }

  const settlement: Settlement = emptySettlement(playerIds)
  for (const bet of bets) {
    // A bet pays exactly when it is won — still live, or level at the end
    // (a push), and nothing moves either way.
    const won = closedLabel(bet)
    if (won === null) continue
    const winners = bet.diff > 0 ? sideA : sideB
    const losers = bet.diff > 0 ? sideB : sideA
    const winEach = sideStake(winners, losers)
    const loseEach = sideStake(losers, winners)
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
        const seg = b.segment === 'overall' ? '18' : b.segment === 'front' ? 'F9' : 'B9'
        // A decided bet takes ✓/✗ rather than an arrow: "↓2 up" reads as a
        // contradiction, and the margin token itself says the match is over.
        if (b.closedAt !== undefined) {
          return `${seg} ${d > 0 ? '✓' : '✗'}${closeMargin(Math.abs(d), b.closeToPlay ?? 0)}`
        }
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
  ): { trailing: 'a' | 'b'; by: number } | null => {
    const decided = spans[segment].filter((h) => h < asOf && (holeResult.get(h) ?? null) !== null)
    const at = decided[decided.length - 1]
    if (at === undefined) return null
    let worst = 0
    for (const b of bets) {
      if (b.segment !== segment || b.startHole >= asOf) continue
      if (b.closedAt !== undefined && b.closedAt < asOf) continue
      const d = b.history.get(at)
      if (d !== undefined && Math.abs(d) > Math.abs(worst)) worst = d
    }
    if (worst === 0) return null
    return { trailing: worst > 0 ? 'b' : 'a', by: Math.abs(worst) }
  }

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
  const livePresses = ordered.filter((b) => b.depth > 0 && !isClosed(b)).length
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
      const why = down ? `${sideShort(down.trailing)} ${down.by} down · ${toPlay} to play` : `${toPlay} to play`
      // Quote the stake to the side being INVITED to press — the one that's
      // down. In a 2-v-1 the lone player books this bet against each opponent,
      // so a "$5" press costs them $10; telling them $5 in the one line meant
      // to say what they're signing up for would be the wrong number.
      const stake = down
        ? sideStake(
            down.trailing === 'a' ? sideA : sideB,
            down.trailing === 'a' ? sideB : sideA,
          )
        : stakeCents
      actions.push({
        id: `nassau-press-${seg}-${frontier}`,
        gameId: game.gameId,
        hole: frontier,
        label: `Press ${segLabel(seg)}`,
        detail: why,
        effect: `${taken ? 'Running' : 'New'} ${formatCents(stake)} bet · ${span}`,
        // nothing to recommend once it's running
        recommended: !taken && (down?.by ?? 0) >= 2,
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
          ? `${sideShort(down.trailing)} ${down.by} down${auto ? ' → auto-press' : ' → pressed'}`
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
  // prefix replay, and a hole nobody scored only becomes final once play moves
  // PAST it (core/context.ts `finalized`) — so a bet decided on a skipped hole
  // first shows its money on the next hole ANYONE played. Attribute the note
  // there or the ledger drops the row (no score, no delta) and the money turns
  // up later with nothing explaining it.
  //
  // Searched over the whole round, NOT the bet's own segment: a front-nine bet
  // can be decided on a skipped 6th and have holes 7–9 skipped too, with play
  // resuming on the 10th. That is the hole the money appears on, even though it
  // belongs to a different bet.
  const playedHoles = ctx.holesPlayed.filter((h) => ctx.anyScored(h))
  for (const b of ordered) {
    if (!isClosed(b)) continue
    // No played hole at or after the close — a bet finished off by
    // `round/completed` over holes nobody reached — falls back to the last hole
    // actually played, which is where completion's money lands.
    const closeAt =
      (b.closedAt !== undefined ? playedHoles.find((h) => h >= b.closedAt!) : undefined) ??
      playedHoles[playedHoles.length - 1]
    if (closeAt !== undefined) note(closeAt, `${betLabel(b)} closes — ${betValue(b)}`)
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
    { key: 'stakeCents', kind: 'money', label: 'Stake per bet' },
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
  validateSetup: (config: GameConfig<NassauConfig>, players: readonly RoundPlayer[]) => {
    const parsed = nassauConfigSchema.safeParse(config.config)
    if (!parsed.success) return ['Invalid nassau configuration']
    const teams = parsed.data.teams
    if (teams === null) {
      return players.length === 2 ? [] : ['Nassau without teams needs exactly 2 players']
    }
    // teams may be uneven (2v1) — the lone side just plays for more per the
    // settlement rule; only require a real two-sided partition of everyone.
    return nonEmptyPartitionProblems(teams, players, 'Nassau')
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

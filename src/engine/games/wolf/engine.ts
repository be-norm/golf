import { z } from 'zod'
import type { GameEngine, GameDerivation, InputRequest } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { emptySettlement, type Settlement } from '../../core/money'
import { sideStake } from '../../core/match'
import { duplicateInstanceProblems } from '../../core/setup'
import { glyph } from '../../core/glyphs'
import { standingsFromSettlement } from '../../core/standings'
import { joinNames, latestHoleSummary, summaryString } from '../../core/summary'
import { isPlayerPermutation } from '../../core/teams'
import type { GameConfig, HandicapSettings, RoundPlayer, Uuid } from '../../core/types'

export const wolfConfigSchema = z.object({
  /** the hole's value to each player; a point IS a stake (see HOLE_UNITS) */
  pointCents: z.number().int().positive(),
  /** wolf order: rotation[0] is the wolf on the first hole played */
  rotation: z.array(z.string()),
})

export type WolfConfig = z.infer<typeof wolfConfigSchema>

/**
 * WHAT ONE OPPONENT IS WORTH on a hole. Every player has this much on the line;
 * going lone doubles the hole and blind triples it, for everyone. That is the
 * risk premium, and the only thing these three numbers say.
 *
 * A POINT HERE IS A STAKE, NOT A SCORE. The map this engine records per hole is
 * the signed SWING — what each player won or lost — so money is simply
 * `swing × pointCents` and "$1 a point" means a $1 hole. It used to be a
 * traditional non-negative Wolf score settled on the gaps between players, and
 * the two conventions disagreed: a lone WIN was awarded to one player (and so
 * tripled by the gap formula) while a lone LOSS was spread across three (and so
 * wasn't). Lone paid +$12/−$3 against partnering's +$4/−$6 — triple the upside
 * and half the downside, which made going lone the answer roughly always and
 * collapsed the decision the game is built on (MAI-83).
 *
 * Ties halve the hole. After the rotation runs out (holes 17–18, or the 9th
 * hole of a nine), the player with the fewest points is the wolf — still the
 * trailing player now that the totals can go negative.
 *
 * LONE AND BLIND ARE SYMMETRIC ON PURPOSE, and that is a design decision, not
 * an oversight. It means going lone breaks even only when your single ball
 * beats the best of three MORE THAN HALF the time — realistically a quarter to
 * a third, even off a great drive — so the wolf should usually decline, and
 * takes it when they are genuinely, visibly confident. That is the call the
 * option is meant to be.
 *
 * Traditional tables instead pay a premium for going lone (win 4 against a
 * partnered 2) to price the 1-v-3 odds, and a reviewer will reasonably ask for
 * one. We chose otherwise: a premium makes lone the default play, which is the
 * failure this whole change fixed, just at a gentler slope. If it is ever
 * revisited, change the multipliers deliberately — a lone win worth 3 holes
 * against a loss worth 1 gives the wolf +9/−3 and a ~25% break-even, still
 * zero-sum — rather than letting an asymmetry emerge from two conventions
 * disagreeing, which is how the original bug happened.
 */
const HOLE_UNITS: Record<WolfPick['kind'], number> = {
  partner: 1,
  lone: 2,
  blind: 3,
}

export type WolfPick =
  | { kind: 'partner'; partnerId: Uuid }
  | { kind: 'lone' }
  | { kind: 'blind' }

export interface WolfHoleResult {
  hole: number
  wolfId: Uuid
  pick: WolfPick | null
  /**
   * The sides the pick made, or null with no pick. Resolved BEFORE the hole is
   * finalized, because the teams are what the group needs on screen while they
   * are still playing the hole — not only once it settles.
   */
  sides: { wolf: Uuid[]; pack: Uuid[] } | null
  /**
   * Each side's best net ball once the hole is decided — NULL for a side that
   * posted nothing, never `Infinity`. The comparison upstairs coerces to
   * Infinity so a side with no scores loses; storing that would hand the first
   * consumer to trust this doc a `"net Infinity"` to print. The WINNING side is
   * always non-null (it posted, or it could not have won).
   */
  best: { wolf: number | null; pack: number | null } | null
  /** the signed SWING this hole, by player — sums to zero (see HOLE_UNITS) */
  points: Map<Uuid, number> | null
  outcome: 'wolfWin' | 'packWin' | 'halved' | 'pending'
}

function derive(
  game: GameConfig<WolfConfig>,
  events: readonly GameScopedEvent[],
  ctx: RoundContext,
): GameDerivation {
  const { pointCents, rotation } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))
  const n = playerIds.length

  const picks = new Map<number, WolfPick>()
  /** who was the wolf when the pick was recorded, for picks that say (below) */
  const declaredBy = new Map<number, Uuid>()
  for (const e of events) {
    if (e.kind !== 'wolf/pick') continue
    const data = e.data as { hole: number; choice: string; wolf?: string }
    picks.set(
      data.hole,
      data.choice === 'lone'
        ? { kind: 'lone' }
        : data.choice === 'blind'
          ? { kind: 'blind' }
          : { kind: 'partner', partnerId: data.choice },
    )
    // Last write wins here too, and absence must CLEAR: a re-pick recorded by
    // an older build carries no wolf, and inheriting the previous event's
    // would attribute it to whoever the first pick named.
    if (data.wolf === undefined) declaredBy.delete(data.hole)
    else declaredBy.set(data.hole, data.wolf)
  }

  const totals = new Map<Uuid, number>(playerIds.map((id) => [id, 0]))
  const rotationHoles = ctx.holesPlayed.length - (ctx.holesPlayed.length % n)
  const holeResults: WolfHoleResult[] = []

  ctx.holesPlayed.forEach((hole, idx) => {
    // wolf assignment: rotation, then fewest-points (ties: earliest in rotation)
    let wolfId: Uuid
    if (idx < rotationHoles) {
      wolfId = rotation[idx % n]!
    } else {
      wolfId = [...rotation].sort(
        (a, b) => totals.get(a)! - totals.get(b)! || rotation.indexOf(a) - rotation.indexOf(b),
      )[0]!
    }

    // A PICK CAN GO STALE LEGITIMATELY. On trailing-player holes (17–18, or the
    // 9th of a nine) the wolf is whoever has fewest points, so a score
    // correction can reassign it after the pick was recorded. Treat an orphaned
    // pick as pending so the prompt re-appears, rather than computing on it.
    //
    // TWO WAYS TO GO STALE, and the second one only became visible when the
    // screen started STATING the pick (MAI-84). A partner pick shows itself: it
    // names the wolf, or names nobody in the round. A lone or blind
    // declaration doesn't — reassign the wolf and it silently becomes someone
    // else's declaration, and the app then says "D went blind" about a call D
    // never made. So the pick records who was the wolf when it was made
    // (`options[].data`, which exists for exactly this), and a mismatch is
    // stale. Picks written before this carry no `wolf` and are left alone:
    // absence means we cannot know, not that it disagrees.
    //
    // ON A TRAILING-PLAYER HOLE THE WOLF IS PROVISIONAL until every earlier
    // hole has finalized, and the group can pick under a provisional one: leave
    // the 8th unfinished, and the 9th tee's wolf is computed from holes 1–7. The
    // first score entered on the 9th finalizes the 8th, the totals move, and the
    // pick can go stale right there — the panel reverts to the prompt mid-hole
    // and the group re-declares. That interruption is the correct answer (the
    // wolf really did change, and the alternative is the silent
    // mis-attribution this rule exists to stop) but it is a real behaviour, so
    // it is pinned by a test rather than left to be discovered on a Saturday.
    const rawPick = picks.get(hole) ?? null
    const declared = declaredBy.get(hole)
    const stale =
      (rawPick?.kind === 'partner' &&
        (rawPick.partnerId === wolfId || !playerIds.includes(rawPick.partnerId))) ||
      (declared !== undefined && declared !== wolfId)
    const pick = stale ? null : rawPick

    // Sides resolve as soon as the pick does — the scoring screen states them
    // above the score rows while the hole is still being played (MAI-84).
    const wolfSide: Uuid[] = pick
      ? pick.kind === 'partner'
        ? [wolfId, pick.partnerId]
        : [wolfId]
      : []
    const packSide = playerIds.filter((id) => !wolfSide.includes(id))
    const sides = pick ? { wolf: wolfSide, pack: packSide } : null

    if (!pick || !ctx.finalized(hole)) {
      holeResults.push({ hole, wolfId, pick, sides, best: null, points: null, outcome: 'pending' })
      return
    }

    // shared posted-only best ball: a side with no scores can't win. The
    // Infinity is a COMPARISON device and stays local to it — `best` keeps the
    // honest null (see WolfHoleResult).
    const posted = {
      wolf: ctx.bestNetAmongPosted(game.gameId, wolfSide, hole),
      pack: ctx.bestNetAmongPosted(game.gameId, packSide, hole),
    }
    const wolfBest = posted.wolf ?? Infinity
    const packBest = posted.pack ?? Infinity
    // NOBODY POSTED — which is the same statement as `!ctx.anyScored(hole)`,
    // since the two sides between them are every player. This is NOT a halved
    // hole, and calling it one was a claim about golf that never happened:
    // `ctx.finalized` goes true for EVERY hole the moment the round completes,
    // so a group finishing on the 12th had 13–18 reported as halved — in the
    // ledger, in the standings sheet, and on the pinned bar (MAI-38).
    //
    // Pending is the one bucket that means "no result", so fixing it HERE fixes
    // every consumer at once; guarding each narration channel separately is how
    // the bar kept saying it after `holeSummary` was fixed. No money either way
    // — this branch never touched `totals`.
    if (wolfBest === Infinity && packBest === Infinity) {
      holeResults.push({ hole, wolfId, pick, sides, best: null, points: null, outcome: 'pending' })
      return
    }

    const points = new Map<Uuid, number>(playerIds.map((id) => [id, 0]))
    let outcome: WolfHoleResult['outcome']
    if (wolfBest === packBest) {
      outcome = 'halved'
    } else {
      outcome = wolfBest < packBest ? 'wolfWin' : 'packWin'
      // keyed by the pick's own discriminant, so a new kind is a compile error
      // rather than silently falling through to the partnered stake
      const units = HOLE_UNITS[pick.kind]
      // `sideStake` is the rule, not a table: an OUTNUMBERED player settles the
      // hole against EACH opponent, evenly-matched sides settle it once. Same
      // primitive Nassau uses for its 2-v-1.
      //
      // IT BALANCES FOR EVEN SIDES OR A LONE SIDE — not for any split. A 2-v-3
      // does NOT (2×1 against 3×1 leaves a unit behind), which match.test.ts
      // states outright. Every split a FOURSOME can deal is one of the two that
      // work, and `validateSetup` holds Wolf to exactly four; the catalog's
      // 3/5-player variants would need this rule generalised first. That pairing
      // is load-bearing, so `wolf.test.ts` asserts the holes balance at every
      // player count `validateSetup` accepts — raise the cap and it fails.
      const stakeSides = { a: wolfSide, b: packSide }
      const sign = wolfBest < packBest ? 1 : -1
      const wolfShare = sideStake(units, stakeSides, 'a')
      const packShare = sideStake(units, stakeSides, 'b')
      for (const id of wolfSide) points.set(id, sign * wolfShare)
      for (const id of packSide) points.set(id, -sign * packShare)
    }

    for (const [id, p] of points) totals.set(id, totals.get(id)! + p)
    holeResults.push({
      hole,
      wolfId,
      pick,
      sides,
      best: posted,
      points,
      outcome,
    })
  })

  // A point IS a stake here, so money is the swing at face value — no gap
  // formula between the points and the dollars, which is what let the two drift
  // apart before (MAI-83). Zero-sum follows from each hole's swing summing to
  // zero, which `sideStake` guarantees above and `wolf.test.ts` pins directly.
  const settlement: Settlement = emptySettlement(playerIds)
  for (const id of playerIds) {
    settlement.perPlayerCents[id] = pointCents * totals.get(id)!
  }
  // Totals are signed now, so they are written signed: "+6 pts" / "−12 pts".
  // An unsigned "-12 pts" beside "-$12" reads like the minus belongs to the
  // money alone.
  const ptsLabel = (id: Uuid) => {
    const t = totals.get(id)!
    return `${t > 0 ? '+' : ''}${t} pt${Math.abs(t) === 1 ? '' : 's'}`
  }
  // Itemised per PLAYER rather than per transaction, which is why a player
  // sitting level still gets a $0 row — the known MAI-75 violation of
  // "settlement.lines is money that MOVED", asserted by its own self-retiring
  // test in replay.test.ts rather than left as a silent exception.
  settlement.lines = playerIds.map((id) => ({
    label: `${nameOf.get(id)} — ${ptsLabel(id)}`,
    perPlayerCents: { [id]: settlement.perPlayerCents[id]! },
  }))

  const standings = standingsFromSettlement(players, settlement, (p) => ptsLabel(p.playerId))

  // Bar recaps the latest decided hole — "H4 · Ben lone +6" / "Ben & Rob +1".
  const pickTag = (r: WolfHoleResult): string =>
    r.pick!.kind === 'partner'
      ? `& ${nameOf.get(r.pick!.partnerId)}`
      : r.pick!.kind === 'blind'
        ? 'blind'
        : 'lone'
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const r = holeResults.find((h) => h.hole === hole)
      if (!r || r.outcome === 'pending') return null
      const wolfName = nameOf.get(r.wolfId)
      if (r.outcome === 'halved') return `${wolfName} ${pickTag(r)} · halved`
      const gainers = [...r.points!.entries()].filter(([, p]) => p > 0)
      const pts = gainers[0]?.[1] ?? 0
      const names = gainers.map(([id]) => nameOf.get(id)).join(' & ')
      // the mode tag rides on ANY solo hole, won or lost ("Ben lone +6" /
      // "Colby & DJ & Grant +2 · lone"): the multiplier is what makes those
      // numbers surprising, and it is the losing side that sees the big one
      const solo = r.pick!.kind !== 'partner'
      // won or LOST. The multiplier is why the number is what it is, and the
      // loser of a blind hole moves nine stakes — dropping the tag there left
      // "+3" on the bar with nothing explaining why it wasn't "+1".
      return solo
        ? r.outcome === 'wolfWin'
          ? `${names} ${pickTag(r)} +${pts}`
          : `${names} +${pts} · ${pickTag(r)} lost`
        : `${names} +${pts}`
    },
    'no points yet',
  )
  const summary = summaryString(summaryParts)

  // THE WOLF SIDE, marked. `(W)` for an ordinary partnered hole; the pixel wolf
  // for lone and the same wolf in shades for blind — each followed by the word,
  // because a 16px picture cannot teach what "blind" costs (core/glyphs.ts).
  const wolfSideLabel = (r: WolfHoleResult): string => {
    const kind = r.pick!.kind
    // SOLO: the side is one player, so nothing is ambiguous and the glyph leads
    // the line as the mode's mark.
    if (kind !== 'partner') {
      const mark = kind === 'lone' ? glyph('wolf') : glyph('wolf-shades')
      return `${mark} ${joinNames(r.sides!.wolf, nameOf)} (${kind})`
    }
    // PARTNERED: `(W)` marks the PLAYER, not the pair. Leading the pair with it
    // left "which of these two called it?" answerable only by knowing that
    // `sides.wolf` happens to put the wolf first — so on the commonest hole
    // shape the ledger still didn't say whose hole it was.
    const [w, ...rest] = r.sides!.wolf
    const partner = rest.length > 0 ? ` & ${joinNames(rest, nameOf)}` : ''
    return `${nameOf.get(w!)} (W)${partner}`
  }
  const packLabel = (r: WolfHoleResult): string => joinNames(r.sides!.pack, nameOf)
  /** The teams, as the scoring screen stacks them above the score rows. */
  const teamLines = (r: WolfHoleResult): string[] => [wolfSideLabel(r), 'vs.', packLabel(r)]

  // The wolf must decide on any hole that's being scored (or is next up) and
  // has no pick yet — a blocking chip, since the hole can't compute without it.
  //
  // AND THE ANSWERED ONES STAY (MAI-84). The teams used to vanish the moment
  // they were picked, leaving no way to see them and no way to fix a mistap.
  // An answered request carries `answered`, which the screen renders as a quiet
  // statement with an Adjust affordance rather than a gold interrupt.
  const frontier = ctx.holesPlayed.find(
    (h) => !playerIds.every((id) => ctx.gross.get(id)?.get(h) !== undefined),
  )
  const requiredInputs = (): InputRequest[] => {
    const inputs: InputRequest[] = []
    for (const r of holeResults) {
      if (!r.pick) {
        const anyScore = ctx.anyScored(r.hole)
        // The frontier pre-prompt is "the tee you are standing on" — once the
        // round is over nobody is standing on it, and asking for a pick on a
        // hole nobody played is the same fabrication `derive` refuses further
        // up: a group walking in on the 12th would be asked about the 13th
        // (MAI-38).
        if (!anyScore && (ctx.completed || r.hole !== frontier)) continue
      }
      const wolfName = nameOf.get(r.wolfId)
      inputs.push({
        id: `wolf-pick-${r.hole}`,
        gameId: game.gameId,
        hole: r.hole,
        prompt: `${glyph('wolf')} Hole ${r.hole}: ${wolfName} rides with…`,
        // every option carries the wolf it was offered under, so a pick can be
        // recognised as stale when a score correction reassigns the wolf
        options: [
          ...playerIds
            .filter((id) => id !== r.wolfId)
            .map((id) => ({ value: id, label: nameOf.get(id)!, data: { wolf: r.wolfId } })),
          { value: 'lone', label: `${glyph('wolf')} Lone Wolf`, data: { wolf: r.wolfId } },
          {
            value: 'blind',
            label: `${glyph('wolf-shades')} Blind Wolf`,
            data: { wolf: r.wolfId },
          },
        ],
        eventKind: 'wolf/pick',
        ...(r.pick && {
          answered: {
            value: r.pick.kind === 'partner' ? r.pick.partnerId : r.pick.kind,
            lines: teamLines(r),
          },
        }),
      })
    }
    return inputs
  }

  const isNet = game.handicap?.mode === 'net'
  const scoreTag = (n: number) => (isNet ? `net ${n}` : `${n}`)
  /**
   * "Benjamin's net 4" — the possessive drops in the two cases where it says
   * nothing. Two partners both round in 4 and naming either is a half-truth;
   * and a lone wolf is the only player on their side, so "B wins with B's 3"
   * just says B twice.
   */
  const madeIt = (side: readonly Uuid[], best: number, hole: number): string => {
    if (side.length < 2) return ''
    const at = side.filter((id) => ctx.netFor(game.gameId, id, hole) === best)
    // FULL name, like the rest of the sentence. `firstName` is for the bar's
    // compact chips, and two Mikes in a foursome is an ordinary Saturday —
    // "Mike Ross & Mike Doyle win with Mike's 4" names nobody.
    return at.length === 1 ? `${nameOf.get(at[0]!)}'s ` : ''
  }

  /**
   * ONE SENTENCE, then the cause. It used to enumerate every player's swing —
   * which the money ledger prints again as cash directly underneath, and the
   * standings sheet prints again as points above, so each name appeared three
   * times on one card (MAI-84). The ledger's own delta row is the movement; the
   * narration's job is to say who won the hole and with what.
   */
  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r) return []
    // Pending covers a hole nobody played, because `derive` files it that way
    // rather than as a halve — see the nobody-posted branch.
    if (r.outcome === 'pending') {
      // `vs.` with the stop, the same token `teamLines` stacks — the ledger and
      // the scoring panel state the same two sides and must not word it twice.
      return r.sides
        ? [`${wolfSideLabel(r)} vs. ${packLabel(r)}`]
        : [`Wolf: ${nameOf.get(r.wolfId)}`]
    }
    // No cause line: nothing moved, so the multiplier did nothing to explain —
    // and the label already carries the word "(lone)" / "(blind)". A halve is
    // two EQUAL posted balls, so both sides posted; the nobody-posted case is
    // filed as pending and the guard above already took it.
    if (r.outcome === 'halved') {
      const at = r.best?.wolf != null ? ` at ${scoreTag(r.best.wolf)}` : ''
      return [`${wolfSideLabel(r)} — halved${at}`]
    }
    const kind = r.pick!.kind
    // The multiplier is why these numbers look unlike a partnered hole's. It no
    // longer has to name the wolf — the headline always does now, with the mode
    // in the label — so this says only the part the label can't.
    const cause =
      kind === 'lone'
        ? ['↳ lone wolf — the hole doubles']
        : kind === 'blind'
          ? ['↳ blind wolf — the hole triples']
          : []
    const wolfWon = r.outcome === 'wolfWin'
    const side = wolfWon ? r.sides!.wolf : r.sides!.pack
    // The WINNING side's ball is never null — a side that posted nothing
    // compares as Infinity and cannot have won.
    const best = (wolfWon ? r.best!.wolf : r.best!.pack)!
    const won = `${madeIt(side, best, hole)}${scoreTag(best)}`
    // THE WOLF IS NAMED ON EVERY DECIDED HOLE. Winners lead either way, but a
    // pack win has no wolf in it, and dropping them there left roughly a
    // quarter of holes unable to say whose hole it was — the two losing names
    // are in the money row, with nothing marking which of them called it. The
    // wolf-win and halved lines never had this problem; only this one did.
    return wolfWon
      ? [`${wolfSideLabel(r)} ${side.length === 1 ? 'wins' : 'win'} with ${won}`, ...cause]
      : [`${packLabel(r)} beat ${wolfSideLabel(r)} — ${won}`, ...cause]
  }

  /**
   * A HOLE THAT WAS PLAYED AND NEVER DECLARED PAYS NOTHING, and until now the
   * only place that said so was the hole's own panel — one hole out of
   * eighteen, on a screen you have to already be standing on.
   *
   * That was survivable while a missing pick meant "nobody tapped it". It stopped
   * being survivable when the staleness rule widened to lone and blind (MAI-84):
   * a score correction on an earlier hole can now drop a declaration that was
   * made, and on a solo call that hole is the biggest swing on the card — six or
   * nine stakes — quietly settling for zero.
   *
   * `notes` is the round-level channel for exactly this, it renders on both the
   * standings sheet and the settle screen, and it is NOT money (MAI-40), so the
   * "No money moved." signal stays honest.
   *
   * ONLY ONCE THE ROUND IS OVER, which is the same rule CTP's dead money
   * follows and for the same reason: `ctx.finalized` goes true the moment the
   * last score lands, so a hole would report itself dead while the group is
   * still standing on that tee with the prompt in front of them. A thing is
   * missing exactly when it can no longer be supplied — and by then the money
   * is final, the settle screen is what they are looking at, and Reopen is the
   * answer. Holes nobody played are skipped: they have nothing to lose.
   *
   * Plain text — `notes` is one of the channels no screen decodes, so a glyph
   * here would reach the share card's painter as a literal token.
   */
  const missed = ctx.completed
    ? holeResults.filter((r) => !r.pick && ctx.anyScored(r.hole)).map((r) => r.hole)
    : []
  const notes =
    missed.length > 0
      ? [
          `${missed.length === 1 ? 'Hole' : 'Holes'} ${missed.join(', ')}: no wolf declared — nothing settled there.`,
        ]
      : undefined

  return {
    standings,
    summary,
    summaryParts,
    holeSummary,
    requiredInputs,
    settlement,
    ...(notes && { notes }),
  }
}

/** The one name for this game — `meta.name` and every message that has to
 *  say it. label.ts is the single source of a game's name (MAI-42), so a
 *  second literal in `validateSetup` would drift the moment this is renamed. */
const WOLF_NAME = 'Wolf'

export const wolfEngine: GameEngine<WolfConfig> = {
  type: 'wolf',
  meta: {
    name: WOLF_NAME,
    blurb: 'Rotating Wolf picks a partner off the tee — or goes lone for double.',
    minPlayers: 4,
    maxPlayers: 4,
    category: 'main',
    family: 'points',
    // the wolf picks a new partner every hole — sides never persist
    shapes: ['partners'],
    rules: {
      tagline: 'A rotating captain picks a partner off the tee — or goes it alone for more.',
      howToPlay: [
        'The Wolf rotates each hole in your setup order — everyone takes a turn every four holes.',
        'Watching the tee shots, the Wolf picks a partner for the hole — or declares Lone Wolf and plays 1 against 3. Declaring Blind Wolf (before anyone swings) raises the stakes further.',
        'Best net ball of each side decides the hole. A tie halves it — nobody scores.',
        'When the rotation runs out (holes 17–18, or the 9th of a nine), the player with the fewest points is the Wolf.',
        "Missing a score? A side's best ball counts whoever posted.",
      ],
      scoring: [
        'Every hole is worth the stake to each player: win your side of it and you collect, lose it and you pay. A point is a stake, so $1 a point means a $1 hole.',
        'Going Lone Wolf DOUBLES the hole and Blind Wolf TRIPLES it — for everyone, not just the wolf.',
        'The wolf alone plays that stake against EACH of the other three. At $1 a hole: a lone win pays the wolf $6 and costs each opponent $2, and a lone loss is the exact mirror. Blind is $9 and $3.',
        'With a partner it is two against two, so a won hole is worth one stake to each of the four players.',
        'A tie halves the hole — nobody scores. Points can go negative, and the lowest total takes the wolf when the rotation runs out.',
      ],
      terms: [
        { term: 'Wolf', def: "The hole's captain: tees last, watches the drives, makes the pick." },
        { term: 'Lone Wolf', def: 'The Wolf declining all partners to play 1 v 3 for double the hole — against each opponent, so a win pays six stakes and a loss costs six.' },
        {
          term: 'Blind Wolf',
          def: 'Going lone before anyone has hit — triple the hole, maximum swagger. Nine stakes either way in a foursome.',
        },
        { term: 'The pack', def: 'Everyone not on the Wolf side of a hole.' },
        { term: 'Best ball', def: "A side's lowest net score — the only one that counts." },
      ],
    },
  },
  configSchema: wolfConfigSchema,
  configFields: [
    { key: 'pointCents', kind: 'money', label: 'Per hole', min: 25, step: 25, hint: "Each player's stake; lone doubles it, blind triples" },
    { key: 'rotation', kind: 'rotation', label: 'Wolf order' },
  ],
  defaultConfig: (players) => ({
    pointCents: 100,
    rotation: players.map((p) => p.playerId),
  }),
  defaultHandicap: (): HandicapSettings => ({ mode: 'net', allowancePct: 100, reference: 'offLow' }),
  validateSetup: (
    config: GameConfig<WolfConfig>,
    players: readonly RoundPlayer[],
    siblings: readonly GameConfig[],
  ) => {
    // Reported alongside whatever else is wrong rather than behind it: a
    // duplicate is independent of the roster, and hiding it until the roster is
    // fixed makes the user solve one problem to discover the next.
    const dupes = duplicateInstanceProblems(config, siblings, WOLF_NAME)
    if (players.length !== 4) return [...dupes, `${WOLF_NAME} needs exactly 4 players`]
    const parsed = wolfConfigSchema.safeParse(config.config)
    if (!parsed.success) return [...dupes, 'Invalid wolf configuration']
    if (!isPlayerPermutation(parsed.data.rotation, players))
      return [...dupes, `${WOLF_NAME} order must include every player exactly once`]
    return dupes
  },
  eventKinds: {
    'wolf/pick': z.object({
      hole: z.number().int().min(1).max(18),
      choice: z.string(),
      /** who was the wolf when this was recorded — absent on pre-MAI-84 picks */
      wolf: z.string().optional(),
    }),
  },
  derive,
}

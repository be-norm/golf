import type { RoundContext } from './context'
import type { GameScopedEvent } from './events'
import { addLine, emptySettlement, type Settlement } from './money'
import type { Award, Uuid } from './types'

/**
 * The award-pot kit — one winner per eligible hole, collecting a stake from
 * everybody else.
 *
 * CTP owned all of this privately (MAI-46). Long Drive is the same bet decided
 * on a different set of holes, and greenies, sandies and the rest of Dots' menu
 * are the same again — so the shape is extracted before the second copy exists
 * rather than after the fifth, which is the mistake `standingsFromSettlement`
 * was written to undo.
 *
 * What is here is the MECHANICAL half, and it is the half that is subtle: when a
 * hole counts as decided, when an unawarded one is dead rather than merely
 * quiet, and what a tap-to-undo has to retract. Both of those questions have a
 * regression behind them (see the walk below), and neither is something a new
 * award game should have to rediscover by reading CTP.
 *
 * What is NOT here is every word the player reads: the group label, the
 * settlement line, the notes, the standings subtitle, `summaryParts` and
 * `holeSummary` all stay in the engine. Same split as `core/match`, where
 * `closeMargin` is shared and each game narrates for itself — a kit that owned
 * the vocabulary would make every award game sound like the first one.
 */

export type AwardHoleResult =
  /**
   * eligible, played, decided: this player was given it, and it paid `units`
   * awards — one for this hole plus anything carried in (always 1 with
   * carryover off)
   */
  | { hole: number; kind: 'won'; winnerId: Uuid; units: number }
  /** eligible and played, but the hole hasn't settled yet */
  | { hole: number; kind: 'pending' }
  /** eligible, played out, and nobody was ever given it — carryover OFF */
  | { hole: number; kind: 'unclaimed' }
  /**
   * eligible, played out, nobody given it, and its stake rolled onto the next
   * eligible hole — carryover ON. `carryAfter` is the whole pile riding after
   * this hole, not this hole's contribution.
   */
  | { hole: number; kind: 'carried'; carryAfter: number }

export interface AwardPotSpec {
  gameId: Uuid
  /** what one award is worth; the winner collects this from each other player */
  stakeCents: number
  /**
   * Which holes this game plays for — CTP's par 3s, Long Drive's designated
   * holes. Called only for holes in `ctx.holesPlayed`, so an engine may read
   * `ctx.par` freely and a config naming a hole this round doesn't play simply
   * never comes up.
   */
  eligible(hole: number): boolean
  /** the award grid's row, and the group every cell belongs to */
  group: string
  /** the game event kind one tap appends */
  eventKind: string
  /**
   * `units` is what the hole paid — 1, or more when a carry banked on it. A
   * game with `carryover` off may ignore the parameter entirely.
   */
  lineLabel(hole: number, winnerName: string, units: number): string
  /**
   * AN UNAWARDED HOLE ROLLS ITS STAKE ONTO THE NEXT ELIGIBLE HOLE, and only
   * ever onto an eligible one: the loop below visits nothing else, so a CTP
   * carry hops par 3 to par 3 and the par 4s and 5s between them cannot
   * touch it, however many of them get played.
   *
   * IT IS DECLARED ON `finalized`, NOT ON `completed` — deliberately the
   * opposite of the unclaimed rule twenty lines down, and the two are not in
   * tension. Dead money must wait for the round to end because a hole is
   * unclaimed exactly when it can no longer be claimed. A carry is the other
   * direction entirely: it says the money is still LIVE and worth more on the
   * next eligible hole, which is the one thing the group needs to know while
   * standing on that tee. Waiting for `completed` would price every carry
   * after the last chance to play for it, which is the whole feature.
   *
   * The cost is that it can be provisionally wrong, and that is the honest
   * trade: an award recorded late (the channel exists to allow it) un-carries
   * the pile on the next derive, exactly as a corrected score re-prices a
   * hole. It re-prices FORWARD to the truth, and never announces dead money
   * that wasn't.
   *
   * AND A HOLE CARRIES ONLY IF THERE IS A LATER ELIGIBLE HOLE TO CARRY ONTO —
   * the third clause, and the one that keeps the second honest. Without it the
   * last par 3 goes "carried" the moment it finalizes, so from there to
   * `round/completed` the bar says a pile is riding onto a par 3 that does not
   * exist. That is MAI-38's exact lesson ("'carried' promises the pile rolls
   * onto a hole that no longer exists"), and it would have been reintroduced
   * here while citing it.
   *
   * Skins' gate for the same problem — every hole finalized — is unavailable:
   * it fires the moment one player picks up, which is the OTHER regression the
   * block below exists to prevent. So the question is asked positionally
   * instead (`lastEligibleIdx`). Until the round ends the last eligible hole
   * stays `pending`, which is the truth: nothing has carried anywhere, and the
   * money is still claimable on that very hole because its cell is still lit.
   */
  carryover?: boolean
}

export interface AwardPot {
  holeResults: AwardHoleResult[]
  settlement: Settlement
  /**
   * How many awards each player took, for the standings subtitle — a carried
   * hole counts once per unit, so winning a doubled hole is "2", matching the
   * money rather than the hole count.
   */
  wonByPlayer: Map<Uuid, number>
  /**
   * Stakes riding on the next eligible hole; always 0 with carryover off, and
   * ZEROED ONCE THE PILE IS DEAD — a dead pile is not riding anywhere, and
   * `carryDied` is where it goes on being counted.
   *
   * Deliberately not "the pile, live or dead": the kit exists so a third award
   * game inherits these answers, and a field whose correct use requires
   * remembering to pair it with another one is a trap. Read alone it would have
   * advertised a live bet on a settled round.
   *
   * NOTE THAT `SkinsDerivation.carrying` IS THE OTHER CONVENTION — it keeps
   * reporting the pile after `carryDied` fires. Nothing reads it, so nothing is
   * broken, but the two names now mean subtly different things across the
   * catalog and this is the one to copy: Skins gets away with it only because
   * it has no `openBet`.
   */
  carrying: number
  /**
   * Carried stakes that can never be won now — the round is over with the pile
   * still riding. Same gate as `unclaimed` and for the same reason: until
   * `ctx.completed` the cell is still lit and somebody can still be given it.
   */
  carryDied: number
  /**
   * The eligible hole the dead pile was sitting on — the last one played, since
   * any award banks the pile. Where the engine narrates the death, so a private
   * copy of the rule can't strand the sentence on a different row from the hole
   * it explains. Undefined unless `carryDied > 0`.
   *
   * DELIBERATELY NOT `ctx.lastPlayedHole`, which is what Skins' dead carry uses
   * (see the note under `awardedUnscored` for the other half of this).
   * For Skins the two coincide, because every hole is eligible there — an award
   * game is the case that separates them, and `lastPlayedHole` would put "3 CTPs
   * died unwon" on a par 4's ledger row, narrating a hole this game has no
   * business in. The row survives either way: `buildHoleLedger` keeps a hole
   * whose `holeSummary` says something and which somebody scored.
   */
  diedAt?: number
  /**
   * Eligible holes holding a recorded winner that NOBODY EVER SCORED, once the
   * round is over — the residual gap left by "a score is the only evidence a
   * hole was played", handed to the engine so the gap is SAID rather than
   * silent.
   *
   * The money abstains on these holes, and it is right to (the gate above says
   * why). What it must not do is abstain quietly: the grid lit that cell, the
   * group watched somebody tap it, and after `round/completed` the grid is gone
   * — so without this the stake simply is not there and nothing anywhere
   * accounts for it. Carryovers make that worse than it sounds, because the
   * hole is skipped entirely and takes the whole pile down with it while the
   * dead-pile note says "no par 3 left to win them".
   *
   * ONLY ONCE THE ROUND IS OVER, for the `unclaimed` gate's reason exactly: mid
   * round, an award tapped on the tee before anybody writes a number down is
   * the NORMAL way this channel is used, and reporting it would fire on every
   * such tap.
   */
  awardedUnscored: number[]
  awards(hole: number): Award[]
}

export function deriveAwardPot(
  ctx: RoundContext,
  events: readonly GameScopedEvent[],
  spec: AwardPotSpec,
): AwardPot {
  const { gameId, stakeCents, eligible, group, eventKind, lineLabel, carryover = false } = spec
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  // LAST WRITE WINS, the same rule `deriveGross` applies to a corrected score:
  // re-tapping a different player on a hole that already has a winner is a
  // correction, not a second award. The events behind it are all kept so undo
  // can CLEAR the hole rather than reveal whoever held it before — "tap the lit
  // cell to take it back" has to mean the hole is unawarded again, or a mistap
  // silently leaves the previous winner holding money nobody re-confirmed.
  const winnerByHole = new Map<number, Uuid>()
  const eventIdsByHole = new Map<number, Uuid[]>()
  for (const e of events) {
    if (e.kind !== eventKind) continue
    const { hole, playerId } = e.data as { hole: number; playerId: Uuid }
    winnerByHole.set(hole, playerId)
    eventIdsByHole.set(hole, [...(eventIdsByHole.get(hole) ?? []), e.id])
  }

  // AN AWARD IS UNCLAIMED EXACTLY WHEN IT CAN NO LONGER BE CLAIMED, which is
  // when the round is over — the same instant the award grid stops being
  // tappable.
  //
  // Not `finalized`, which goes true the moment play moves on: "no award yet"
  // would then read as "unclaimed" on the bar and in notes while the group is
  // two holes down the fairway and fully intends to record it at the turn,
  // which is the exact workflow the award channel exists to allow (MAI-46).
  //
  // Nor "every hole finalized", the proxy Skins uses to kill its carry. That is
  // right for Skins — a carry dies when no hole is left to WIN it, and a hole
  // missing a score still settles among the scores posted — and wrong here for
  // a reason worth stating: one player picking up on an eligible hole leaves it
  // finalized-but-incomplete, so the proxy fires while the round is live and
  // the cell is still lit for the taking. Same bug as the first, one layer down.
  const roundOver = ctx.completed

  // THE LAST ELIGIBLE HOLE OF THE WALK, as a POSITION — see `spec.carryover`'s
  // third clause. An INDEX, not a hole number, because a round can tee off
  // anywhere and wrap (invariant #9): 18 from 10 walks the par 3s 12, 16, 4, 7,
  // so the last one to play for is 7 and `Math.max` over the numbers would say
  // 16 — leaving 16 carrying onto a hole two behind it and 7 declaring a pile
  // riding onto nothing.
  //
  // Computed over `holesPlayed` rather than over the played-so-far ones: the
  // question is what the round still has to offer, which is structural and
  // known at the first tee. Holes the group never reaches are handled by the
  // pile simply dying at completion.
  let lastEligibleIdx = -1
  ctx.holesPlayed.forEach((h, i) => {
    if (eligible(h)) lastEligibleIdx = i
  })

  const settlement: Settlement = emptySettlement(playerIds)
  const wonByPlayer = new Map<Uuid, number>(playerIds.map((id) => [id, 0]))
  const holeResults: AwardHoleResult[] = []
  const awardedUnscored: number[] = []

  // The pile riding onto the next eligible hole. Stays 0 for a game that does
  // not carry, which is what keeps every `units` below equal to 1 there.
  let carry = 0
  let carriedAt: number | undefined

  ctx.holesPlayed.forEach((hole, idx) => {
    if (!eligible(hole)) return
    const raw = winnerByHole.get(hole)
    // An award naming somebody who isn't in this round can only come from a
    // corrupt or edited log; treat it as no award rather than paying a ghost.
    const winnerId = raw !== undefined && playerIds.includes(raw) ? raw : undefined
    // A hole nobody played is not a hole that went unclaimed — completion
    // finalizes the holes the group never reached, and narrating those would be
    // a claim about golf that never happened (MAI-38). It must not carry
    // either, for the same reason: no golf happened on it to leave money over.
    //
    // A SCORE IS THE ONLY EVIDENCE, and "an award is evidence too" was tried
    // twice and is worse both times. It is tempting: these bets are decided on
    // the tee, the grid has no frontier gate by design (MAI-46), so a hole
    // holding a recorded winner and no score LOOKS like one somebody teed off
    // on — and today the grid keeps that cell lit while the money ignores it.
    //
    // Unbounded, it settles real money on a hole the group never reached (a
    // stray tap three holes ahead is reachable, since the scoring screen walks
    // to the end of the card) and banks a pile that should have died — MAI-38's
    // claim about golf that never happened, arrived at from the other side.
    // Bounded to the frontier, the same silent void just moves behind the
    // bound, AND settled money starts depending on `ctx.lastPlayedHole`: undo
    // an unrelated score on 17 and a paid-out award on 16 vanishes with no line
    // or note saying where it went. That is worse than the gap it closes.
    //
    // So the split stands as it always has: the AFFORDANCE is generous (tap any
    // eligible hole, any time until the round closes) and the MONEY is
    // conservative (somebody has to have posted a score). The residual gap — a
    // lit cell on a hole nobody ever scored — needs the affordance to say so,
    // not the money to guess — and, until it does, `awardedUnscored` so the
    // abstention is at least stated out loud instead of leaving a stake that
    // simply is not there once the grid is gated off.
    if (!ctx.anyScored(hole)) {
      if (roundOver && winnerId !== undefined) awardedUnscored.push(hole)
      return
    }
    if (!ctx.finalized(hole)) {
      holeResults.push({ hole, kind: 'pending' })
      return
    }
    if (winnerId === undefined) {
      if (!carryover) {
        holeResults.push({ hole, kind: roundOver ? 'unclaimed' : 'pending' })
        return
      }
      // Nothing later to carry ONTO, and the round is still live — so the stake
      // has not gone anywhere. It is sitting right here, on a cell that is
      // still lit, and `pending` is the honest word until completion turns it
      // into a dead pile. See `spec.carryover`.
      if (idx >= lastEligibleIdx && !roundOver) {
        holeResults.push({ hole, kind: 'pending' })
        return
      }
      carry += 1
      carriedAt = hole
      holeResults.push({ hole, kind: 'carried', carryAfter: carry })
      return
    }
    // This hole plus whatever rode in. Banking it empties the pile, which is
    // why a live carry can only ever be sitting on the LAST eligible result.
    const units = carry + 1
    carry = 0
    wonByPlayer.set(winnerId, (wonByPlayer.get(winnerId) ?? 0) + units)
    // THE WHOLE ROSTER PAYS, not only the players who posted a score. These
    // bets are decided by one shot, so a winner who then picked up still won
    // it, and voiding on a missing score would be wrong golf. (Skins settles
    // among posted scores because winning THERE requires a score. Here it
    // doesn't.) Zero-sum by construction: the winner collects `units` stakes
    // from each of the others.
    const fromEach = stakeCents * units
    addLine(settlement, {
      label: lineLabel(hole, nameOf.get(winnerId) ?? '', units),
      // the line names the winner, so the money it shows is what they made
      headlineCents: fromEach * (playerIds.length - 1),
      perPlayerCents: Object.fromEntries(
        playerIds.map((id) => [
          id,
          id === winnerId ? fromEach * (playerIds.length - 1) : -fromEach,
        ]),
      ),
    })
    holeResults.push({ hole, kind: 'won', winnerId, units })
  })

  // Dead exactly when it can no longer be claimed — `ctx.completed`, the same
  // gate as `unclaimed` and for the same reason. Every weaker test is wrong
  // here; the block above `roundOver` says why.
  const carryDied = roundOver ? carry : 0

  // Offered on ANY eligible hole the round is playing, scored or not — the tap
  // happens on the tee, before anybody writes a number down, and it stays
  // tappable for the rest of the round. No frontier gate, by design (MAI-46).
  const awards = (hole: number): Award[] => {
    if (!eligible(hole)) return []
    const winnerId = winnerByHole.get(hole)
    return players.map((p) => {
      const taken = winnerId === p.playerId
      return {
        id: `${eventKind}-${hole}-${p.playerId}`,
        gameId,
        hole,
        playerId: p.playerId,
        group,
        label: p.name,
        taken,
        eventKind,
        data: { hole, playerId: p.playerId },
        // Only the lit cell carries an undo, so a screen cannot retract off a
        // cell that was never tapped. Every award event on the hole, so taking
        // it back CLEARS the hole rather than revealing whoever held it before
        // — see the last-write-wins note above.
        ...(taken && { undoEventIds: eventIdsByHole.get(hole) ?? [] }),
      }
    })
  }

  return {
    holeResults,
    settlement,
    wonByPlayer,
    // dead is not riding — see `carrying`'s docstring
    carrying: carryDied > 0 ? 0 : carry,
    carryDied,
    awardedUnscored,
    ...(carryDied > 0 && carriedAt !== undefined && { diedAt: carriedAt }),
    awards,
  }
}

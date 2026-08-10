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
  /** eligible, played, decided: this player was given it */
  | { hole: number; kind: 'won'; winnerId: Uuid }
  /** eligible and played, but the hole hasn't settled yet */
  | { hole: number; kind: 'pending' }
  /** eligible, played out, and nobody was ever given it */
  | { hole: number; kind: 'unclaimed' }

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
  /** the settlement line, in the game's own words */
  lineLabel(hole: number, winnerName: string): string
}

export interface AwardPot {
  holeResults: AwardHoleResult[]
  settlement: Settlement
  /** how many each player was given, for the standings subtitle */
  wonByPlayer: Map<Uuid, number>
  awards(hole: number): Award[]
}

export function deriveAwardPot(
  ctx: RoundContext,
  events: readonly GameScopedEvent[],
  spec: AwardPotSpec,
): AwardPot {
  const { gameId, stakeCents, eligible, group, eventKind, lineLabel } = spec
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

  const settlement: Settlement = emptySettlement(playerIds)
  const wonByPlayer = new Map<Uuid, number>(playerIds.map((id) => [id, 0]))
  const holeResults: AwardHoleResult[] = []

  for (const hole of ctx.holesPlayed) {
    if (!eligible(hole)) continue
    // A hole nobody played is not a hole that went unclaimed — completion
    // finalizes the holes the group never reached, and narrating those would be
    // a claim about golf that never happened (MAI-38).
    if (!ctx.anyScored(hole)) continue
    if (!ctx.finalized(hole)) {
      holeResults.push({ hole, kind: 'pending' })
      continue
    }
    const raw = winnerByHole.get(hole)
    // An award naming somebody who isn't in this round can only come from a
    // corrupt or edited log; treat it as no award rather than paying a ghost.
    const winnerId = raw !== undefined && playerIds.includes(raw) ? raw : undefined
    if (winnerId === undefined) {
      holeResults.push({ hole, kind: roundOver ? 'unclaimed' : 'pending' })
      continue
    }
    wonByPlayer.set(winnerId, (wonByPlayer.get(winnerId) ?? 0) + 1)
    // THE WHOLE ROSTER PAYS, not only the players who posted a score. These
    // bets are decided by one shot, so a winner who then picked up still won
    // it, and voiding on a missing score would be wrong golf. (Skins settles
    // among posted scores because winning THERE requires a score. Here it
    // doesn't.) Zero-sum by construction: the winner collects one stake from
    // each of the others.
    addLine(settlement, {
      label: lineLabel(hole, nameOf.get(winnerId) ?? ''),
      perPlayerCents: Object.fromEntries(
        playerIds.map((id) => [
          id,
          id === winnerId ? stakeCents * (playerIds.length - 1) : -stakeCents,
        ]),
      ),
    })
    holeResults.push({ hole, kind: 'won', winnerId })
  }

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

  return { holeResults, settlement, wonByPlayer, awards }
}

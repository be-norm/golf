import { z } from 'zod'
import type { Award, GameEngine, GameDerivation } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { addLine, emptySettlement, formatCents, type Settlement } from '../../core/money'
import { duplicateInstanceProblems } from '../../core/setup'
import { standingsFromSettlement } from '../../core/standings'
import { latestHoleSummary, summaryString } from '../../core/summary'
import type { GameConfig, HandicapSettings, RoundPlayer, Uuid } from '../../core/types'

export const ctpConfigSchema = z.object({
  /** what the closest tee shot is worth; the winner collects this from each other player */
  stakeCents: z.number().int().positive(),
})

export type CtpConfig = z.infer<typeof ctpConfigSchema>

export type CtpHoleResult =
  /** eligible, played, decided: this player was closest */
  | { hole: number; kind: 'won'; winnerId: Uuid }
  /** eligible and played, but the hole hasn't settled yet */
  | { hole: number; kind: 'pending' }
  /** eligible, played out, and nobody was ever given it */
  | { hole: number; kind: 'unclaimed' }

export interface CtpDerivation extends GameDerivation {
  holeResults: CtpHoleResult[]
}

/** The one group label — the award grid's row, and every sentence about it. */
const GROUP = 'Closest to the pin'

function derive(
  game: GameConfig<CtpConfig>,
  events: readonly GameScopedEvent[],
  ctx: RoundContext,
): CtpDerivation {
  const { stakeCents } = game.config
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
    if (e.kind !== 'ctp/award') continue
    const { hole, playerId } = e.data as { hole: number; playerId: Uuid }
    winnerByHole.set(hole, playerId)
    eventIdsByHole.set(hole, [...(eventIdsByHole.get(hole) ?? []), e.id])
  }

  // Par 3s only, and the engine answers that off the frozen course snapshot —
  // which is what lets the award grid stay generic and offer nothing elsewhere.
  const eligible = (hole: number) => ctx.par(hole) === 3
  const eligibleHoles = ctx.holesPlayed.filter(eligible)

  // THE WHOLE CARD, not this hole. `ctx.finalized` goes true the moment play
  // moves on, so "no award yet" would read as "unclaimed" on the bar and in
  // notes while the group is two holes down the fairway and fully intends to
  // record it at the turn — which is the exact workflow the award channel
  // exists to allow (MAI-46). Same proxy Skins uses to kill its carry: the
  // card is played out, so nothing is coming.
  const cardPlayedOut = ctx.holesPlayed.every((h) => ctx.finalized(h))

  const settlement: Settlement = emptySettlement(playerIds)
  const wonByPlayer = new Map<Uuid, number>(playerIds.map((id) => [id, 0]))
  const holeResults: CtpHoleResult[] = []

  for (const hole of eligibleHoles) {
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
      holeResults.push({ hole, kind: cardPlayedOut ? 'unclaimed' : 'pending' })
      continue
    }
    wonByPlayer.set(winnerId, (wonByPlayer.get(winnerId) ?? 0) + 1)
    // THE WHOLE ROSTER PAYS, not only the players who posted a score. Closest
    // to the pin is decided by the tee shot, so a winner who then picked up
    // still won it, and voiding on a missing score would be wrong golf. (Skins
    // settles among posted scores because winning THERE requires a score. Here
    // it doesn't.) Zero-sum by construction: the winner collects one stake from
    // each of the others.
    addLine(settlement, {
      label: `Hole ${hole} — ${nameOf.get(winnerId)} closest to the pin`,
      perPlayerCents: Object.fromEntries(
        playerIds.map((id) => [
          id,
          id === winnerId ? stakeCents * (playerIds.length - 1) : -stakeCents,
        ]),
      ),
    })
    holeResults.push({ hole, kind: 'won', winnerId })
  }

  const unclaimed = holeResults.filter((r) => r.kind === 'unclaimed').map((r) => r.hole)
  // Money nobody collected is something to SAY, not a $0 settlement line —
  // that would make `lines.length === 0`, the settle panel's "No money moved."
  // signal, false on exactly the round it was written for (MAI-40).
  const notes =
    unclaimed.length > 0
      ? [
          `${GROUP} went unclaimed on ${unclaimed.length === 1 ? 'hole' : 'holes'} ` +
            `${unclaimed.join(', ')} — nobody was given it, so nothing was paid`,
        ]
      : undefined

  const ctpLabel = (n: number) => `${n} CTP${n === 1 ? '' : 's'}`
  const standings = standingsFromSettlement(players, settlement, (p) =>
    ctpLabel(wonByPlayer.get(p.playerId) ?? 0),
  )

  // Bar recaps the latest decided hole — "H7 · Rob closest".
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const r = holeResults.find((h) => h.hole === hole)
      if (r?.kind === 'won') return `${nameOf.get(r.winnerId)} closest`
      if (r?.kind === 'unclaimed') return 'nobody inside'
      return null
    },
    'no CTP yet',
  )

  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r || r.kind === 'pending') return []
    if (r.kind === 'unclaimed') {
      return [
        `${GROUP} — unclaimed`,
        '↳ nobody was given it by the end of the round, so the hole paid nothing',
      ]
    }
    // The non-obvious part of a CTP is never who won it — it is what a small
    // stake actually swings once every other player pays it.
    const others = playerIds.length - 1
    return [
      `${nameOf.get(r.winnerId)} closest to the pin`,
      `↳ ${formatCents(stakeCents)} from each of ${others} other player${others === 1 ? '' : 's'}` +
        ` — ${formatCents(stakeCents * others)}`,
    ]
  }

  // Offered on ANY par 3 the round is playing, scored or not — the tap happens
  // on the tee, before anybody writes a number down, and it stays tappable for
  // the rest of the round. No frontier gate, by design (MAI-46).
  const awards = (hole: number): Award[] => {
    if (!eligible(hole)) return []
    const winnerId = winnerByHole.get(hole)
    return players.map((p) => {
      const taken = winnerId === p.playerId
      return {
        id: `ctp-${hole}-${p.playerId}`,
        gameId: game.gameId,
        hole,
        playerId: p.playerId,
        group: GROUP,
        label: p.name,
        taken,
        eventKind: 'ctp/award',
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
    standings,
    summary: summaryString(summaryParts),
    summaryParts,
    holeSummary,
    requiredInputs: () => [],
    awards,
    settlement,
    notes,
    holeResults,
  }
}

/** The one name for this game — `meta.name` and every message that has to
 *  say it. label.ts is the single source of a game's name (MAI-42), so a
 *  second literal in `validateSetup` would drift the moment this is renamed. */
const CTP_NAME = 'Closest to the Pin'

export const ctpEngine: GameEngine<CtpConfig> = {
  type: 'ctp',
  meta: {
    name: CTP_NAME,
    blurb: 'Closest tee shot on every par 3 collects from the rest.',
    minPlayers: 2,
    maxPlayers: 8,
    // The first true side bet in the catalog. Nobody plays a round OF closest
    // to the pin — it rides alongside whatever the group is actually playing.
    category: 'side',
    family: 'award',
    shapes: ['solo'],
    rules: {
      tagline: 'Every par 3 is worth money to whoever stiffs it.',
      howToPlay: [
        'On every par 3, whoever hits the closest tee shot that stays on the green wins the hole’s CTP.',
        'Tap their name in the award grid under the scores. You can record it whenever you like — on the tee, at the turn, or on the 18th green.',
        'Tap the lit name again to clear the hole; tap a different name to correct it.',
        'Nobody given it by the end of the round? That hole pays nothing — it is reported, not settled.',
      ],
      scoring: [
        'The winner of a par 3 collects the stake from every other player. At $2 in a foursome that is $6 to them and $2 from each of the others.',
        'Handicaps do not apply — it is a contest of one tee shot, not of scores.',
        'Every par 3 in the holes you are playing stands on its own. Nothing carries.',
      ],
      terms: [
        { term: 'CTP', def: 'Closest to the pin — the shortest putt left after the tee shot on a par 3.' },
        {
          term: 'On the green',
          def: 'The usual house rule: the ball has to finish on the putting surface to count.',
        },
        { term: 'Unclaimed', def: 'A par 3 nobody was given — the hole simply pays nothing.' },
      ],
    },
  },
  configSchema: ctpConfigSchema,
  configFields: [
    {
      key: 'stakeCents',
      kind: 'money',
      label: 'Per par 3',
      min: 25,
      step: 25,
      hint: 'The winner collects this from every other player',
    },
  ],
  defaultConfig: () => ({ stakeCents: 200 }),
  // GROSS, and not a default anyone should flip: a tee shot is measured with a
  // tape, not against a handicap. It also keeps CTP out of `strokeGame`, so a
  // cheap side bet can never capture the scoring screen's stroke dots.
  defaultHandicap: (): HandicapSettings => ({
    mode: 'gross',
    allowancePct: 100,
    reference: 'absolute',
  }),
  validateSetup: (
    config: GameConfig<CtpConfig>,
    players: readonly RoundPlayer[],
    siblings: readonly GameConfig[],
  ) => {
    const problems: string[] = []
    if (players.length < 2) problems.push(`${CTP_NAME} needs at least 2 players`)
    if (!ctpConfigSchema.safeParse(config.config).success) {
      problems.push('Invalid closest to the pin configuration')
    }
    // "There is no par 3 in these holes" would be the useful check and cannot
    // live here: validateSetup sees the config, the roster and its siblings —
    // never the course. The award grid simply offers nothing, which is the
    // honest degradation.
    problems.push(...duplicateInstanceProblems(config, siblings, CTP_NAME))
    return problems
  },
  eventKinds: {
    'ctp/award': z.object({
      hole: z.number().int().min(1).max(18),
      playerId: z.string(),
    }),
  },
  derive,
}

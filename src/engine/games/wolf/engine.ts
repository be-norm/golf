import { z } from 'zod'
import type { GameEngine, GameDerivation, InputRequest, StandingLine } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { emptySettlement, formatCentsSigned, type Settlement } from '../../core/money'
import type { GameConfig, HandicapSettings, RoundPlayer, Uuid } from '../../core/types'

export const wolfConfigSchema = z.object({
  /** cents per point; money settles on pairwise point differences */
  pointCents: z.number().int().positive(),
  /** wolf order: rotation[0] is the wolf on the first hole played */
  rotation: z.array(z.string()),
})

export type WolfConfig = z.infer<typeof wolfConfigSchema>

/**
 * MVP point table (documented in docs/games-catalog.md — tables vary by group):
 * wolf+partner win 2 each · non-wolf pair win 3 each · lone wolf win 4 ·
 * lone loss 1 to each opponent · blind wolf win 6 · blind loss 2 to each opponent.
 * Ties halve the hole. After the rotation runs out (holes 17–18, or the 9th
 * hole of a nine), the player with the fewest points is the wolf.
 */
const POINTS = {
  partnerWin: 2,
  opponentsWin: 3,
  loneWin: 4,
  loneLossEach: 1,
  blindWin: 6,
  blindLossEach: 2,
}

export type WolfPick =
  | { kind: 'partner'; partnerId: Uuid }
  | { kind: 'lone' }
  | { kind: 'blind' }

export interface WolfHoleResult {
  hole: number
  wolfId: Uuid
  pick: WolfPick | null
  /** points awarded this hole, by player */
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
  for (const e of events) {
    if (e.kind !== 'wolf/pick') continue
    const data = e.data as { hole: number; choice: string }
    picks.set(
      data.hole,
      data.choice === 'lone'
        ? { kind: 'lone' }
        : data.choice === 'blind'
          ? { kind: 'blind' }
          : { kind: 'partner', partnerId: data.choice },
    )
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

    const pick = picks.get(hole) ?? null
    const nets = new Map<Uuid, number | null>(
      playerIds.map((id) => [id, ctx.netFor(game.gameId, id, hole)]),
    )
    const allScored = [...nets.values()].every((v) => v !== null)

    if (!pick || !allScored) {
      holeResults.push({ hole, wolfId, pick, points: null, outcome: 'pending' })
      return
    }

    const wolfSide: Uuid[] =
      pick.kind === 'partner' ? [wolfId, pick.partnerId] : [wolfId]
    const packSide = playerIds.filter((id) => !wolfSide.includes(id))
    const best = (side: Uuid[]) => Math.min(...side.map((id) => nets.get(id)!))
    const wolfBest = best(wolfSide)
    const packBest = best(packSide)

    const points = new Map<Uuid, number>(playerIds.map((id) => [id, 0]))
    let outcome: WolfHoleResult['outcome']
    if (wolfBest < packBest) {
      outcome = 'wolfWin'
      if (pick.kind === 'partner') {
        for (const id of wolfSide) points.set(id, POINTS.partnerWin)
      } else {
        points.set(wolfId, pick.kind === 'blind' ? POINTS.blindWin : POINTS.loneWin)
      }
    } else if (packBest < wolfBest) {
      outcome = 'packWin'
      if (pick.kind === 'partner') {
        for (const id of packSide) points.set(id, POINTS.opponentsWin)
      } else {
        const each = pick.kind === 'blind' ? POINTS.blindLossEach : POINTS.loneLossEach
        for (const id of packSide) points.set(id, each)
      }
    } else {
      outcome = 'halved'
    }

    for (const [id, p] of points) totals.set(id, totals.get(id)! + p)
    holeResults.push({ hole, wolfId, pick, points, outcome })
  })

  // Pairwise settlement: money_i = pointCents × (n·points_i − Σpoints). Zero-sum.
  const settlement: Settlement = emptySettlement(playerIds)
  const totalPoints = [...totals.values()].reduce((a, b) => a + b, 0)
  for (const id of playerIds) {
    settlement.perPlayerCents[id] = pointCents * (n * totals.get(id)! - totalPoints)
  }
  settlement.lines = playerIds.map((id) => ({
    label: `${nameOf.get(id)} — ${totals.get(id)} pts`,
    perPlayerCents: { [id]: settlement.perPlayerCents[id]! },
  }))

  const standings: StandingLine[] = players
    .map((p) => ({
      id: p.playerId,
      label: p.name,
      detail: `${totals.get(p.playerId)} pts`,
      amountCents: settlement.perPlayerCents[p.playerId] ?? 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents)

  const lead = standings[0]!
  const summary =
    lead.amountCents === 0 ? 'all square' : `${lead.label} ${formatCentsSigned(lead.amountCents)}`

  // The wolf must decide on any hole that's being scored (or is next up) and
  // has no pick yet — a blocking chip, since the hole can't compute without it.
  const requiredInputs = (): InputRequest[] => {
    const inputs: InputRequest[] = []
    for (const r of holeResults) {
      if (r.pick) continue
      const anyScore = playerIds.some((id) => ctx.gross.get(id)?.get(r.hole) !== undefined)
      const frontier = ctx.holesPlayed.find(
        (h) => !playerIds.every((id) => ctx.gross.get(id)?.get(h) !== undefined),
      )
      if (!anyScore && r.hole !== frontier) continue
      const wolfName = nameOf.get(r.wolfId)
      inputs.push({
        id: `wolf-pick-${r.hole}`,
        gameId: game.gameId,
        hole: r.hole,
        prompt: `🐺 Hole ${r.hole}: ${wolfName} rides with…`,
        options: [
          ...playerIds
            .filter((id) => id !== r.wolfId)
            .map((id) => ({ value: id, label: nameOf.get(id)! })),
          { value: 'lone', label: 'Lone Wolf 🐺' },
          { value: 'blind', label: 'Blind Wolf 🙈' },
        ],
        eventKind: 'wolf/pick',
      })
    }
    return inputs
  }

  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r) return []
    const wolfName = nameOf.get(r.wolfId)
    if (r.outcome === 'pending') return [`Wolf: ${wolfName}`]
    const pickLabel =
      r.pick!.kind === 'partner'
        ? `with ${nameOf.get(r.pick!.partnerId)}`
        : r.pick!.kind === 'lone'
          ? 'lone'
          : 'blind'
    if (r.outcome === 'halved') return [`Wolf ${wolfName} (${pickLabel}) — halved`]
    const gains = [...r.points!.entries()]
      .filter(([, p]) => p > 0)
      .map(([id, p]) => `${nameOf.get(id)} +${p}`)
      .join(', ')
    return [`Wolf ${wolfName} (${pickLabel}) — ${gains}`]
  }

  return { standings, summary, holeSummary, requiredInputs, settlement }
}

export const wolfEngine: GameEngine<WolfConfig> = {
  type: 'wolf',
  meta: {
    name: 'Wolf',
    blurb: 'Rotating Wolf picks a partner off the tee — or goes lone for double.',
    minPlayers: 4,
    maxPlayers: 4,
  },
  configSchema: wolfConfigSchema,
  configFields: [
    { key: 'pointCents', kind: 'money', label: 'Per point' },
    { key: 'rotation', kind: 'rotation', label: 'Wolf order' },
  ],
  defaultConfig: (players) => ({
    pointCents: 100,
    rotation: players.map((p) => p.playerId),
  }),
  defaultHandicap: (): HandicapSettings => ({ mode: 'net', allowancePct: 100, reference: 'offLow' }),
  validateSetup: (config: GameConfig<WolfConfig>, players: readonly RoundPlayer[]) => {
    if (players.length !== 4) return ['Wolf needs exactly 4 players']
    const parsed = wolfConfigSchema.safeParse(config.config)
    if (!parsed.success) return ['Invalid wolf configuration']
    const rotation = [...parsed.data.rotation].sort()
    const expected = players.map((p) => p.playerId).sort()
    if (JSON.stringify(rotation) !== JSON.stringify(expected))
      return ['Wolf order must include every player exactly once']
    return []
  },
  eventKinds: {
    'wolf/pick': z.object({
      hole: z.number().int().min(1).max(18),
      choice: z.string(),
    }),
  },
  derive,
}

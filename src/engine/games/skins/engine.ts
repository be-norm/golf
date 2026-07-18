import { z } from 'zod'
import type { GameEngine, GameDerivation, StandingLine } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import {
  addLine,
  emptySettlement,
  formatCentsSigned,
  type Settlement,
} from '../../core/money'
import type { GameConfig, HandicapSettings, RoundPlayer, Uuid } from '../../core/types'

export const skinsConfigSchema = z.object({
  /** value of one skin; a winner collects this from every other player */
  stakeCents: z.number().int().positive(),
  /** tied holes roll their value onto the next hole */
  carryover: z.boolean(),
})

export type SkinsConfig = z.infer<typeof skinsConfigSchema>

export type SkinsHoleResult =
  | { hole: number; kind: 'won'; winnerId: Uuid; skins: number; effective: number }
  | { hole: number; kind: 'tied'; carryAfter: number }
  | { hole: number; kind: 'pending' }

export interface SkinsDerivation extends GameDerivation {
  holeResults: SkinsHoleResult[]
  /** live carried skins waiting to be won */
  carrying: number
}

function derive(
  game: GameConfig<SkinsConfig>,
  _events: readonly GameScopedEvent[],
  ctx: RoundContext,
): SkinsDerivation {
  const { stakeCents, carryover } = game.config
  const players = ctx.round.players
  const playerIds = players.map((p) => p.playerId)
  const nameOf = new Map(players.map((p) => [p.playerId, p.name]))

  const settlement: Settlement = emptySettlement(playerIds)
  const skinsByPlayer = new Map<Uuid, number>(playerIds.map((id) => [id, 0]))
  const holeResults: SkinsHoleResult[] = []

  let carry = 0
  let blocked = false
  for (const hole of ctx.holesPlayed) {
    if (blocked) {
      holeResults.push({ hole, kind: 'pending' })
      continue
    }
    const nets = players.map((p) => ({
      playerId: p.playerId,
      net: ctx.netFor(game.gameId, p.playerId, hole),
    }))
    if (nets.some((n) => n.net === null)) {
      // An unscored hole blocks the carry chain: later holes stay pending
      // until the gap fills (corrections replay everything anyway).
      blocked = true
      holeResults.push({ hole, kind: 'pending' })
      continue
    }
    const low = Math.min(...nets.map((n) => n.net!))
    const winners = nets.filter((n) => n.net === low)
    if (winners.length === 1) {
      const winnerId = winners[0]!.playerId
      const skins = carry + 1
      carry = 0
      skinsByPlayer.set(winnerId, (skinsByPlayer.get(winnerId) ?? 0) + skins)
      const value = skins * stakeCents
      addLine(settlement, {
        label: `Hole ${hole} — ${nameOf.get(winnerId)} wins ${skins} skin${skins > 1 ? 's' : ''}`,
        perPlayerCents: Object.fromEntries(
          playerIds.map((id) => [id, id === winnerId ? value * (playerIds.length - 1) : -value]),
        ),
      })
      holeResults.push({ hole, kind: 'won', winnerId, skins, effective: low })
    } else {
      if (carryover) carry += 1
      holeResults.push({ hole, kind: 'tied', carryAfter: carry })
    }
  }

  const standings: StandingLine[] = players
    .map((p) => ({
      id: p.playerId,
      label: p.name,
      detail: `${skinsByPlayer.get(p.playerId) ?? 0} skin${(skinsByPlayer.get(p.playerId) ?? 0) === 1 ? '' : 's'}`,
      amountCents: settlement.perPlayerCents[p.playerId] ?? 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents)

  const leader = standings[0]
  const summaryParts: string[] = []
  if (leader && leader.amountCents > 0) {
    summaryParts.push(`${leader.label} ${formatCentsSigned(leader.amountCents)}`)
  } else {
    summaryParts.push('all square')
  }
  if (carry > 0) summaryParts.push(`${carry} carried`)

  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r || r.kind === 'pending') return []
    if (r.kind === 'won') {
      return [
        `${nameOf.get(r.winnerId)} wins ${r.skins} skin${r.skins > 1 ? 's' : ''} (${
          game.handicap.mode === 'net' ? 'net' : ''
        } ${r.effective})`.replace('( ', '('),
      ]
    }
    return [r.carryAfter > 0 ? `Tied — ${r.carryAfter} carried` : 'Tied — no skin']
  }

  return {
    standings,
    summary: summaryParts.join(' · '),
    holeSummary,
    requiredInputs: () => [],
    settlement,
    holeResults,
    carrying: carry,
  }
}

export const skinsEngine: GameEngine<SkinsConfig> = {
  type: 'skins',
  meta: {
    name: 'Skins',
    blurb: 'Win the hole outright, win the skin. Ties carry over.',
    minPlayers: 2,
    maxPlayers: 8,
  },
  configSchema: skinsConfigSchema,
  configFields: [
    { key: 'stakeCents', kind: 'money', label: 'Skin value' },
    { key: 'carryover', kind: 'boolean', label: 'Carryovers', hint: 'Tied holes roll over' },
  ],
  defaultConfig: () => ({ stakeCents: 100, carryover: true }),
  defaultHandicap: (): HandicapSettings => ({
    mode: 'net',
    allowancePct: 100,
    reference: 'offLow',
  }),
  validateSetup: (config: GameConfig<SkinsConfig>, players: readonly RoundPlayer[]) => {
    const problems: string[] = []
    if (players.length < 2) problems.push('Skins needs at least 2 players')
    const parsed = skinsConfigSchema.safeParse(config.config)
    if (!parsed.success) problems.push('Invalid skins configuration')
    return problems
  },
  eventKinds: {},
  derive,
}

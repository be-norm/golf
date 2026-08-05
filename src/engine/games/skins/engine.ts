import { z } from 'zod'
import type { GameEngine, GameDerivation, StandingLine } from '../../catalog'
import type { RoundContext } from '../../core/context'
import type { GameScopedEvent } from '../../core/events'
import { addLine, emptySettlement, type Settlement } from '../../core/money'
import { latestHoleSummary, summaryString } from '../../core/summary'
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
  | { hole: number; kind: 'void' }

export interface SkinsDerivation extends GameDerivation {
  holeResults: SkinsHoleResult[]
  /** live carried skins waiting to be won */
  carrying: number
  /**
   * Carried skins that can never be won now — every hole is decided and the
   * pile is still sitting there (the final hole tied, or the round finished
   * early). It is the one open bet Skins has, and money the group thinks is
   * still live until somebody says otherwise (MAI-38).
   */
  carryDied: number
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
  for (const hole of ctx.holesPlayed) {
    // The frontier hole being actively entered stays pending; everything
    // behind it settles among whoever posted a score (skipped players
    // can't win a hole they didn't play).
    if (!ctx.finalized(hole)) {
      holeResults.push({ hole, kind: 'pending' })
      continue
    }
    const nets = players
      .map((p) => ({ playerId: p.playerId, net: ctx.netFor(game.gameId, p.playerId, hole) }))
      .filter((n) => n.net !== null)
    if (nets.length === 0) {
      // finalized but nobody scored it — the hole is void, no skin at stake
      holeResults.push({ hole, kind: 'void' })
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

  // The pot is dead once no hole is left to win it — every hole decided, with
  // skins still on the pile. Covers both a tied final hole and a round finished
  // early (completion finalizes the holes nobody reached).
  const carryDied = carry > 0 && ctx.holesPlayed.every((h) => ctx.finalized(h)) ? carry : 0
  const deadSkins = carryDied > 0 ? `${carryDied} skin${carryDied === 1 ? '' : 's'}` : ''
  // Where the death gets narrated: the last hole anybody actually played, since
  // that is the hole the group is looking at when it happens. Undefined unless
  // something actually died — this scans every player's scores, and `derive`
  // runs once per hole in the ledger's prefix replay.
  const diedAt =
    carryDied > 0 ? [...ctx.holesPlayed].reverse().find((h) => ctx.anyScored(h)) : undefined

  // A dead pile is something to SAY, not money that moved, so it rides the
  // narration channel rather than a zero-cent settlement line. `settlement.lines`
  // stays exactly what it claims to be: money that changed hands (MAI-40).
  // ONE phrasing of the cause, shared with the hole ledger. "No outright winner
  // left" was the reason ANY tied hole carries — a reader who has seen
  // "tied · 2 carried" three times would get the same explanation for the
  // opposite outcome. What actually killed the pile is that the holes ran out.
  const deadReason = `${deadSkins} died unwon — no hole left to win them`
  const notes = carryDied > 0 ? [deadReason] : undefined

  const standings: StandingLine[] = players
    .map((p) => ({
      id: p.playerId,
      label: p.name,
      detail: `${skinsByPlayer.get(p.playerId) ?? 0} skin${(skinsByPlayer.get(p.playerId) ?? 0) === 1 ? '' : 's'}`,
      amountCents: settlement.perPlayerCents[p.playerId] ?? 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents)

  // Bar recaps the latest decided hole — "H4 · Rob wins 2 skins".
  const summaryParts = latestHoleSummary(
    ctx.holesPlayed,
    (hole) => {
      const r = holeResults.find((h) => h.hole === hole)
      if (r?.kind === 'won')
        return `${nameOf.get(r.winnerId)} wins ${r.skins} skin${r.skins > 1 ? 's' : ''}`
      if (r?.kind === 'tied') {
        // "carried" promises the pile rolls onto a hole that no longer exists
        if (hole === diedAt) return `tied · ${deadSkins} died unwon`
        return r.carryAfter > 0 ? `tied · ${r.carryAfter} carried` : 'tied — no skin'
      }
      return null
    },
    'no skins yet',
  )

  const holeSummary = (hole: number): string[] => {
    const r = holeResults.find((h) => h.hole === hole)
    if (!r || r.kind === 'pending') return []
    if (r.kind === 'void') return ['No scores — hole void']
    if (r.kind === 'won') {
      const scoreTag = game.handicap.mode === 'net' ? `net ${r.effective}` : `${r.effective}`
      const lines = [`${nameOf.get(r.winnerId)} wins ${r.skins} skin${r.skins > 1 ? 's' : ''} (${scoreTag})`]
      // explain WHY it's more than one: skins carried in from earlier ties
      if (r.skins > 1) {
        const carried = r.skins - 1
        lines.push(`↳ this hole + ${carried} carried in from ties`)
      }
      // never a dead pot here: winning a hole banks the pile, so `diedAt` can
      // only ever be a TIED hole
      return lines
    }
    if (hole === diedAt) return ['Tied — no outright winner', `↳ ${deadReason}`]
    return [r.carryAfter > 0 ? `Tied — ${r.carryAfter} carried` : 'Tied — no skin']
  }

  return {
    standings,
    summary: summaryString(summaryParts),
    summaryParts,
    holeSummary,
    requiredInputs: () => [],
    settlement,
    notes,
    holeResults,
    carrying: carry,
    carryDied,
  }
}

export const skinsEngine: GameEngine<SkinsConfig> = {
  type: 'skins',
  meta: {
    name: 'Skins',
    blurb: 'Win the hole outright, win the skin. Ties carry over.',
    minPlayers: 2,
    maxPlayers: 8,
    rules: {
      tagline: 'Every hole is worth money. Win it outright or nobody does.',
      howToPlay: [
        'Each hole is worth one skin. The lowest score wins it — but only outright. Any tie for low and the skin goes unwon.',
        'With carryovers on, an unwon skin rolls onto the next hole. Holes stack until someone wins one outright and banks the whole pile.',
        'Playing net, handicap strokes land on the hardest holes (by stroke index) and the lowest net score takes the skin.',
        "No score on a hole? You can't win it. Once play moves on, the hole settles among the scores that were posted.",
      ],
      scoring: [
        'A skin collects the skin value from every other player. Win a 3-skin carry in a foursome at $1 and you collect $3 from each — a $9 swing.',
        'If the final hole ties, the carried pile dies unwon.',
      ],
      terms: [
        { term: 'Skin', def: 'The prize for winning a hole outright — no ties allowed.' },
        { term: 'Carryover', def: "A tied hole's skin rolling forward, making the next hole worth more." },
        { term: 'Net / Gross', def: 'Net is your score minus handicap strokes; gross is raw strokes.' },
        {
          term: 'Stroke index',
          def: 'The 1–18 hole difficulty ranking that decides where handicap strokes land.',
        },
        {
          term: 'Off low',
          def: "Everyone's handicap is reduced by the lowest player's, so the best player plays at zero.",
        },
      ],
    },
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

import type { Uuid } from './types'

/** All money in the engine is integer cents. */

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const rem = abs % 100
  return rem === 0 ? `${sign}$${dollars}` : `${sign}$${dollars}.${String(rem).padStart(2, '0')}`
}

/** Signed formatting for standings deltas: +$3 / -$1.50 / $0. */
export function formatCentsSigned(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents)
}

export interface SettlementLine {
  label: string
  perPlayerCents: Record<Uuid, number>
}

export interface Settlement {
  perPlayerCents: Record<Uuid, number>
  lines: SettlementLine[]
}

export function emptySettlement(playerIds: readonly Uuid[]): Settlement {
  return {
    perPlayerCents: Object.fromEntries(playerIds.map((id) => [id, 0])),
    lines: [],
  }
}

export function addLine(settlement: Settlement, line: SettlementLine): void {
  settlement.lines.push(line)
  for (const [id, cents] of Object.entries(line.perPlayerCents)) {
    settlement.perPlayerCents[id] = (settlement.perPlayerCents[id] ?? 0) + cents
  }
}

/** Every game settlement must be zero-sum. Throws if not — used in tests and dev builds. */
export function assertZeroSum(settlement: Settlement): void {
  const sum = Object.values(settlement.perPlayerCents).reduce((a, b) => a + b, 0)
  if (sum !== 0) {
    throw new Error(`settlement is not zero-sum: total ${sum} cents`)
  }
}

/**
 * Sum every game's settlement into one per-player balance for the round.
 * Takes settlements rather than derivations so this stays free of a catalog
 * import — money.ts is the bottom of the engine, not a consumer of it.
 * Players with no money movement stay in the map at 0, so the round's full
 * roster survives into standings.
 */
export function combineSettlements(
  playerIds: readonly Uuid[],
  settlements: Iterable<Settlement>,
): Record<Uuid, number> {
  const combined: Record<Uuid, number> = Object.fromEntries(playerIds.map((id) => [id, 0]))
  for (const s of settlements) {
    for (const [id, cents] of Object.entries(s.perPlayerCents)) {
      combined[id] = (combined[id] ?? 0) + cents
    }
  }
  return combined
}

export interface Transfer {
  fromPlayerId: Uuid
  toPlayerId: Uuid
  cents: number
}

/** Greedy minimal-transfer suggestion for a zero-sum per-player balance map. */
export function minimalTransfers(perPlayerCents: Record<Uuid, number>): Transfer[] {
  const debtors = Object.entries(perPlayerCents)
    .filter(([, c]) => c < 0)
    .map(([id, c]) => ({ id, remaining: -c }))
    .sort((a, b) => b.remaining - a.remaining)
  const creditors = Object.entries(perPlayerCents)
    .filter(([, c]) => c > 0)
    .map(([id, c]) => ({ id, remaining: c }))
    .sort((a, b) => b.remaining - a.remaining)

  const transfers: Transfer[] = []
  let d = 0
  let c = 0
  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d]!
    const creditor = creditors[c]!
    const amount = Math.min(debtor.remaining, creditor.remaining)
    if (amount > 0) {
      transfers.push({ fromPlayerId: debtor.id, toPlayerId: creditor.id, cents: amount })
      debtor.remaining -= amount
      creditor.remaining -= amount
    }
    if (debtor.remaining === 0) d++
    if (creditor.remaining === 0) c++
  }
  return transfers
}

export interface Collector {
  toPlayerId: Uuid
  totalCents: number
  from: { fromPlayerId: Uuid; cents: number }[]
}

/**
 * Regroup transfers by who collects: one entry per creditor with their total,
 * debtors listed beneath. Reads cleanly when one player collects from several —
 * "Ben collects $6 ← Rob $4, ← Al $2" rather than two unrelated lines.
 */
export function collectorsFrom(transfers: readonly Transfer[]): Collector[] {
  const byCreditor = new Map<Uuid, Collector>()
  for (const t of transfers) {
    const g = byCreditor.get(t.toPlayerId) ?? { toPlayerId: t.toPlayerId, totalCents: 0, from: [] }
    g.totalCents += t.cents
    g.from.push({ fromPlayerId: t.fromPlayerId, cents: t.cents })
    byCreditor.set(t.toPlayerId, g)
  }
  return [...byCreditor.values()].sort((a, b) => b.totalCents - a.totalCents)
}

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
  /**
   * THE MOVEMENT THIS LINE IS ABOUT — the signed swing for the one player its
   * label names, so a surface can colour it: green for the winner of a hole,
   * red for whoever is left holding the snake.
   *
   * Declared by the engine rather than derived from `perPlayerCents`, because
   * no rule over the numbers alone can find it. "Biggest movement" is right for
   * a winner collecting from three others and for a holder paying them, and
   * WRONG heads-up, where the two are equal and opposite and the tie-break
   * would put a green +$5 on a line reading "A pays $5".
   *
   * Optional: a line with no single subject (a team game's, where two players
   * win together) simply says nothing rather than picking one of them.
   */
  headlineCents?: number
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

/**
 * Add a money movement — and refuse one that names somebody who is not in the
 * round.
 *
 * `emptySettlement` seeds the roster, so an id it did not seed is a player the
 * round does not have: a team config carrying a stale id, restored from an
 * export `importRound` validated loosely. Accruing it was silently fatal in a
 * way nothing downstream could see. The line still balances against the ghost,
 * so `assertZeroSum` — which sums the settlement's OWN keys — stays happy; but
 * `buildSummaryCard` builds standings from `round.players` (summaryCard.ts), so
 * the share card and the settle screen show the real player's credit with no
 * matching debit. Five dollars out of nothing, on the surfaces that are the
 * whole point of the app.
 *
 * Refusing the WHOLE line, not just the ghost's share: dropping one side of a
 * payment is what unbalances it. A game that cannot say who is paying moves no
 * money at all, which is the same rule `deriveRound` applies to a game whose
 * config its engine rejects, and the same one `ctp` applies to an award naming
 * a player who isn't playing (ctp/engine.ts).
 *
 * THAT IS ONLY SAFE BECAUSE EVERY LINE BUILT HERE IS INDIVIDUALLY BALANCED —
 * a winner's credit and the matching debits arrive together, so dropping the
 * whole thing leaves the settlement exactly where it was. It is not a property
 * the type enforces. Wolf itemises per PLAYER (`{ [id]: total }`), lines that
 * balance only in aggregate, and refusing one of those WOULD unbalance the
 * game; it is unaffected only because it writes `perPlayerCents` directly and
 * never comes through here. A future engine emitting aggregate-only lines has
 * to reckon with this rather than inherit it.
 *
 * `Object.hasOwn`, not `=== undefined`: `perPlayerCents` is a plain object, so
 * `[id]` walks the prototype chain and an id of `toString` or `valueOf`
 * resolves to the inherited FUNCTION — never undefined, straight past the
 * guard. Worse than a bypass, because `?? 0` doesn't fall back on a function
 * either: the accrual becomes the string "function toString() { [native
 * code] }-500", `minimalTransfers` drops the NaN row, and the settle screen
 * renders a creditor with no debtor.
 *
 * Silently, and deliberately — throwing here would white-screen a round the
 * user can still open, which is exactly what `malformed.test.ts` exists to
 * prevent.
 */
export function addLine(settlement: Settlement, line: SettlementLine): void {
  const ids = Object.keys(line.perPlayerCents)
  if (ids.some((id) => !Object.hasOwn(settlement.perPlayerCents, id))) return
  /**
   * …AND A LINE THAT MOVES NOTHING IS NOT A MOVEMENT.
   *
   * `settlement.lines` is the record of money that MOVED, and `lines.length === 0`
   * is the settle panel's "No money moved." signal — so a row of zeroes makes
   * that signal false on a round where nothing happened, and hands every
   * consumer that counts or sums lines a phantom entry (MAI-40). `notes` is
   * where a game says something without moving money.
   *
   * ENFORCED HERE RATHER THAN PER ENGINE, because it is not one game's mistake.
   * A one-player round — refused by every `validateSetup` but accepted by
   * `importRound`, which validates a roster with `.min(1)` — makes
   * `stake * (players - 1)` zero for EVERY engine at once: Skins pushes one
   * empty row per hole, the award kit one per awarded hole, Snake one at the
   * end. Guarding them one at a time is three chances to miss the fourth, and
   * `replay.test.ts` asserts this property over the fuzz, which never deals a
   * single-player round.
   *
   * Dropping it is safe for the same reason dropping a ghost line is: every
   * line built here is individually balanced, so a line of zeroes contributes
   * nothing to `perPlayerCents` and removing it changes no total. Wolf's
   * aggregate-only rows are unaffected — it writes `perPlayerCents` directly
   * and never comes through here (its zero rows are MAI-75's, and the test
   * naming them still passes).
   */
  if (Object.values(line.perPlayerCents).every((c) => c === 0)) return
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
 *
 * Skips a balance for anyone not in `playerIds`, for the same reason `addLine`
 * refuses a line naming them — and it is a SEPARATE hole, because `addLine` is
 * not the only way a settlement gets its keys (wolf assigns `perPlayerCents`
 * directly). Left as `(combined[id] ?? 0) + cents` this had the identical
 * prototype trap: an id of `toString` resolves to the inherited function,
 * `??` does not rescue it, and the ROUND total silently becomes a string that
 * `minimalTransfers` then drops from the settle screen. Unreachable with the
 * engines shipped today; the point is that it stops being one line's problem.
 */
export function combineSettlements(
  playerIds: readonly Uuid[],
  settlements: Iterable<Settlement>,
): Record<Uuid, number> {
  const combined: Record<Uuid, number> = Object.fromEntries(playerIds.map((id) => [id, 0]))
  for (const s of settlements) {
    for (const [id, cents] of Object.entries(s.perPlayerCents)) {
      // `!` because `hasOwn` does not narrow an index signature under
      // noUncheckedIndexedAccess — the guard above is what makes it true, and
      // a `?? 0` here would read as the fallback doing the work it no longer does
      if (!Object.hasOwn(combined, id)) continue
      combined[id] = combined[id]! + cents
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

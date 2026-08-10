import { z } from 'zod'
import type { RoundPlayer, Uuid } from './types'

/** The wire shape alone — two lists of ids, with nothing said about validity. */
const teamsShape = z.object({ a: z.array(z.string()), b: z.array(z.string()) })

/**
 * Shared teams config (vegas; the match games wrap it in `.nullable()`), and
 * the LAST GATE between a hand-edited round file and a settlement that isn't
 * zero-sum.
 *
 * The non-empty and no-duplicates rules are here, not only in `validateSetup`,
 * because validateSetup does not run on import: `importRound` validates a game
 * loosely and `deriveRound` then relies on `configSchema` alone to make a bad
 * game inert (exportRound.ts). Two shapes that parse under a looser schema both
 * mint money, and both stay invisible to the property fuzz, which only ever
 * deals well-formed sides:
 *
 * - An EMPTY side can post no score, so it loses every hole and the match
 *   closes — and the settlement credits the winners while `sides[loser].map`
 *   debits nobody. A 2v0 conjures the full stake per winner out of nothing.
 * - A DUPLICATED id is charged once and counted twice: the opposing lone player
 *   pays `stake × side.length` against a side whose two entries collapse to one
 *   key in `Object.fromEntries`, so the ledger is short by a stake.
 *
 * Neither is reachable through setup, which is exactly why the guard belongs
 * where the untrusted input arrives rather than where the trusted one does.
 */
export const teamsSchema = teamsShape.refine(
  (t) =>
    t.a.length > 0 && t.b.length > 0 && new Set([...t.a, ...t.b]).size === t.a.length + t.b.length,
  { message: 'each side needs at least one player, and nobody may appear twice' },
)
export type Teams = z.infer<typeof teamsSchema>

/**
 * The teams a config is CARRYING, shape only — no validity rule applied.
 *
 * Setup's teams editor reaches an empty side by accident (tap every player onto
 * one side while reassigning), and `teamsSchema` now rejects that, so the whole
 * config fails to parse. Without this, `validateSetup` would answer a state
 * users hit mid-edit with "Invalid <game> configuration" instead of the
 * sentence that says how to fix it. Engines read the raw teams through here and
 * apply their OWN partition rule, so vegas keeps "2 players per side" while the
 * match games keep "a player on each side".
 */
export function rawTeams(config: unknown): Teams | undefined {
  const parsed = teamsShape.safeParse((config as { teams?: unknown } | null)?.teams)
  return parsed.success ? parsed.data : undefined
}

/** True when `ids` is exactly the set of round players, each used once. */
export function isPlayerPermutation(
  ids: readonly Uuid[],
  players: readonly RoundPlayer[],
): boolean {
  if (ids.length !== players.length) return false
  const expected = new Set(players.map((p) => p.playerId))
  const seen = new Set<Uuid>()
  for (const id of ids) {
    if (!expected.has(id) || seen.has(id)) return false
    seen.add(id)
  }
  return true
}

/** Validation problems for a 2v2 team partition, [] when valid. */
export function teamPartitionProblems(
  teams: Teams,
  players: readonly RoundPlayer[],
  gameName: string,
): string[] {
  if (teams.a.length !== 2 || teams.b.length !== 2)
    return [`${gameName} teams need 2 players per side`]
  if (!isPlayerPermutation([...teams.a, ...teams.b], players))
    return [`Every player must be on exactly one ${gameName.toLowerCase()} team`]
  return []
}

/**
 * Two non-empty sides that partition every player exactly once, [] when valid.
 * Unlike teamPartitionProblems this permits uneven sides (e.g. Nassau 2v1);
 * the engine settling it must keep the payout zero-sum across uneven sizes.
 */
export function nonEmptyPartitionProblems(
  teams: Teams,
  players: readonly RoundPlayer[],
  gameName: string,
): string[] {
  if (teams.a.length === 0 || teams.b.length === 0)
    return [`${gameName} needs a player on each side`]
  if (!isPlayerPermutation([...teams.a, ...teams.b], players))
    return [`Every player must be on exactly one ${gameName.toLowerCase()} side`]
  return []
}

import { z } from 'zod'
import type { RoundPlayer, Uuid } from './types'

/** Shared 2v2 teams config shape (vegas; nassau wraps it in .nullable()). */
export const teamsSchema = z.object({ a: z.array(z.string()), b: z.array(z.string()) })
export type Teams = z.infer<typeof teamsSchema>

/** True when `ids` is exactly the set of round players, each used once. */
export function isPlayerPermutation(ids: readonly Uuid[], players: readonly RoundPlayer[]): boolean {
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

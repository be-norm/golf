import { getEngine, type RoundFact } from '../engine/catalog'
import type { GameConfig } from '../engine/core/types'

/**
 * THE ONE RULE FOR WHETHER A ROUND COLLECTS A SHARED FACT, and which games
 * asked for it (MAI-90).
 *
 * A round collects putts because a game in it reads putts — never because the
 * user was offered a switch. The switch was the first design and it was wrong:
 * nothing in this app shows putts back to you, so a group playing Skins was
 * being asked for a number that went into the log and was never seen again.
 * The app is a money-game tracker, not a stat tracker, so a fact earns its
 * entry affordance by having a game that needs it.
 *
 * It is also the only way a game CAN require one. `validateSetup` sees config,
 * players and siblings — never the round — so an engine cannot refuse a round
 * that isn't collecting what it reads, and would derive nothing while looking
 * perfectly healthy in setup.
 *
 * Lives in `lib` because setup decides it and the round records it; nothing in
 * the engine reads it, which is what keeps `meta.reads` presentation-only.
 */
export function gamesReading(
  fact: RoundFact,
  games: readonly Pick<GameConfig, 'type'>[],
): string[] {
  const names: string[] = []
  for (const g of games) {
    const engine = getEngine(g.type)
    // An unregistered type (an imported round from a newer build) declares
    // nothing, which is the honest reading — we cannot know what it wanted.
    if (!engine?.meta.reads?.includes(fact)) continue
    if (!names.includes(engine.meta.name)) names.push(engine.meta.name)
  }
  return names
}

/** Does anything in this round read the fact at all? */
export const roundReads = (fact: RoundFact, games: readonly Pick<GameConfig, 'type'>[]): boolean =>
  gamesReading(fact, games).length > 0

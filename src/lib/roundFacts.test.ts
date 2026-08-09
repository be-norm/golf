import { describe, expect, it } from 'vitest'
import '../engine/games'
import { registerEngine, type GameEngine } from '../engine/catalog'
import { gamesReading, roundReads } from './roundFacts'
import { skinsEngine } from '../engine/games/skins/engine'

/**
 * MAI-90. A round collects putts because a GAME reads putts — never because
 * the user was offered a switch. The switch was the first design and it was
 * wrong: nothing in this app shows putts back to you, so a Skins round was
 * being asked for a number that went into the log and was never seen again.
 *
 * This is also the only way a game can REQUIRE one, since `validateSetup`
 * never sees the round.
 */

/** A stand-in for Snake, which is the first real reader (MAI-58). Registered
 *  here rather than waiting, so the rule is proven before its first consumer
 *  exists — and named so `catalog.test.ts`'s registry sweeps skip it. */
const puttyEngine: GameEngine = {
  ...skinsEngine,
  type: 'putty',
  meta: { ...skinsEngine.meta, name: 'Putty', reads: ['putts'] },
} as GameEngine
registerEngine(puttyEngine)

describe('round facts', () => {
  it('asks for nothing when no game reads anything', () => {
    const games = [{ type: 'skins' }, { type: 'nassau' }]
    expect(gamesReading('putts', games)).toEqual([])
    expect(roundReads('putts', games)).toBe(false)
  })

  it('names the game that needs it, so the group is told rather than asked', () => {
    expect(gamesReading('putts', [{ type: 'skins' }, { type: 'putty' }])).toEqual(['Putty'])
    expect(roundReads('putts', [{ type: 'putty' }])).toBe(true)
  })

  it('names each game once, however many instances are playing', () => {
    // two of one game is a supported round (MAI-44) and one reason to count
    // putts, not two
    expect(gamesReading('putts', [{ type: 'putty' }, { type: 'putty' }])).toEqual(['Putty'])
  })

  it('claims nothing for a game this build does not ship', () => {
    // an imported round can hold a type from a newer build; we cannot know what
    // it wanted, and guessing would turn collection on for a game that is inert
    expect(gamesReading('putts', [{ type: 'notAGame' }])).toEqual([])
  })
})

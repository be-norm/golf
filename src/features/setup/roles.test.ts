import { describe, expect, it } from 'vitest'
import '../../engine/games'
import { roleOf } from '../../engine/catalog'
import type { GameDraft } from './GameConfigCard'
import { reconcileRoles, sectionsHold } from './roles'

/**
 * The bug this file exists for: `reconcileRoles` derived every draft against
 * the role-STRIPPED set, so stamping one game silently flipped a sibling's
 * derived role. Two Skins both picked as side bets stamped only the first, and
 * the second became the round's MAIN game.
 *
 * It survived a hand-written click-through because that test walked exactly one
 * arrangement. So this walks ALL of them.
 */

const HANDICAP = { mode: 'net', allowancePct: 100, reference: 'offLow' } as const

const draft = (i: number, type: string, section: 'main' | 'side'): GameDraft => ({
  gameId: `g${i}`,
  type,
  section,
  handicap: HANDICAP,
  config: {},
})

/**
 * Two types is enough to cover the rule: `roleOf` branches on `meta.category`,
 * and the interesting one is 'either' (skins), whose answer depends on what
 * else is in the round. 'main' (nassau) is the thing that can claim the main
 * event away from it. No shipped engine is category 'side'.
 */
const TYPES = ['skins', 'nassau'] as const
const SECTIONS = ['main', 'side'] as const

/** Every arrangement of `n` games: type × section, independently, in order. */
function arrangements(n: number): GameDraft[][] {
  if (n === 0) return [[]]
  return arrangements(n - 1).flatMap((rest) =>
    TYPES.flatMap((type) =>
      SECTIONS.map((section) => [...rest, draft(rest.length, type, section)]),
    ),
  )
}

describe('reconcileRoles', () => {
  /**
   * THE invariant, over every arrangement of two and three games: whatever gets
   * stored, the round must derive back the sections the user picked. 4² + 4³ =
   * 80 arrangements, which is cheap and total.
   */
  it('makes the round derive the sections the user picked, for every arrangement', () => {
    const cases = [...arrangements(2), ...arrangements(3)]
    expect(cases).toHaveLength(80)
    for (const drafts of cases) {
      const out = reconcileRoles(drafts)
      const shape = drafts.map((d) => `${d.type}:${d.section}`).join(' + ')
      expect(sectionsHold(out), shape).toBe(true)
      // and it never quietly loses or reorders a game
      expect(out.map((g) => g.gameId)).toEqual(drafts.map((g) => g.gameId))
    }
  })

  /** The exact arrangement that shipped broken. */
  it('keeps BOTH of two side-bet skins as side bets', () => {
    const out = reconcileRoles([draft(0, 'skins', 'side'), draft(1, 'skins', 'side')])
    expect(sectionsHold(out)).toBe(true)
    // it takes a stamp on each: roleOf insists SOMETHING is the main event, and
    // the user said neither of these is
    expect(out.map((g) => g.role)).toEqual(['side', 'side'])
  })

  /**
   * Storing the fewest overrides is the other half of the job — a stored guess
   * is permanent in an archive that syncs, so an override that merely agrees
   * with the rule is noise a better rule could never re-read.
   */
  it('stores nothing when the derived roles already match', () => {
    // nassau can only be the main event, so an "either" beside it IS the side bet
    const out = reconcileRoles([draft(0, 'nassau', 'main'), draft(1, 'skins', 'side')])
    expect(out.map((g) => g.role)).toEqual([undefined, undefined])
  })

  /**
   * The repair stamps only what still disagrees. A blanket "if it doesn't hold,
   * store everything" fallback got the same round DERIVING correctly while
   * freezing a third override nothing needed — and every stored role is
   * permanent in an archive that syncs.
   */
  it('stamps only what still disagrees, not everything', () => {
    const out = reconcileRoles([
      draft(0, 'skins', 'main'),
      draft(1, 'skins', 'main'),
      draft(2, 'skins', 'side'),
    ])
    expect(sectionsHold(out)).toBe(true)
    expect(out.map((g) => g.role)).toEqual(['main', 'main', undefined])
  })

  /** Whatever it stores, dropping any one of them must break the round. */
  it('stores no override it could have left out', () => {
    for (const drafts of [...arrangements(2), ...arrangements(3)]) {
      const out = reconcileRoles(drafts)
      out.forEach((game, i) => {
        if (game.role === undefined) return
        const without = out.map((g, j) => (i === j ? { ...g, role: undefined } : g))
        expect(sectionsHold(without), `${game.type}:${game.section} @${i}`).toBe(false)
      })
    }
  })

  it('stores one override for a skins promoted alongside a nassau', () => {
    const out = reconcileRoles([draft(0, 'nassau', 'main'), draft(1, 'skins', 'main')])
    expect(sectionsHold(out)).toBe(true)
    expect(out.map((g) => g.role)).toEqual([undefined, 'main'])
  })

  /**
   * Under two games nothing READS the difference — `primaryGame` returns the
   * only game whichever role it holds, the bar collapses nothing and the card
   * groups nothing — so the value would have no consumer.
   */
  it('stores nothing at all in a one-game round, whichever section', () => {
    for (const section of SECTIONS) {
      expect(reconcileRoles([draft(0, 'skins', section)])[0]!.role).toBeUndefined()
    }
    expect(reconcileRoles([])).toEqual([])
  })

  it('drops a role that a removal has made unnecessary', () => {
    const promoted = reconcileRoles([draft(0, 'nassau', 'main'), draft(1, 'skins', 'main')])
    expect(promoted[1]!.role).toBe('main')
    // take the nassau away and the skins is the only game — nothing to override
    expect(reconcileRoles([promoted[1]!])[0]!.role).toBeUndefined()
  })
})

/**
 * Proves the invariant is not vacuous: the OLD implementation, derived against
 * the role-stripped set, genuinely fails it. Without this a bug in
 * `sectionsHold` would make the sweep above pass on anything.
 */
describe('the invariant can fail', () => {
  it('rejects the role-stripped derivation the bug shipped', () => {
    const drafts = [draft(0, 'skins', 'side'), draft(1, 'skins', 'side')]
    // the OLD implementation, verbatim: every draft judged against the set with
    // all roles stripped, so no stamp is visible to its siblings
    const bare = drafts.map((d) => ({ ...d, role: undefined }))
    const oldWay = drafts.map((d, i) => ({
      ...d,
      role: roleOf(bare[i]!, bare) === d.section ? undefined : d.section,
    }))
    expect(oldWay.map((g) => g.role)).toEqual(['side', undefined])
    // and that round does NOT derive back what the user picked — the second
    // skins reads as the main event
    expect(sectionsHold(oldWay)).toBe(false)
    expect(roleOf(oldWay[1]!, oldWay)).toBe('main')
  })
})

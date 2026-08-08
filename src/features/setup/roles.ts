import { roleOf } from '../../engine/catalog'
import type { GameDraft } from './GameConfigCard'

/**
 * Recompute every draft's stored `role`, so that `roleOf` reproduces the
 * sections the user actually picked. Run on every add and remove, because an
 * "either" game's role is a fact about the WHOLE round and the round just
 * changed.
 *
 * `role` is an OVERRIDE, so the aim is to store the FEWEST of them: a round
 * that stores nothing can be re-read by a better rule later, while a stored
 * guess is wrong permanently in an archive that syncs. Under two games we store
 * nothing at all — `primaryGame` returns the only game whichever role it holds,
 * the bar never collapses a lone side bet and the card never groups one, so the
 * value would have no reader.
 *
 * THE MINIMISATION IS CIRCULAR, which is the whole difficulty. Stamping one
 * game changes what its siblings derive: `roleOf` skips explicitly-roled games
 * when it looks for the first unclaimed "either" game. Deriving every draft
 * against the role-STRIPPED set therefore silently broke the sibling — two
 * Skins both picked as side bets stamped only the first, and the second then
 * became the round's MAIN game, capturing the stroke dots, the scorecard's
 * underlines and the share card's stroke note.
 *
 * A naive fixpoint doesn't work either: those same two drafts oscillate, each
 * pass handing the stamp to the other. So: decide in order against the roles
 * decided so far, then CHECK the result actually reproduces every section. If
 * it doesn't, store all of them — trivially consistent, since an explicit role
 * short-circuits `roleOf`, and still rare enough to be worth the attempt.
 *
 * Lives here rather than inside the component because the invariant it has to
 * hold (`sectionsHold`, below) is worth proving exhaustively rather than
 * through one hand-written click-through — which is exactly how the sibling bug
 * got in.
 */
export function reconcileRoles(drafts: readonly GameDraft[]): GameDraft[] {
  if (drafts.length < 2) return drafts.map((d) => ({ ...d, role: undefined }))
  const out: GameDraft[] = drafts.map((d) => ({ ...d, role: undefined }))
  out.forEach((draft, i) => {
    out[i] = {
      ...draft,
      role: roleOf(draft, out) === draft.section ? undefined : draft.section,
    }
  })
  return sectionsHold(out) ? out : drafts.map((d) => ({ ...d, role: d.section }))
}

/**
 * THE invariant: what the round derives is what the user picked, for every
 * game. Exported so the test asserts the real predicate rather than a
 * paraphrase of it.
 */
export function sectionsHold(drafts: readonly GameDraft[]): boolean {
  return drafts.every((g) => roleOf(g, drafts) === g.section)
}

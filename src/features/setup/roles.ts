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
 * pass handing the stamp to the other. So it runs in three stages:
 *
 * 1. decide in order, against the roles decided so far;
 * 2. REPAIR — stamp whatever still disagrees, and only that. Adds only, so it
 *    cannot oscillate; worst case every game is stamped, which is trivially
 *    consistent because an explicit role short-circuits `roleOf`.
 * 3. PRUNE — drop any override the round turns out not to need, re-checking the
 *    invariant on each removal.
 *
 * Stage 3 earns its keep because stage 1 decides in order and can stamp a game
 * before a LATER game's stamp makes it unnecessary: "skins into Main, nassau
 * into Side" stamps both, though demoting the nassau is enough on its own. It
 * repeats, since removing one override can free another, and every removal is
 * validated — so the result is consistent AND holds no override that could
 * have been left out. That matters because a stored role is permanent in an
 * archive that syncs.
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
  for (let pass = 0; pass < out.length; pass++) {
    let stamped = false
    out.forEach((g, i) => {
      // `role === undefined` keeps this monotonic: a stamp is never revisited,
      // so the loop always shrinks the set of games left to convince.
      if (g.role === undefined && roleOf(g, out) !== g.section) {
        out[i] = { ...g, role: g.section }
        stamped = true
      }
    })
    if (!stamped) break
  }
  for (let pass = 0; pass < out.length; pass++) {
    let dropped = false
    out.forEach((g, i) => {
      if (g.role === undefined) return
      const without = out.map((x, j) => (i === j ? { ...x, role: undefined } : x))
      if (sectionsHold(without)) {
        out[i] = without[i]!
        dropped = true
      }
    })
    if (!dropped) break
  }
  return out
}

/**
 * THE invariant: what the round derives is what the user picked, for every
 * game. Exported so the test asserts the real predicate rather than a
 * paraphrase of it.
 */
export function sectionsHold(drafts: readonly GameDraft[]): boolean {
  return drafts.every((g) => roleOf(g, drafts) === g.section)
}

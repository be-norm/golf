import type { Award } from '../../engine/catalog'
import type { Uuid } from '../../engine/core/types'

interface AwardGridProps {
  /** every award offered on the hole being shown, across every game */
  awards: Award[]
  /** column order — the same order as the score rows above, always */
  playerIds: readonly Uuid[]
  /** the game's label, for the section heading */
  gameName: (gameId: Uuid) => string
  onTake: (award: Award) => void
  onUndo: (award: Award) => void
}

/**
 * The third input channel's surface: give THIS player THIS thing on THIS hole
 * (MAI-46). Group rows × player cells, inline under the score rows.
 *
 * IT HAS NO FRONTIER GATE AND NO all-scored GATE, and that is the entire point.
 * The actions affordance above is right to have both — a press belongs to the
 * tee you are standing on — but an award belongs to the hole it happened on,
 * and you remember it on 12, or fix it on the 18th green. Page back and it is
 * still here.
 *
 * Every cell is a TOGGLE, like the actions sheet's rows: the lit one takes
 * itself back. Nothing here knows what any game is — the engine decides which
 * groups appear on which hole (KP only on par 3s), so this stays generic.
 */
export function AwardGrid({ awards, playerIds, gameName, onTake, onUndo }: AwardGridProps) {
  if (awards.length === 0) return null

  // Grouped by game, then by row, both in first-seen order so the layout cannot
  // reshuffle between re-derives. Cells are ordered by the ROUND's roster, so
  // the columns line up with the score rows above however an engine emits them.
  const byGame = new Map<Uuid, Map<string, Award[]>>()
  for (const a of awards) {
    if (!playerIds.includes(a.playerId)) continue
    const rows = byGame.get(a.gameId) ?? new Map<string, Award[]>()
    rows.set(a.group, [...(rows.get(a.group) ?? []), a])
    byGame.set(a.gameId, rows)
  }
  const order = (cells: Award[]) =>
    [...cells].sort((x, y) => playerIds.indexOf(x.playerId) - playerIds.indexOf(y.playerId))

  // The game heading exists to DISAMBIGUATE, so it appears only when there is
  // something to disambiguate. One award game's rows already say what they are
  // ("Greenie", "Sandie"), and CTP is the degenerate case that makes this
  // visible rather than merely tidy: its only row is named after the game, so
  // an unconditional heading stacks "CLOSEST TO THE PIN" directly on top of
  // "CLOSEST TO THE PIN". Two award games running at once get their headings
  // back, which is the case the heading was written for.
  const showGameNames = byGame.size > 1

  return (
    // Named region: the pinned bar below carries the same game labels, so this
    // is what lets a reader (and a test) tell "the CTP row" from "the CTP grid".
    <section
      aria-label="Awards"
      className="mt-4 space-y-4 border-t-2 border-stone-800 pt-4"
    >
      {[...byGame].map(([gameId, rows]) => (
        <div key={gameId} className="space-y-3">
          {showGameNames && (
            <h2 className="font-display text-[10px] uppercase text-felt-300">{gameName(gameId)}</h2>
          )}
          {[...rows].map(([group, cells]) => (
            <div key={group}>
              <p className="font-display mb-1.5 text-[10px] uppercase text-stone-400">{group}</p>
              {/* Wraps rather than sharing one line with the row label: four
                  names and a label do not fit a phone, and eight never would. */}
              <div className="flex flex-wrap gap-2">
                {order(cells).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => (a.taken ? onUndo(a) : onTake(a))}
                    aria-pressed={a.taken}
                    aria-label={`${group} — ${a.label}`}
                    className={`pixel-press min-w-16 max-w-36 truncate px-3 py-2.5 text-lg ${
                      a.taken
                        ? 'border-felt-500 bg-felt-900/60 text-felt-300'
                        : 'border-stone-600 bg-stone-800 text-stone-300'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}

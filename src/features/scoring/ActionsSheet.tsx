import type { GameAction, GameDerivation } from '../../engine/catalog'
import { DetailLines } from '../../components/DetailLines'
import { Sheet } from '../../components/Sheet'

interface ActionsSheetProps {
  open: boolean
  onClose: () => void
  actions: GameAction[]
  /** every game with a ledger, so the sheet can show what the action acts ON */
  games: { gameId: string; name: string; derivation: GameDerivation }[]
  onTake: (action: GameAction) => void
  onUndo: (action: GameAction) => void
}

/**
 * The pull half of optional game actions: everything that is legal right now,
 * each with the reason it is on offer and what taking it costs.
 *
 * This is where "why is it suggesting this?" gets answered — the bar and the
 * button can only ever carry a nudge, so the sheet has to carry the argument.
 *
 * Rows TOGGLE. A press you have taken stays in the list, engaged, and tapping
 * it again takes it back — a mistap on a money bet should not be final, and
 * hunting for the global undo is not an answer.
 */
export function ActionsSheet({ open, onClose, actions, games, onTake, onUndo }: ActionsSheetProps) {
  // Every action starts from the hole being played, which is what the screen is
  // showing — say it anyway, so a press never starts somewhere unexpected.
  const startHole = actions[0]?.hole

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="space-y-5">
        <div>
          <h2 className="font-display text-xs uppercase text-felt-300">
            {startHole === undefined ? 'Presses' : `Press from hole ${startHole}`}
          </h2>
          <p className="mt-1 text-stone-400">
            A press is a new bet at the same stake, running from that hole to the end of the
            stretch. You can press any bet you're down on.
          </p>
        </div>

        {actions.length === 0 ? (
          // States the RULE, not one of its causes. "Every bet is level" was
          // true until bets could close: a decided bet isn't level, it's over,
          // and this sheet exists to answer "why can't I press?" honestly.
          // Which bet is which is right below, in the per-bet ledger.
          <p className="pixel border-stone-700 bg-stone-800/50 p-4 text-lg text-stone-400">
            Nothing to press — a press needs a live bet you're down on.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {actions.map((a) => {
              // engaged and the player's to take back; an auto-press is engaged
              // but inert — the rules started it, so it isn't theirs to undo
              const undoable = a.taken && (a.undoEventIds?.length ?? 0) > 0
              return (
                <li key={a.id}>
                  <button
                    onClick={() => (a.taken ? onUndo(a) : onTake(a))}
                    disabled={a.taken && !undoable}
                    aria-pressed={a.taken ?? false}
                    className={`pixel-press flex w-full items-center justify-between gap-3 px-4 py-3 text-left disabled:opacity-60 ${
                      a.taken
                        ? 'border-felt-500 bg-felt-900/60'
                        : a.recommended
                          ? 'border-coin-500 bg-coin-500/10'
                          : 'border-stone-600 bg-stone-800'
                    }`}
                  >
                    <span>
                      <span
                        className={`font-display block text-xs uppercase ${
                          a.taken
                            ? 'text-felt-300'
                            : a.recommended
                              ? 'text-coin-400'
                              : 'text-stone-200'
                        }`}
                      >
                        {a.taken && '✓ '}
                        {a.label}
                      </span>
                      <span className="mt-1 block text-stone-400">{a.detail}</span>
                      <span className="mt-0.5 block text-stone-500">{a.effect}</span>
                    </span>
                    <span className="font-display shrink-0 text-[9px] uppercase">
                      {undoable ? (
                        <span className="text-felt-300">Tap to undo</span>
                      ) : a.taken ? (
                        <span className="text-stone-500">auto</span>
                      ) : (
                        a.recommended && <span className="text-coin-400">2 down</span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {games.map((g) => {
          const lines = g.derivation.detailLines
          if (!lines || lines.length === 0) return null
          return (
            <div key={g.gameId}>
              <h3 className="font-display mb-2 text-[10px] uppercase text-stone-500">
                {g.name} — every bet
              </h3>
              <div className="border-l-2 border-stone-800 pl-3">
                <DetailLines lines={lines} />
              </div>
            </div>
          )
        })}
      </div>
    </Sheet>
  )
}

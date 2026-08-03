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
}

/**
 * The pull half of optional game actions: everything that is legal right now,
 * each with the reason it is on offer and what taking it costs.
 *
 * This is where "why is it suggesting this?" gets answered — the bar and the
 * button can only ever carry a nudge, so the sheet has to carry the argument.
 */
export function ActionsSheet({ open, onClose, actions, games, onTake }: ActionsSheetProps) {
  // Actions start from the frontier hole, which is NOT necessarily the hole on
  // screen — the scorekeeper may have paged back to fix an earlier score. Say
  // the hole out loud so a press never starts somewhere the reader didn't expect.
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
          <p className="pixel border-stone-700 bg-stone-800/50 p-4 text-lg text-stone-400">
            Nothing to press — every bet is level.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {actions.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => onTake(a)}
                  className={`pixel-press flex w-full items-center justify-between gap-3 px-4 py-3 text-left ${
                    a.recommended
                      ? 'border-coin-500 bg-coin-500/10'
                      : 'border-stone-600 bg-stone-800'
                  }`}
                >
                  <span>
                    <span
                      className={`font-display block text-xs uppercase ${
                        a.recommended ? 'text-coin-400' : 'text-stone-200'
                      }`}
                    >
                      {a.label}
                    </span>
                    <span className="mt-1 block text-stone-400">{a.detail}</span>
                    <span className="mt-0.5 block text-stone-500">{a.effect}</span>
                  </span>
                  {a.recommended && (
                    <span className="font-display shrink-0 text-[9px] uppercase text-coin-400">
                      2 down
                    </span>
                  )}
                </button>
              </li>
            ))}
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

import { useState } from 'react'
import { eventStore } from '../../db/eventStore'
import { getEngine, roleOf } from '../../engine/catalog'
import { effectiveEvents } from '../../engine/core/replay'
import { formatCentsSigned } from '../../engine/core/money'
import { gameLabel } from '../../engine/label'
import type { GameConfig } from '../../engine/core/types'
import { amendmentImpact, settingsChanged } from '../../lib/roundSettings'
import { BigButton } from '../../components/BigButton'
import { Sheet } from '../../components/Sheet'
import { GameConfigCard, type GameDraft } from '../setup/GameConfigCard'
import type { RoundView } from './useRound'

/**
 * CHANGE A BET WITHOUT RESTARTING THE ROUND (MAI-100/101).
 *
 * A group set the Snake pot wrong and noticed on the ninth green; before this
 * the only way out was to abandon the round. What they want is not "from here
 * on" — it is "the pot was always $2" — so saving appends a `game/configured`
 * amendment, which re-prices every hole including the ones already read out.
 *
 * IT REUSES `GameConfigCard` RATHER THAN DRAWING ITS OWN FIELDS. `ConfigField`
 * is deliberately the one editor for a game's declared specs — the catalog had
 * two renderers of them once and they drifted immediately — so the card is
 * handed a local draft and told to edit it, exactly as setup does. Which also
 * means a game added to the catalog tomorrow is editable here with no work.
 *
 * A LOCAL DRAFT WITH AN EXPLICIT SAVE, not live editing. Setup mutates a draft
 * in memory and writes once at tee-off; here every change is an append to a log
 * that syncs and exports, so a stepper tapped from $1 to $5 would leave sixteen
 * amendments in the round's history.
 */
export function GameSettingsSheet({
  view,
  gameId,
  readOnly,
  onClose,
  onRules,
}: {
  view: RoundView
  /** the game being edited, or undefined when the sheet is closed */
  gameId: string | undefined
  /**
   * A COMPLETED ROUND STATES ITS SETTINGS AND DOES NOT CHANGE THEM, and the
   * reason is sharper than consistency with the award grid: nothing re-pushes a
   * round because its log grew. `finish()` pushes the snapshot it takes at that
   * moment, so an amendment made afterwards moves money on this phone and never
   * reaches `round_archives` — the synced copy keeps the old numbers and a
   * reinstatement restores them. Reopen → change → Finish is the flow that
   * pushes, which is exactly why this must not offer a shortcut past it.
   */
  readOnly: boolean
  onClose: () => void
  onRules: (type: string) => void
}) {
  const game = view.round.games.find((g) => g.gameId === gameId)
  return (
    <Sheet open={game !== undefined} onClose={onClose}>
      {game && (
        // Remounted per game, so the draft below is seeded from the game being
        // opened rather than kept from the last one — the alternative is an
        // effect that resets state, which is the same thing spelled worse.
        <Editor
          key={game.gameId}
          view={view}
          game={game}
          readOnly={readOnly}
          onClose={onClose}
          onRules={onRules}
        />
      )}
    </Sheet>
  )
}

function Editor({
  view,
  game,
  readOnly,
  onClose,
  onRules,
}: {
  view: RoundView
  game: GameConfig
  readOnly: boolean
  onClose: () => void
  onRules: (type: string) => void
}) {
  const { round, ctx, events } = view
  const engine = getEngine(game.type)
  const [draft, setDraft] = useState<GameDraft>({
    gameId: game.gameId,
    type: game.type,
    // NORMALISED, because `handicap` is optional in the wild even though the
    // amendment payload requires one: `importSchema` lets a game through
    // without it, and the sync boundary applies a round with a bare cast. An
    // unguarded read would send `undefined` into `eventDraftSchema.parse`,
    // which THROWS rather than returning a result — the save would die on the
    // one round that most needs repairing.
    handicap: game.handicap ?? engine?.defaultHandicap() ?? {
      mode: 'gross',
      allowancePct: 100,
      reference: 'absolute',
    },
    config: game.config,
    // The card lays itself out by `section`; mid-round the honest answer is
    // whatever the round currently derives.
    section: roleOf(game, round.games),
    ...(game.role ? { role: game.role } : {}),
  })
  const [failed, setFailed] = useState(false)

  if (!engine) {
    return (
      <p className="text-stone-400">
        This round holds a game this version of the app doesn’t know how to set up.
      </p>
    )
  }

  const label = gameLabel(game, round.games)
  const problems = engine.validateSetup(
    draft,
    round.players,
    round.games.filter((g) => g.gameId !== game.gameId),
  )
  // Locked ONCE ANYTHING IS SCORED, which is `amendRound`'s own boundary — so
  // the control disappears exactly when the write would be refused, rather than
  // the screen offering something the fold will silently drop.
  //
  // EFFECTIVE events, not raw, because that is the log the fold reads. Score a
  // hole and undo it and the round has never been scored: the engine would take
  // a rotation amendment, while a raw read still showed the field locked with a
  // reason that had stopped being true.
  const scored = effectiveEvents(events).some((e) => e.type === 'score/set')
  const locked = scored
    ? engine.configFields.filter((f) => f.midRound === 'locked').map((f) => f.key)
    : []

  const amendment = {
    type: 'game/configured' as const,
    gameId: game.gameId,
    config: draft.config,
    handicap: draft.handicap,
    ...(draft.role ? { role: draft.role } : {}),
  }
  const changed = settingsChanged(game, draft)
  const impact = changed
    ? amendmentImpact(round, events, [amendment])
    : { swing: [], riding: [] }

  const save = () => {
    // Nothing to say, so say nothing. An amendment that changes no setting is
    // still permanent in an append-only log that syncs and exports — the rule
    // the scoring screen's input channel follows for the same reason.
    if (!changed) return onClose()
    setFailed(false)
    void eventStore
      .append(round.id, [amendment])
      .then(onClose)
      // `EventStore.append` validates with `eventDraftSchema.parse`, which
      // THROWS. Without this the sheet would sit there looking live with the
      // change silently unwritten.
      .catch(() => setFailed(true))
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xs uppercase text-felt-300">{label} settings</h2>
        <p className="mt-1.5 text-sm text-stone-400">
          {readOnly
            ? 'This round is finished. Reopen it to change a bet.'
            : 'Changes apply to the whole round, including holes already played.'}
        </p>
      </div>

      {/* `open` is fixed: this sheet IS the expansion, so a fold inside it would
          be a second one. `holes` is the round's own walk, in play order —
          without it a hole-picking field draws an empty grid. Players carry
          their REAL ids as `draftId`, so team and rotation edits write player
          ids directly and no resolve pass is needed. */}
      <fieldset disabled={readOnly} className={readOnly ? 'opacity-70' : undefined}>
        <GameConfigCard
          engine={engine}
          label={label}
          players={round.players.map((p) => ({ draftId: p.playerId, name: p.name }))}
          holes={ctx.holesPlayed}
          draft={draft}
          problems={problems}
          open
          lockedFields={locked}
          onToggle={() => {}}
          onChange={setDraft}
          onRules={() => onRules(game.type)}
        />
      </fieldset>

      {/* WHAT THIS DOES TO THE MONEY, before it is written. An amendment
          re-prices holes that are already settled and already read out — correct,
          and alarming, so it is stated in numbers rather than left for the group
          to notice on the bar afterwards. */}
      {!readOnly && changed && (
        <div className="pixel border-coin-500/40 bg-coin-500/10 px-4 py-3">
          <p className="font-display text-[10px] uppercase text-coin-400">Re-prices the round</p>
          {impact.swing.length > 0 && (
            <p className="mt-1 text-stone-300">
              {impact.swing.map((s) => `${s.name} ${formatCentsSigned(s.cents)}`).join(' · ')}
            </p>
          )}
          {/* A BET THAT HASN'T SETTLED STILL CHANGED. The snake is worth
              something to somebody all round and settles only at the end, so
              editing its pot moves no money yet — and reporting only the swing
              said "No change to the money" about the very edit just made. */}
          {impact.riding.map((position) => (
            <p key={position} className="mt-1 text-stone-300">
              Now riding: {position}
            </p>
          ))}
          {impact.swing.length === 0 && impact.riding.length === 0 && (
            <p className="mt-1 text-stone-300">Nothing settled yet — no money moves.</p>
          )}
        </div>
      )}

      {failed && (
        <p className="text-sm text-flag-500">
          That didn’t save. Check the settings and try again.
        </p>
      )}

      {!readOnly && (
        <div className="flex gap-2.5">
          <BigButton variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </BigButton>
          <BigButton className="flex-1" disabled={problems.length > 0} onClick={save}>
            Save
          </BigButton>
        </div>
      )}
    </div>
  )
}

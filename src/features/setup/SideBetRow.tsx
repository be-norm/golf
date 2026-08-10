import { useId } from 'react'
import type { GameEngine } from '../../engine/catalog'
import {
  ConfigField,
  isPlayable,
  playerCountNote,
  stakeSummary,
  type FieldPlayer,
} from './ConfigField'
import { DisclosureArrow } from './DisclosureArrow'
import { HandicapControls } from './HandicapControls'
import type { GameDraft } from './GameConfigCard'

interface Props {
  engine: GameEngine
  /** `gameLabel(draft, allDrafts)` — see GameConfigCard's `label`. */
  label: string
  players: FieldPlayer[]
  draft: GameDraft
  /** This game's own `validateSetup` problems — see GameConfigCard's `problems`. */
  problems: string[]
  /** Whether the settings are showing. Owned by SetupScreen — see `collapsed`. */
  open: boolean
  onToggle: () => void
  onChange: (draft: GameDraft) => void
  onRemove: () => void
  onRules: () => void
}

/**
 * A chosen SIDE BET: name, stake and settings, foldable to a single line.
 *
 * It used to arrive FOLDED, on a density argument — side bets are numerous by
 * nature (~20 in the catalogue) and four full cards is a scrolling screen
 * before a ball is struck. That was the wrong trade (MAI-89): a row whose
 * settings are behind a tap reads as a row with no settings, so groups teed off
 * on a default stake they never knew was theirs to change. Discoverability
 * wins; the fold is still here, for once you are done with the bet.
 *
 * This is not the scoring bar's rule inverted. That bar folds N side bets into
 * one line only when folding SAVES a row (CLAUDE.md, `shouldGroupSideBets`) —
 * it is a readout, and its job is to compress. This is an editor, and its job
 * is to show you what you can change.
 *
 * The expanded body renders `ConfigField` and `HandicapControls` — the same
 * components the main card uses, not compact variants of them. A side bet is an
 * ordinary peer game (invariant #7), so its editor cannot be a lesser one.
 */
export function SideBetRow({
  engine,
  label,
  players,
  draft,
  problems,
  open,
  onToggle,
  onChange,
  onRemove,
  onRules,
}: Props) {
  const config = (draft.config ?? {}) as Record<string, unknown>
  const setConfigValue = (key: string, value: unknown) =>
    onChange({ ...draft, config: { ...config, [key]: value } })
  const stake = stakeSummary(engine, config)
  const stranded = !isPlayable(engine, players.length)
  // roster first, then the engine's own — never instead of them, see the main card
  const wrong = stranded ? [playerCountNote(engine), ...problems] : problems
  // scoped per instance — see GameConfigCard's `panelId`
  const panelId = useId()

  return (
    // a named group, for the same reason the main card is one
    <div role="group" aria-label={label} className="pixel border-felt-700 bg-felt-900/40">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          aria-label={`remove ${label}`}
          onClick={onRemove}
          className="shrink-0 px-1 text-stone-500"
        >
          ✕
        </button>
        <button
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
        >
          <span className="min-w-0 truncate font-medium">{label}</span>
          <span className="flex shrink-0 items-center gap-2">
            {!open && stake && <span className="tabular-nums text-stone-300">{stake}</span>}
            <DisclosureArrow open={open} />
          </span>
        </button>
      </div>

      {/* outside the fold — see the main card */}
      {wrong.map((problem) => (
        <p key={problem} className="px-3 pb-2 text-xs text-flag-500">
          {problem}
        </p>
      ))}

      {open && (
        <div id={panelId} className="space-y-4 border-t border-felt-800/60 px-3 py-3">
          {engine.configFields.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              value={config[field.key]}
              players={players}
              gameName={label}
              onChange={(v) => setConfigValue(field.key, v)}
            />
          ))}
          <HandicapControls
            handicap={draft.handicap}
            gameName={label}
            onChange={(handicap) => onChange({ ...draft, handicap })}
          />
          <button
            aria-label={`${label} rules`}
            onClick={onRules}
            className="font-display text-[10px] uppercase text-felt-400"
          >
            Rules ▶
          </button>
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import type { GameEngine } from '../../engine/catalog'
import {
  ConfigField,
  isPlayable,
  playerCountNote,
  stakeSummary,
  type FieldPlayer,
} from './ConfigField'
import { HandicapControls } from './HandicapControls'
import type { GameDraft } from './GameConfigCard'

interface Props {
  engine: GameEngine
  /** `gameLabel(draft, allDrafts)` — see GameConfigCard's `label`. */
  label: string
  players: FieldPlayer[]
  draft: GameDraft
  onChange: (draft: GameDraft) => void
  onRemove: () => void
  onRules: () => void
}

/**
 * A chosen SIDE BET: one line — name, stake, disclosure — that expands in place
 * into the same fields a main game gets.
 *
 * Side bets are numerous by nature (the catalogue has ~20 of them queued), and
 * a full config card each would make a round with four of them a scrolling
 * screen before a ball is struck. The stake is shown because it is what people
 * actually name the bet by; everything else is one tap away.
 *
 * The expanded body renders `ConfigField` and `HandicapControls` — the same
 * components the main card uses, not compact variants of them. A side bet is an
 * ordinary peer game (invariant #7), so its editor cannot be a lesser one.
 */
export function SideBetRow({ engine, label, players, draft, onChange, onRemove, onRules }: Props) {
  const [open, setOpen] = useState(false)
  const config = (draft.config ?? {}) as Record<string, unknown>
  const setConfigValue = (key: string, value: unknown) =>
    onChange({ ...draft, config: { ...config, [key]: value } })
  const stake = stakeSummary(engine, config)
  const stranded = !isPlayable(engine, players.length)

  return (
    <div className="pixel border-felt-700 bg-felt-900/40">
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
          onClick={() => setOpen((v) => !v)}
        >
          <span className="min-w-0 truncate font-medium">{label}</span>
          <span className="flex shrink-0 items-center gap-2">
            {stake && <span className="tabular-nums text-stone-300">{stake}</span>}
            {/* ▶ rotated, rather than a second glyph: the pixel display font
                has no ▾/▸ and paints them as invisible specks, while ▶ is
                already proven here (HoleArrow, "Rules ▶"). */}
            <span
              className={`font-display inline-block text-[10px] text-felt-400 transition-transform ${
                open ? 'rotate-90' : ''
              }`}
            >
              ▶
            </span>
          </span>
        </button>
      </div>

      {stranded && (
        <p className="px-3 pb-2 text-xs text-flag-500">{playerCountNote(engine)}</p>
      )}

      {open && (
        <div className="space-y-4 border-t border-felt-800/60 px-3 py-3">
          {engine.configFields.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              value={config[field.key]}
              players={players}
              onChange={(v) => setConfigValue(field.key, v)}
            />
          ))}
          <HandicapControls
            handicap={draft.handicap}
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

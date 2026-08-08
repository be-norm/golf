import type { GameEngine } from '../../engine/catalog'
import type { HandicapSettings, Uuid } from '../../engine/core/types'
import { ConfigField, isPlayable, playerCountNote, type FieldPlayer } from './ConfigField'
import { HandicapControls } from './HandicapControls'

export interface GameDraft {
  /**
   * The instance id, minted when the game is CHOSEN and carried straight
   * through to `GameConfig.gameId` at tee-off.
   *
   * Setup used to key everything by `engine.type`, which capped a round at one
   * instance per game — so "gross skins AND net skins", the round `gameLabel`'s
   * whole discriminator ladder exists to name, was unreachable from the UI
   * (MAI-44). It is also what lets `validateSetup` tell a game from its
   * siblings, which a synthetic shared id could not.
   */
  gameId: Uuid
  type: string
  handicap: HandicapSettings
  config: unknown
  /**
   * Written ONLY when the user's chosen section contradicts what `roleOf`
   * derives. See SetupScreen's `roleToStore`.
   */
  role?: 'main' | 'side'
}

interface Props {
  engine: GameEngine
  players: FieldPlayer[]
  draft: GameDraft
  onChange: (draft: GameDraft) => void
  onRemove: () => void
  onRules: () => void
}

/** A chosen MAIN game: everything it can be configured with, open on the page. */
export function GameConfigCard({ engine, players, draft, onChange, onRemove, onRules }: Props) {
  const config = (draft.config ?? {}) as Record<string, unknown>
  const setConfigValue = (key: string, value: unknown) =>
    onChange({ ...draft, config: { ...config, [key]: value } })
  // A game can be stranded after the fact — chosen with four players, then a
  // player dropped on the way back through step 1. The red problems list blocks
  // tee-off, but the card should say why on its own rather than leaving the
  // reason somewhere else on the screen.
  const stranded = !isPlayable(engine, players.length)

  return (
    <div className="pixel border-felt-500 bg-felt-900/60">
      <div className="flex items-start justify-between gap-3 px-4 pb-1 pt-4">
        <div className="min-w-0 flex-1">
          <span className="text-lg font-bold">{engine.meta.name}</span>
          <p className={`text-sm ${stranded ? 'text-flag-500' : 'text-stone-400'}`}>
            {stranded ? playerCountNote(engine) : engine.meta.blurb}
          </p>
        </div>
        <button
          aria-label={`remove ${engine.meta.name}`}
          onClick={onRemove}
          className="flex size-7 shrink-0 items-center justify-center bg-stone-800 text-sm font-bold text-stone-400"
        >
          ✕
        </button>
      </div>
      <button
        aria-label={`${engine.meta.name} rules`}
        onClick={onRules}
        className="font-display px-4 pb-3 pt-1 text-[10px] uppercase text-felt-400"
      >
        Rules ▶
      </button>

      <div className="space-y-4 border-t border-felt-800/60 px-4 py-4">
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
      </div>
    </div>
  )
}

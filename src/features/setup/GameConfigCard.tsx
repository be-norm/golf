import { useId } from 'react'
import type { GameEngine } from '../../engine/catalog'
import type { HandicapSettings, Uuid } from '../../engine/core/types'
import {
  ConfigField,
  isPlayable,
  playerCountNote,
  stakeSummary,
  statesPlayerCount,
  type FieldPlayer,
} from './ConfigField'
import { DisclosureArrow } from './DisclosureArrow'
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
   * Which section the user picked this game into. SETUP-ONLY — it never
   * reaches the round.
   *
   * It is what step 2 lays the game out by, so tapping "+ Add a side bet" can
   * never drop the game under MAIN GAME(S). Deriving the layout from `roleOf`
   * instead did exactly that for a lone Skins, which is true (one game IS the
   * round's main event) and still reads as the screen ignoring you.
   */
  section: 'main' | 'side'
  /**
   * Written ONLY when `section` contradicts what `roleOf` would derive, and
   * only in a round where something reads the difference. See
   * SetupScreen's `reconcileRoles`.
   */
  role?: 'main' | 'side'
}

interface Props {
  engine: GameEngine
  /**
   * `gameLabel(draft, allDrafts)` — the discriminated name ("Skins ($1)"),
   * because this screen exists to hold several instances of one game and
   * `meta.name` gives every one of them the same name, visibly and to a screen
   * reader. label.ts is the single source of that name (MAI-42).
   */
  label: string
  players: FieldPlayer[]
  /** the holes this round will play, in play order — for the `holes` field */
  holes: readonly number[]
  draft: GameDraft
  /**
   * This game's own `validateSetup` problems — see SetupScreen's
   * `problemsByGame`. Stated on the card because the fold would otherwise hide
   * both the reason tee-off is blocked and the control that fixes it.
   */
  problems: string[]
  /** Whether the settings are showing. Owned by SetupScreen — see `collapsed`. */
  open: boolean
  onToggle: () => void
  onChange: (draft: GameDraft) => void
  onRemove: () => void
  onRules: () => void
}

/**
 * A chosen MAIN game: everything it can be configured with, open by default and
 * foldable away.
 *
 * Open by DEFAULT is the whole of MAI-89 — a card whose settings are behind a
 * tap reads as a card with no settings, and groups teed off on stakes they
 * never knew they could change. The fold is for afterwards: once a bet is set
 * up, it is a line you want out of the way of the rest of the screen.
 *
 * Collapsed it keeps its stake, and keeps any reason it cannot be played. It
 * loses the blurb, the fields and the rules link — one line, the same shape a
 * collapsed `SideBetRow` takes, because a fold that saves three lines out of
 * eight is not worth offering.
 */
export function GameConfigCard({
  engine,
  label,
  players,
  holes,
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
  /**
   * What is wrong with this game, said on the card — because the fix is a
   * control INSIDE it, and told only at the foot of the screen, "every player
   * must be on exactly one Nassau side" points at a Team A/B toggle the reader
   * cannot see and has no reason to look for.
   *
   * EVERY PROBLEM, PLUS THE ROSTER UNLESS ONE OF THEM ALREADY STATES IT. Three
   * rules were tried; each of the others omitted something, and omission is the
   * failure that matters here:
   *
   * - Roster note INSTEAD of the problems hid a duplicate-settings complaint
   *   behind a missing player. A duplicate is independent of the roster, so
   *   that is the "solve one problem to discover the next" wolf's
   *   `validateSetup` warns about, in prose, four lines above the bug.
   * - Problems, with the note only when they are SILENT, hid the roster behind
   *   any complaint that doesn't name it. Nassau at five players reports one
   *   unassigned player and nothing else — so the card sent the reader to
   *   assign them, the message cleared, and "Needs 2–4 players" appeared only
   *   then. Worse than redundant: no assignment makes a five-player Nassau
   *   playable, so the intermediate instruction was false.
   * - Both, always, said one fact in two sentences: "Wolf needs exactly 4
   *   players" over "Needs 4 players". Correct and unreadable.
   *
   * So the note is dropped only against a problem that PRINTS THE SAME NUMBER
   * (`statesPlayerCount`) — the engine's sentence is the better of the two,
   * because it names the game. A complaint about teams prints no count and
   * suppresses nothing, which is what keeps the Nassau case honest.
   *
   * The note is not decoration in the silent case either: `isPlayable` reads
   * `meta.minPlayers/maxPlayers` while Skins and CTP declare 2–8 and validate
   * only the lower bound, so a ninth player leaves the engine with nothing to
   * say about a game its own catalogue entry calls unplayable. That gap is the
   * engines'; until it closes the card is the only thing that mentions it,
   * which is why this says what is WRONG here rather than what is blocking
   * tee-off. The list beside the button speaks for the button.
   */
  const stranded = !isPlayable(engine, players.length)
  const wrong =
    stranded && !statesPlayerCount(engine, problems)
      ? [...problems, playerCountNote(engine)]
      : problems
  const stake = stakeSummary(engine, config)
  // scoped per instance: the screen renders several of these, and two panels
  // sharing an id would point every aria-controls at the same element
  const panelId = useId()

  return (
    // A named GROUP because every card on this screen now renders its fields at
    // once, so "Skin value", "Handicaps" and "Allowance" repeat down the page.
    // `gameName` keeps the CONTROLS apart (ConfigField); this is what gives the
    // card itself a boundary to navigate by.
    <div role="group" aria-label={label} className="pixel border-felt-500 bg-felt-900/60">
      {/* The bottom padding belongs to whatever follows the title, and when the
          card is folded and healthy nothing does — `pb-1` was sized for the
          blurb underneath and leaves the title clipped against the card edge. */}
      <div
        className={`flex items-start justify-between gap-3 px-4 pt-4 ${
          open || wrong.length > 0 ? 'pb-1' : 'pb-4'
        }`}
      >
        <button
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
          aria-expanded={open}
          // only while it exists: the panel is unmounted when closed, and
          // aria-controls pointing at nothing is an ARIA error
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
        >
          <span className="min-w-0 truncate text-lg font-bold">{label}</span>
          <span className="flex shrink-0 items-center gap-2">
            {!open && stake && <span className="tabular-nums text-stone-300">{stake}</span>}
            <DisclosureArrow open={open} />
          </span>
        </button>
        <button
          aria-label={`remove ${label}`}
          onClick={onRemove}
          className="flex size-7 shrink-0 items-center justify-center bg-stone-800 text-sm font-bold text-stone-400"
        >
          ✕
        </button>
      </div>

      {/* OUTSIDE the fold: what is wrong here is fixed by controls inside the
          card, so it must not be a thing you can hide by tidying the screen up.
          The deduped list by the Tee off button says what is blocking it; this
          says which card to open. */}
      {wrong.map((problem) => (
        <p key={problem} className="px-4 pb-3 text-sm text-flag-500">
          {problem}
        </p>
      ))}

      {open && (
        <div id={panelId}>
          <p className="px-4 pb-3 text-sm text-stone-400">{engine.meta.blurb}</p>
          <div className="space-y-4 border-t border-felt-800/60 px-4 py-4">
            {engine.configFields.map((field) => (
              <ConfigField
                key={field.key}
                field={field}
                value={config[field.key]}
                players={players}
                holes={holes}
                gameName={label}
                onChange={(v) => setConfigValue(field.key, v)}
              />
            ))}
            {/* Nothing at all when strokes cannot decide the game — not the
                control, and not a line explaining its absence either. See
                `meta.grossOnly`. */}
            {!engine.meta.grossOnly && (
              <HandicapControls
                handicap={draft.handicap}
                gameName={label}
                onChange={(handicap) => onChange({ ...draft, handicap })}
              />
            )}
            <button
              aria-label={`${label} rules`}
              onClick={onRules}
              className="font-display text-[10px] uppercase text-felt-400"
            >
              Rules ▶
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

import type { ConfigFieldSpec, GameEngine } from '../../engine/catalog'
import { formatCents } from '../../engine/core/money'
import { Stepper } from '../../components/Stepper'

export interface FieldPlayer {
  draftId: string
  name: string
}

/**
 * THE editor for a declarative config field — the one path both a main game's
 * full card and a side bet's expanded row render through.
 *
 * Deliberately one component rather than a full and a compact variant: the
 * catalog already has two renderers of these specs that drifted the moment they
 * existed (`configChips` names the field and drops false booleans;
 * `fieldPhrase` does neither — see the comment on label.ts's exhaustive
 * switch). A third and fourth would drift the same way the first time a field
 * kind is added.
 */
export function ConfigField({
  field,
  value,
  players,
  holes,
  gameName,
  onChange,
}: {
  field: ConfigFieldSpec
  value: unknown
  players: FieldPlayer[]
  /**
   * The holes this round will play, IN PLAY ORDER — `holesForRound`'s answer,
   * which is the same function the engine uses at tee-off, so the grid cannot
   * offer a hole the round won't walk. Only the `holes` field reads it.
   *
   * Always populated in practice: the wizard's games step comes after the
   * course and the range (`STEP`), so a field never renders before there is a
   * card to derive it from.
   */
  holes?: readonly number[]
  /**
   * `gameLabel` for the game this field belongs to. Two instances of one game
   * can sit in the same section — that is what this screen was rebuilt for —
   * and without it a screen reader hears two controls both called "increase
   * Skin value" with nothing to tell them apart.
   */
  gameName?: string
  onChange: (value: unknown) => void
}) {
  switch (field.kind) {
    case 'money': {
      const min = field.min ?? 25
      const max = field.max ?? 10_000
      // The fallback is defensive — `defaultConfig` always seeds this — but it
      // is CLAMPED into the field's own range rather than assuming $1, which
      // would sit outside the bounds of a field declaring max: 500.
      const current = typeof value === 'number' ? value : Math.min(Math.max(100, min), max)
      return (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{field.label}</p>
            {field.hint && <p className="text-xs text-stone-400">{field.hint}</p>}
          </div>
          <Stepper
            value={current}
            min={min}
            max={max}
            step={field.step ?? 25}
            label={gameName ? `${field.label} — ${gameName}` : field.label}
            onChange={(v) => onChange(v)}
            format={(v) => formatCents(v)}
          />
        </div>
      )
    }
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{field.label}</p>
            {field.hint && <p className="text-xs text-stone-400">{field.hint}</p>}
          </div>
          <button
            role="switch"
            aria-checked={!!value}
            aria-label={field.label}
            onClick={() => onChange(!value)}
            className={`h-8 w-14 shrink-0 rounded-full p-1 transition-colors ${value ? 'bg-felt-500' : 'bg-stone-700'}`}
          >
            <div
              className={`size-6 rounded-full bg-white transition-transform ${value ? 'translate-x-6' : ''}`}
            />
          </button>
        </div>
      )
    case 'select':
      return (
        <div>
          <p className="mb-2 font-medium">{field.label}</p>
          <div className="flex flex-wrap gap-2">
            {field.options.map((o) => (
              <button
                key={o.value}
                onClick={() => onChange(o.value)}
                className={`px-3.5 py-2 text-lg ${
                  value === o.value ? 'pixel border-felt-300 bg-felt-700' : 'border-2 border-stone-700 bg-stone-800'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )
    case 'holes': {
      // A preset's own `value`, or an explicit list of hole numbers. The two
      // are one field because the spec has no conditional visibility — see the
      // kind's note in catalog.ts.
      const picked = Array.isArray(value) ? (value as number[]) : []
      const custom = Array.isArray(value)
      const offered = holes ?? []
      const toggle = (hole: number) => {
        const next = picked.includes(hole)
          ? picked.filter((h) => h !== hole)
          : // KEEP PLAY ORDER, not tap order: the list is read back as prose
            // ("Holes 3, 8") and settled hole by hole, and a set that
            // remembered which chip was tapped first would read as a jumble.
            offered.filter((h) => picked.includes(h) || h === hole)
        onChange(next)
      }
      return (
        <div>
          <p className="mb-2 font-medium">{field.label}</p>
          {field.hint && <p className="mb-2 text-xs text-stone-400">{field.hint}</p>}
          <div className="flex flex-wrap gap-2">
            {field.presets.map((p) => (
              <button
                key={p.value}
                onClick={() => onChange(p.value)}
                className={`px-3.5 py-2 text-lg ${
                  value === p.value
                    ? 'pixel border-felt-300 bg-felt-700'
                    : 'border-2 border-stone-700 bg-stone-800'
                }`}
              >
                {p.label}
              </button>
            ))}
            <button
              // Entering custom mode with NOTHING selected, deliberately: a
              // preset silently expanded into the holes it happens to mean
              // would look like the group had chosen each of them, and the
              // empty state is what `validateSetup` refuses out loud.
              onClick={() => onChange(custom ? picked : [])}
              className={`px-3.5 py-2 text-lg ${
                custom
                  ? 'pixel border-felt-300 bg-felt-700'
                  : 'border-2 border-stone-700 bg-stone-800'
              }`}
            >
              {field.customLabel}
            </button>
          </div>
          {custom && (
            <div
              role="group"
              aria-label={gameName ? `${field.label} — ${gameName}` : field.label}
              className="mt-2.5 flex flex-wrap gap-1.5"
            >
              {offered.map((hole) => (
                <button
                  key={hole}
                  aria-pressed={picked.includes(hole)}
                  aria-label={`hole ${hole}`}
                  onClick={() => toggle(hole)}
                  className={`pixel-press size-11 text-lg ${
                    picked.includes(hole)
                      ? 'border-felt-500 bg-felt-900/60 text-felt-300'
                      : 'border-stone-600 bg-stone-800 text-stone-300'
                  }`}
                >
                  {hole}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    }
    case 'teams': {
      // 2v2 assignment: value = { a: [draftId, draftId], b: [draftId, draftId] }
      const teams = (value ?? { a: [], b: [] }) as { a: string[]; b: string[] }
      const idOf = (i: number) => players[i]!.draftId
      const teamOf = (i: number) => (teams.a.includes(idOf(i)) ? 'a' : teams.b.includes(idOf(i)) ? 'b' : null)
      return (
        <div>
          <p className="mb-2 font-medium">{field.label}</p>
          <div className="space-y-2">
            {players.map((p, i) => (
              <div key={p.draftId} className="flex items-center justify-between">
                <span>{p.name}</span>
                <div className="flex gap-1.5">
                  {(['a', 'b'] as const).map((team) => (
                    <button
                      key={team}
                      aria-label={`${p.name} to team ${team.toUpperCase()}`}
                      onClick={() => {
                        const next = {
                          a: teams.a.filter((id) => id !== idOf(i)),
                          b: teams.b.filter((id) => id !== idOf(i)),
                        }
                        next[team] = [...next[team], idOf(i)]
                        onChange(next)
                      }}
                      className={`px-3.5 py-1.5 text-lg font-bold ${
                        teamOf(i) === team
                          ? 'pixel border-felt-300 bg-felt-700'
                          : 'border-2 border-stone-700 bg-stone-800 text-stone-400'
                      }`}
                    >
                      {team.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )
    }
    case 'rotation': {
      // ordered player list: value = [draftId, ...] — defaults to entry order
      const order = (value ?? players.map((p) => p.draftId)) as string[]
      const nameOf = (id: string) => players.find((p) => p.draftId === id)?.name ?? id
      return (
        <div>
          <p className="mb-2 font-medium">{field.label}</p>
          <ul className="space-y-1.5">
            {order.map((id, pos) => (
              <li key={id} className="flex items-center justify-between rounded-lg bg-stone-800/60 px-3 py-2">
                <span>
                  <span className="mr-2 text-sm text-stone-500">{pos + 1}.</span>
                  {nameOf(id)}
                </span>
                <div className="flex gap-1">
                  <button
                    aria-label={`move ${nameOf(id)} up`}
                    disabled={pos === 0}
                    className="px-2 text-stone-400 disabled:opacity-30"
                    onClick={() => {
                      const next = [...order]
                      ;[next[pos - 1], next[pos]] = [next[pos]!, next[pos - 1]!]
                      onChange(next)
                    }}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`move ${nameOf(id)} down`}
                    disabled={pos === order.length - 1}
                    className="px-2 text-stone-400 disabled:opacity-30"
                    onClick={() => {
                      const next = [...order]
                      ;[next[pos], next[pos + 1]] = [next[pos + 1]!, next[pos]!]
                      onChange(next)
                    }}
                  >
                    ↓
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )
    }
  }
}

/**
 * The read-only stake shown on a FOLDED card, in either section — the one
 * number a bet is identified by in conversation ("the dollar skins").
 *
 * Display only. Every edit goes through `ConfigField`; this exists so a folded
 * card can say what it is in one line instead of saying nothing.
 */
export function stakeSummary(engine: GameEngine, config: Record<string, unknown>): string | undefined {
  const money = engine.configFields.find((f) => f.kind === 'money')
  if (!money) return undefined
  const value = config[money.key]
  return typeof value === 'number' ? formatCents(value) : undefined
}

/** "Needs 4 players" / "Needs 2–8 players" — shared by the picker and the chosen card. */
export function playerCountNote(engine: GameEngine): string {
  const { minPlayers, maxPlayers } = engine.meta
  return `Needs ${minPlayers}${maxPlayers > minPlayers ? `–${maxPlayers}` : ''} players`
}

/**
 * Whether one of the engine's own problems already prints a number this note
 * would print — i.e. whether saying it would be saying it twice.
 *
 * "Wolf needs exactly 4 players" above "Needs 4 players" is the case: same
 * fact, two sentences, and the engine's is the better one because it names the
 * game. But "every player must be on exactly one nassau side" is NOT that — it
 * is about the teams, mentions no count, and suppressing the roster line behind
 * it sent the reader off to assign a fifth player into a game that cannot hold
 * one. So the test is the NUMBER, not the word "player".
 *
 * Deliberately a check on the engine's rendered prose, because that is all
 * `validateSetup` returns. Reword a message to spell the count out ("exactly
 * four players") and this stops matching — which shows the note again beside a
 * sentence that means the same thing. That is the failure this was written to
 * remove, not a new one, and it is visible on the screen the moment it happens
 * rather than hiding anything. A `validateSetup` that returned TAGGED problems
 * would settle it properly; that is an engine-contract change.
 */
export function statesPlayerCount(engine: GameEngine, problems: readonly string[]): boolean {
  const { minPlayers, maxPlayers } = engine.meta
  const bounds = maxPlayers > minPlayers ? [minPlayers, maxPlayers] : [minPlayers]
  return problems.some((p) => bounds.some((n) => new RegExp(`\\b${n}\\b`).test(p)))
}

/** Whether this roster size can play this game at all. */
export function isPlayable(engine: GameEngine, playerCount: number): boolean {
  return playerCount >= engine.meta.minPlayers && playerCount <= engine.meta.maxPlayers
}

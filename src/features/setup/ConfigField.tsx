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
  gameName,
  onChange,
}: {
  field: ConfigFieldSpec
  value: unknown
  players: FieldPlayer[]
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

/** Whether this roster size can play this game at all. */
export function isPlayable(engine: GameEngine, playerCount: number): boolean {
  return playerCount >= engine.meta.minPlayers && playerCount <= engine.meta.maxPlayers
}

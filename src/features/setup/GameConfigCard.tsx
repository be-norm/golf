import type { ConfigFieldSpec, GameEngine } from '../../engine/catalog'
import type { HandicapSettings } from '../../engine/core/types'
import { formatCents } from '../../engine/core/money'
import { Stepper } from '../../components/Stepper'

export interface GameDraft {
  type: string
  handicap: HandicapSettings
  config: unknown
}

interface Props {
  engine: GameEngine
  playable: boolean
  players: { draftId: string; name: string }[]
  draft: GameDraft | undefined
  onToggle: () => void
  onChange: (draft: GameDraft) => void
  onRules: () => void
}

export function GameConfigCard({ engine, playable, players, draft, onToggle, onChange, onRules }: Props) {
  const config = (draft?.config ?? {}) as Record<string, unknown>

  const setConfigValue = (key: string, value: unknown) => {
    if (!draft) return
    onChange({ ...draft, config: { ...config, [key]: value } })
  }

  return (
    <div
      className={`pixel ${
        draft ? 'border-felt-500 bg-felt-900/60' : 'border-stone-700 bg-stone-900/70'
      } ${playable ? '' : 'opacity-40'}`}
    >
      <button
        className="flex w-full items-start justify-between gap-3 px-4 pb-1 pt-4 text-left"
        disabled={!playable}
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <span className="text-lg font-bold">{engine.meta.name}</span>
          <p className="text-sm text-stone-400">
            {playable
              ? engine.meta.blurb
              : `Needs ${engine.meta.minPlayers}${engine.meta.maxPlayers > engine.meta.minPlayers ? `–${engine.meta.maxPlayers}` : ''} players`}
          </p>
        </div>
        <div
          className={`flex size-7 shrink-0 items-center justify-center text-sm font-bold ${
            draft ? 'bg-felt-500 text-felt-950' : 'bg-stone-800 text-stone-500'
          }`}
        >
          {draft ? '✓' : '+'}
        </div>
      </button>
      <button
        aria-label={`${engine.meta.name} rules`}
        onClick={onRules}
        className="font-display px-4 pb-3 pt-1 text-[10px] uppercase text-felt-400"
      >
        Rules ▶
      </button>

      {draft && (
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

          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Handicaps</p>
              <p className="text-xs text-stone-400">
                {draft.handicap.mode === 'net' ? 'Net — strokes off the low player' : 'Gross — no strokes'}
              </p>
            </div>
            <button
              className={`px-4 py-2 text-lg ${
                draft.handicap.mode === 'net'
                  ? 'pixel border-felt-300 bg-felt-700'
                  : 'border-2 border-stone-700 bg-stone-800 text-stone-400'
              }`}
              onClick={() =>
                onChange({
                  ...draft,
                  handicap:
                    draft.handicap.mode === 'net'
                      ? { ...draft.handicap, mode: 'gross' }
                      : { mode: 'net', allowancePct: 100, reference: 'offLow' },
                })
              }
            >
              {draft.handicap.mode === 'net' ? 'Net' : 'Gross'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ConfigField({
  field,
  value,
  players,
  onChange,
}: {
  field: ConfigFieldSpec
  value: unknown
  players: { draftId: string; name: string }[]
  onChange: (value: unknown) => void
}) {
  switch (field.kind) {
    case 'money':
      return (
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{field.label}</p>
            {field.hint && <p className="text-xs text-stone-400">{field.hint}</p>}
          </div>
          <Stepper
            value={typeof value === 'number' ? value : 100}
            min={25}
            max={10000}
            onChange={(v) => onChange(v)}
            format={(v) => formatCents(v)}
          />
        </div>
      )
    case 'boolean':
      return (
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{field.label}</p>
            {field.hint && <p className="text-xs text-stone-400">{field.hint}</p>}
          </div>
          <button
            role="switch"
            aria-checked={!!value}
            onClick={() => onChange(!value)}
            className={`h-8 w-14 rounded-full p-1 transition-colors ${value ? 'bg-felt-500' : 'bg-stone-700'}`}
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
              <div key={p.name} className="flex items-center justify-between">
                <span>{p.name}</span>
                <div className="flex gap-1.5">
                  {(['a', 'b'] as const).map((team) => (
                    <button
                      key={team}
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

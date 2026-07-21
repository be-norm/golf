import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { playerRepo } from '../../db/repos'
import { LOCAL_USER } from '../../db/ids'
import type { Player } from '../../engine/core/types'
import { useAuth } from '../../auth/AuthProvider'
import { BigButton } from '../../components/BigButton'
import { selectOnFocus } from '../../components/inputs'
import { enqueueDeletePlayer, enqueuePushPlayer } from '../../remote/outbox'
import { PlayerSearch } from './PlayerSearch'
import { refreshGhinPlayer, type GhinPlayerHit } from '../../remote/ghinSearch'

const INPUT =
  'min-h-11 bg-stone-800 px-3 ring-1 ring-stone-700 text-stone-100 placeholder:text-stone-500 focus:outline-none focus:ring-felt-500'

export function PlayersScreen() {
  const { activeUserId, isGuest } = useAuth()
  const roster = useLiveQuery(() => playerRepo.list(activeUserId), [activeUserId])
  const [name, setName] = useState('')
  const [index, setIndex] = useState('')
  const [showGhin, setShowGhin] = useState(false)

  const signedIn = activeUserId !== LOCAL_USER
  const rosterGhins = new Set(
    (roster ?? []).map((p) => p.ghinNumber).filter((n): n is string => !!n),
  )

  const pushPlayer = async (id: string) => {
    if (!signedIn) return
    const p = await playerRepo.get(id)
    if (p) await enqueuePushPlayer(activeUserId, p)
  }

  const addFromGhin = async (hit: GhinPlayerHit) => {
    const p = await playerRepo.create(
      activeUserId,
      hit.fullName,
      hit.handicapIndex ?? undefined,
      hit.ghinNumber,
    )
    await pushPlayer(p.id)
  }

  const refreshFromGhin = async (player: Player): Promise<{ ok: boolean; message: string }> => {
    try {
      if (!player.ghinNumber) return { ok: false, message: 'no GHIN link' }
      const hit = await refreshGhinPlayer(player.ghinNumber)
      if (!hit) return { ok: false, message: 'not found on GHIN' }
      if (hit.handicapIndex == null) return { ok: true, message: `GHIN: ${hit.handicapDisplay}` }
      const prev = player.handicapIndex
      if (prev === hit.handicapIndex) return { ok: true, message: `up to date (${hit.handicapDisplay})` }
      await playerRepo.update(player.id, { handicapIndex: hit.handicapIndex })
      await pushPlayer(player.id)
      return { ok: true, message: `${prev ?? '—'} → ${hit.handicapDisplay}` }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'refresh failed' }
    }
  }

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const p = await playerRepo.create(activeUserId, trimmed, index === '' ? undefined : Number(index))
    setName('')
    setIndex('')
    await pushPlayer(p.id)
  }

  return (
    <main className="flex min-h-dvh flex-col gap-5 py-6">
      <header className="flex items-center justify-between pt-2">
        <Link to="/" className="text-stone-400">
          ⌂ Home
        </Link>
        <h1 className="font-display text-xs uppercase text-felt-300">Saved players</h1>
        <span className="w-12" />
      </header>

      {isGuest && (
        <p className="text-sm text-stone-500">
          Playing as a guest — these stay on this device until you sign in.
        </p>
      )}

      <div>
        <button
          onClick={() => setShowGhin((v) => !v)}
          className="font-display text-[10px] uppercase text-felt-400"
        >
          {showGhin ? '× Close GHIN lookup' : '🔍 Look up on GHIN'}
        </button>
        {showGhin && (
          <div className="mt-2">
            <PlayerSearch onPick={(hit) => void addFromGhin(hit)} addedGhins={rosterGhins} />
          </div>
        )}
      </div>

      <form onSubmit={add} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Player name"
          autoCapitalize="words"
          className={`${INPUT} min-h-12 flex-1`}
        />
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          min={-10}
          max={54}
          value={index}
          onChange={(e) => setIndex(e.target.value)}
          onFocus={selectOnFocus}
          aria-label="handicap index"
          placeholder="Idx"
          className={`${INPUT} min-h-12 w-20 text-center`}
        />
        <BigButton type="submit" variant="outline" className="min-h-12" disabled={!name.trim()}>
          Add
        </BigButton>
      </form>

      <ul className="space-y-2">
        {roster?.map((player) => (
          <PlayerRow
            key={player.id}
            player={player}
            canRefresh={signedIn && !!player.ghinNumber}
            onRefresh={() => refreshFromGhin(player)}
            onSave={async (patch) => {
              await playerRepo.update(player.id, patch)
              await pushPlayer(player.id)
            }}
            onDelete={async () => {
              await playerRepo.delete(player.id)
              if (signedIn) await enqueueDeletePlayer(activeUserId, player.id)
            }}
          />
        ))}
      </ul>
      {roster && roster.length === 0 && (
        <p className="text-sm text-stone-500">No saved players yet. Add one above.</p>
      )}
    </main>
  )
}

function PlayerRow({
  player,
  canRefresh,
  onRefresh,
  onSave,
  onDelete,
}: {
  player: Player
  canRefresh: boolean
  onRefresh: () => Promise<{ ok: boolean; message: string }>
  onSave: (patch: { name: string; handicapIndex?: number }) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(player.name)
  const [index, setIndex] = useState(player.handicapIndex?.toString() ?? '')
  const [confirming, setConfirming] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<{ ok: boolean; message: string }>()
  const clearMsg = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(clearMsg.current), [])

  const doRefresh = async () => {
    setRefreshing(true)
    setRefreshResult(undefined)
    const result = await onRefresh()
    setRefreshing(false)
    setRefreshResult(result)
    clearTimeout(clearMsg.current)
    clearMsg.current = setTimeout(() => setRefreshResult(undefined), 5000)
  }

  if (editing) {
    return (
      <li className="pixel border-stone-700 bg-stone-900/70 p-3">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${INPUT} flex-1`}
            autoCapitalize="words"
          />
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min={-10}
            max={54}
            value={index}
            onChange={(e) => setIndex(e.target.value)}
            onFocus={selectOnFocus}
            aria-label={`${player.name} handicap index`}
            className={`${INPUT} w-20 text-center`}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <BigButton
            variant="ghost"
            className="min-h-10 flex-1"
            onClick={() => {
              setName(player.name)
              setIndex(player.handicapIndex?.toString() ?? '')
              setEditing(false)
            }}
          >
            Cancel
          </BigButton>
          <BigButton
            className="min-h-10 flex-1"
            disabled={!name.trim()}
            onClick={() => {
              void onSave({
                name: name.trim(),
                handicapIndex: index === '' ? undefined : Number(index),
              }).then(() => setEditing(false))
            }}
          >
            Save
          </BigButton>
        </div>
      </li>
    )
  }

  return (
    <li className="pixel border-stone-700 bg-stone-900/70 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="min-w-0 truncate text-lg font-medium">
          {player.name}
          {player.ghinNumber && (
            <span className="font-display ml-2 text-[9px] uppercase text-stone-500">GHIN</span>
          )}
        </span>
        <div className="flex items-center gap-3">
          <span className="font-display text-[10px] text-felt-300">
            {player.handicapIndex ?? '—'}
          </span>
          {confirming ? (
            <span className="flex items-center gap-2 text-sm">
              <button className="text-flag-500" onClick={() => void onDelete()}>
                Delete
              </button>
              <button className="text-stone-400" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              {canRefresh && (
                <button
                  aria-label={`refresh ${player.name} handicap from GHIN`}
                  className="text-felt-400 disabled:opacity-50"
                  disabled={refreshing}
                  onClick={() => void doRefresh()}
                >
                  {refreshing ? '…' : '↻'}
                </button>
              )}
              <button
                aria-label={`edit ${player.name}`}
                className="text-stone-400"
                onClick={() => setEditing(true)}
              >
                ✎
              </button>
              <button
                aria-label={`delete ${player.name}`}
                className="text-stone-500"
                onClick={() => setConfirming(true)}
              >
                ✕
              </button>
            </>
          )}
        </div>
      </div>
      {refreshResult && (
        <p className={`mt-1 text-right text-xs ${refreshResult.ok ? 'text-felt-400' : 'text-flag-500'}`}>
          {refreshResult.message}
        </p>
      )}
    </li>
  )
}

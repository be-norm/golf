import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { searchGhinPlayers, type GhinPlayerHit } from '../../remote/ghinSearch'

interface Props {
  /** called when a golfer is picked from the results */
  onPick: (hit: GhinPlayerHit) => void
  /** GHIN numbers already added — shown as added, not re-pickable */
  addedGhins?: ReadonlySet<string>
  placeholder?: string
}

const INPUT =
  'min-h-12 border-2 border-stone-700 bg-stone-900 px-4 text-lg placeholder:text-stone-500 focus:border-felt-500 focus:outline-none'

/**
 * GHIN golfer lookup: type a last name (optionally "First Last" + a state to
 * narrow), pick a golfer, and the caller gets their name + Handicap Index.
 * Signed-in + online only — the proxy is gated to authenticated users.
 */
export function PlayerSearch({ onPick, addedGhins, placeholder }: Props) {
  const { isGuest } = useAuth()
  const [query, setQuery] = useState('')
  const [state, setState] = useState('')
  const [hits, setHits] = useState<GhinPlayerHit[]>()
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string>()
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined)
  const requestSeq = useRef(0)

  useEffect(() => () => clearTimeout(debounce.current), [])

  const schedule = (q: string, st: string) => {
    clearTimeout(debounce.current)
    setError(undefined)
    if (q.trim().length < 2) {
      setHits(undefined)
      setSearching(false)
      return
    }
    debounce.current = setTimeout(() => {
      const seq = ++requestSeq.current
      setSearching(true)
      searchGhinPlayers(q, st)
        .then((results) => {
          if (seq !== requestSeq.current) return // superseded by a newer query
          setHits(results)
          setSearching(false)
        })
        .catch((e: unknown) => {
          if (seq !== requestSeq.current) return
          setHits([])
          setSearching(false)
          setError(e instanceof Error ? e.message : 'GHIN search failed')
        })
    }, 350)
  }

  if (isGuest) {
    return (
      <p className="text-sm text-stone-500">
        Sign in to look up players &amp; handicaps from GHIN.
      </p>
    )
  }

  const pick = (hit: GhinPlayerHit) => {
    onPick(hit)
    setQuery('')
    setState('')
    setHits(undefined)
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            schedule(e.target.value, state)
          }}
          placeholder={placeholder ?? 'Last name (or “First Last”)…'}
          autoCapitalize="words"
          className={`${INPUT} min-w-0 flex-1`}
        />
        <input
          value={state}
          onChange={(e) => {
            const v = e.target.value.toUpperCase().slice(0, 2)
            setState(v)
            schedule(query, v)
          }}
          placeholder="ST"
          aria-label="state (optional)"
          maxLength={2}
          className={`${INPUT} w-16 text-center uppercase`}
        />
      </div>

      {hits !== undefined && (
        <div className="mt-2">
          <h3 className="font-display mb-2 text-[10px] uppercase text-stone-400">
            {searching ? 'Searching GHIN…' : `Results (${hits.length})`}
          </h3>
          {error && <p className="mb-2 text-lg text-flag-500">{error}</p>}
          <ul className="space-y-2">
            {hits.map((h) => {
              const added = addedGhins?.has(h.ghinNumber)
              return (
                <li key={h.ghinNumber}>
                  <button
                    disabled={added}
                    onClick={() => pick(h)}
                    className="pixel flex w-full items-center justify-between border-stone-700 bg-stone-900/70 px-4 py-3 text-left disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate">
                      <span className="text-lg font-semibold">{h.fullName}</span>
                      {(h.clubName || h.state) && (
                        <span className="ml-2 text-sm text-stone-400">
                          {[h.clubName, h.state].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    <span className="ml-2 flex shrink-0 items-center gap-2">
                      <span className="font-display text-[11px] text-felt-300">
                        {h.handicapDisplay}
                      </span>
                      <span className="text-lg text-felt-400">{added ? 'added ✓' : '+ add'}</span>
                    </span>
                  </button>
                </li>
              )
            })}
            {!searching && hits.length === 0 && !error && (
              <p className="text-lg text-stone-500">No golfers found — check spelling or add a state.</p>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

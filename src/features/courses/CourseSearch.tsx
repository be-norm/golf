import { useRef, useState } from 'react'
import type { Course } from '../../engine/core/types'
import {
  importCourseHit,
  searchCourses,
  type CourseSearchHit,
} from '../../remote/courseSearch'

interface Props {
  /** ids already in the local library — shown as saved, not re-importable */
  localIds: ReadonlySet<string>
  /** called after a hit is fetched + cached locally */
  onImported?: (course: Course) => void
  placeholder?: string
}

/**
 * Course search over the shared library + OpenGolfAPI live index (online
 * only, both best-effort). Picking a hit caches the full scorecard into
 * the local library for offline use.
 */
export function CourseSearch({ localIds, onImported, placeholder }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<CourseSearchHit[]>()
  const [searching, setSearching] = useState(false)
  const [importing, setImporting] = useState<string>()
  const [error, setError] = useState<string>()
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined)

  const onQueryChange = (value: string) => {
    setQuery(value)
    clearTimeout(debounce.current)
    if (value.trim().length < 3) {
      setHits(undefined)
      setSearching(false)
      return
    }
    debounce.current = setTimeout(() => {
      setSearching(true)
      void searchCourses(value).then((results) => {
        setHits(results)
        setSearching(false)
      })
    }, 350)
  }

  const pick = async (hit: CourseSearchHit) => {
    setImporting(hit.id)
    setError(undefined)
    try {
      const course = await importCourseHit(hit)
      setQuery('')
      setHits(undefined)
      onImported?.(course)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'import failed')
    } finally {
      setImporting(undefined)
    }
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={placeholder ?? 'Search courses (online)…'}
        className="min-h-12 w-full border-2 border-stone-700 bg-stone-900 px-4 text-lg placeholder:text-stone-500 focus:border-felt-500 focus:outline-none"
      />

      {hits !== undefined && (
        <div className="mt-2">
          <h3 className="font-display mb-2 text-[10px] uppercase text-stone-400">
            {searching ? 'Searching…' : `Results (${hits.length})`}
          </h3>
          {error && <p className="mb-2 text-lg text-flag-500">{error}</p>}
          <ul className="space-y-2">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  disabled={importing === h.id || localIds.has(h.id)}
                  onClick={() => void pick(h)}
                  className="pixel flex w-full items-center justify-between border-stone-700 bg-stone-900/70 px-4 py-3 text-left disabled:opacity-50"
                >
                  <span className="min-w-0 truncate">
                    <span className="text-lg font-semibold">{h.name}</span>
                    {h.location && <span className="ml-2 text-stone-400">{h.location}</span>}
                  </span>
                  <span className="ml-2 shrink-0 text-lg text-felt-400">
                    {localIds.has(h.id) ? 'saved ✓' : importing === h.id ? '…' : '+ add'}
                  </span>
                </button>
              </li>
            ))}
            {!searching && hits.length === 0 && (
              <p className="text-lg text-stone-500">Nothing found — add it manually below.</p>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { courseRepo } from '../../db/repos'
import {
  importCourseHit,
  searchCourses,
  type CourseSearchHit,
} from '../../remote/courseSearch'

export function CourseListScreen() {
  const navigate = useNavigate()
  const courses = useLiveQuery(() => courseRepo.list())
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

  const localIds = new Set(courses?.map((c) => c.id))

  const pick = async (hit: CourseSearchHit) => {
    setImporting(hit.id)
    setError(undefined)
    try {
      await importCourseHit(hit)
      setQuery('')
      setHits(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'import failed')
    } finally {
      setImporting(undefined)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-4 py-6">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-stone-400">
          ← Home
        </Link>
        <h1 className="font-bold">Courses</h1>
        <span className="w-12" />
      </header>

      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search courses (online)…"
        className="min-h-12 w-full rounded-xl bg-stone-900 px-4 ring-1 ring-stone-700 placeholder:text-stone-500 focus:outline-none focus:ring-felt-500"
      />

      {hits !== undefined && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-stone-400">
            {searching ? 'Searching…' : `Results (${hits.length})`}
          </h2>
          {error && <p className="mb-2 text-sm text-flag-500">{error}</p>}
          <ul className="space-y-2">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  disabled={importing === h.id || localIds.has(h.id)}
                  onClick={() => void pick(h)}
                  className="flex w-full items-center justify-between rounded-2xl bg-stone-900/60 px-4 py-3 text-left ring-1 ring-stone-800 active:bg-stone-800/60 disabled:opacity-50"
                >
                  <span>
                    <span className="font-semibold">{h.name}</span>
                    {h.location && <span className="ml-2 text-sm text-stone-400">{h.location}</span>}
                  </span>
                  <span className="text-sm text-felt-400">
                    {localIds.has(h.id) ? 'saved ✓' : importing === h.id ? '…' : '+ add'}
                  </span>
                </button>
              </li>
            ))}
            {!searching && hits.length === 0 && (
              <p className="text-sm text-stone-500">
                Nothing found — you can{' '}
                <Link to="/courses/new" className="text-felt-400">
                  add it manually
                </Link>
                .
              </p>
            )}
          </ul>
        </section>
      )}

      <Link
        to="/courses/new"
        className="block rounded-2xl bg-felt-900/60 px-4 py-4 text-center font-semibold ring-1 ring-felt-700 active:bg-felt-800/60"
      >
        + New course
      </Link>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-stone-400">
          My library
        </h2>
        <ul className="space-y-2">
          {courses?.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => navigate(`/courses/${c.id}/edit`)}
                className="block w-full rounded-2xl bg-stone-900/60 px-4 py-3 text-left ring-1 ring-stone-800 active:bg-stone-800/60"
              >
                <span className="font-semibold">{c.name}</span>
                <span className="ml-2 text-sm text-stone-400">
                  {c.holeCount} holes{c.location ? ` · ${c.location}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-auto pb-2 text-center text-xs text-stone-600">
        Course search includes data from{' '}
        <a href="https://opengolfapi.org" className="underline">
          OpenGolfAPI
        </a>
        , available under{' '}
        <a href="https://opendatacommons.org/licenses/odbl/1-0/" className="underline">
          ODbL
        </a>
        .
      </footer>
    </main>
  )
}

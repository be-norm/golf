import { useEffect, useId, useRef, useState } from 'react'
import type { Course } from '../../engine/core/types'
import {
  importCourseHit,
  searchCourses,
  versionIds,
  type CourseGroup,
  type CourseVersion,
} from '../../remote/courseSearch'
import { courseRepo } from '../../db/repos'
import { useAuth } from '../../auth/AuthProvider'
import { CourseSourceMark } from '../../components/CourseSourceMark'
import { formatDate } from '../../lib/date'

interface Props {
  /** ids already in the local library */
  localIds: ReadonlySet<string>
  /**
   * What picking a version is FOR. On the courses screen you are stocking a
   * library, so a card already in it is done — "saved ✓", nothing to do. On
   * setup you are choosing where you're about to play, so every version is
   * actionable: an unsaved one is fetched first, a saved one is simply chosen.
   */
  intent?: 'add' | 'play'
  /** the picked course, fetched if it wasn't already local */
  onPicked?: (course: Course) => void
  placeholder?: string
}

/** When this version was last corrected. Only a community card carries one; an
 *  unusable stamp was already dropped at the query boundary (`toLibraryHit`),
 *  so there is nothing to re-guard here. */
function updatedOn(v: CourseVersion): string | undefined {
  return v.kind === 'community' && v.updatedAt ? formatDate(v.updatedAt) : undefined
}

/** What a version row reads out. The button's own label supersedes the source
 *  mark's, so it has to restate the kind and the date — and it names the
 *  VERSION, not the group, because that is the card being picked. */
function versionLabel(
  v: CourseVersion,
  saved: boolean,
  on: string | undefined,
  intent: 'add' | 'play',
): string {
  const kind = v.kind === 'api' ? 'directory version' : v.mine ? 'your version' : 'community version'
  const dated = on ? `, updated ${on}` : ''
  const what = `${v.name} — ${kind}${dated}`
  if (intent === 'play') {
    return saved ? `Play ${v.name} — ${kind}, your saved copy` : `Play ${what}`
  }
  return saved ? `${what}, already in your library` : `Add ${what}`
}

/** The name+town line, shared by both row shapes so they can't drift apart. */
function ResultLine({ name, location }: { name: string; location: string }) {
  return (
    <span className="min-w-0 flex-1 truncate">
      <span className="text-lg font-semibold">{name}</span>
      {location && <span className="ml-2 text-stone-400">{location}</span>}
    </span>
  )
}

const ROW = 'pixel border-stone-700 bg-stone-900/70'

/**
 * Course search over the shared library + both live course APIs (online only,
 * all best-effort). Picking a version caches its full scorecard into the local
 * library for offline use.
 *
 * ONE row per place (MAI-79). A course that exists several times over — the
 * directory's card plus every golfer's correction of it — is one result whose
 * versions open on tap, so choosing a course is a decision rather than a
 * comparison of near-identical lines. A place with a single version keeps the
 * old one-tap add; making everyone confirm a choice they don't have would tax
 * every ordinary search to serve the rare duplicate.
 */
export function CourseSearch({ localIds, intent = 'add', onPicked, placeholder }: Props) {
  const { activeUserId } = useAuth()
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<CourseGroup[]>()
  const [searching, setSearching] = useState(false)
  const [expanded, setExpanded] = useState<string>()
  const [importing, setImporting] = useState<string>()
  const [error, setError] = useState<string>()
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined)
  const requestSeq = useRef(0)
  // scoped per instance: setup renders a CourseSearch too, and two panels
  // sharing an id would point every aria-controls at the same element
  const panelBase = useId()

  // abandoned searches must not fire network requests or setState after unmount
  useEffect(() => () => clearTimeout(debounce.current), [])

  const onQueryChange = (value: string) => {
    setQuery(value)
    setExpanded(undefined)
    clearTimeout(debounce.current)
    if (value.trim().length < 3) {
      // bump the sequence, don't just clear: clearTimeout cancels nothing once
      // the debounce has already fired, and an in-flight search would resolve
      // afterwards and repaint a full result list under a two-character query
      requestSeq.current++
      setGroups(undefined)
      setSearching(false)
      // the message now lives outside the results block, so it no longer
      // disappears with them — it has to be cleared on its own
      setError(undefined)
      return
    }
    debounce.current = setTimeout(() => {
      const seq = ++requestSeq.current
      setSearching(true)
      setError(undefined)
      const current = () => seq === requestSeq.current // else a newer query won
      void searchCourses(value, activeUserId)
        .then((results) => {
          if (!current()) return
          setGroups(results)
          setExpanded(undefined)
          setSearching(false)
        })
        // searchCourses swallows each source's failure, but grouping runs after
        // them — without a catch a throw there leaves "Searching…" up forever
        .catch(() => {
          if (!current()) return
          setGroups(undefined)
          setExpanded(undefined)
          setSearching(false)
          setError('search failed')
        })
    }, 350)
  }

  // A version can already be in the library under a folded-away id, so the
  // check is over all of them, and it's derived once per row rather than by
  // each of the things that need it.
  const savedAs = (v: CourseVersion) => versionIds(v).find((id) => localIds.has(id))

  const pick = async (version: CourseVersion) => {
    setImporting(version.id)
    setError(undefined)
    try {
      // Already local? Take the cached card. Re-importing would spend a network
      // round trip to arrive at the copy we're holding — and on setup, where a
      // saved course is still perfectly playable, that trip is the whole cost
      // of choosing it. A CourseVersion IS a CourseSearchHit, so the import
      // path needs nothing unwrapped.
      const local = savedAs(version)
      const course = local
        ? await courseRepo.get(local)
        : await importCourseHit(activeUserId, version)
      if (!course) throw new Error('course not found')
      // both halves matter: the bump discards a search already in flight, and
      // the clear kills one still queued behind the debounce. Without the
      // clear, typing then picking repaints a full result list 350 ms later,
      // underneath a search box the pick just emptied.
      requestSeq.current++
      clearTimeout(debounce.current)
      setQuery('')
      setGroups(undefined)
      setExpanded(undefined)
      setSearching(false)
      onPicked?.(course)
    } catch (e) {
      // keep the results and the open panel: the point of showing versions is
      // that another one can be tried when the first fails to fetch
      setError(e instanceof Error ? e.message : 'import failed')
    } finally {
      setImporting(undefined)
    }
  }

  const rowState = (v: CourseVersion) => {
    const here = savedAs(v) !== undefined
    // Stocking a library, a card already in it is finished business. Choosing
    // where to play, it is the most likely pick on the screen.
    const done = here && intent === 'add'
    return {
      here,
      // every pick is disabled while ANY import is in flight: two overlapping
      // picks share one `importing` slot, so the first to settle would
      // re-enable the second's row mid-flight and fire onPicked twice
      disabled: importing !== undefined || done,
      action: done ? 'saved ✓' : importing === v.id ? '…' : intent === 'play' ? '▶ play' : '+ add',
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

      {/* outside the results block: a search that fails has no results to sit
          under, and the message is the only thing left to show */}
      {error && <p className="mt-2 text-lg text-flag-500">{error}</p>}

      {groups !== undefined && (
        <div className="mt-2">
          <h3 className="font-display mb-2 text-[10px] uppercase text-stone-400">
            {searching ? 'Searching…' : `Results (${groups.length})`}
          </h3>
          <ul className="space-y-2">
            {groups.map((g) => {
              const only = g.versions.length === 1 ? g.versions[0] : undefined

              if (only) {
                const state = rowState(only)
                return (
                  <li key={g.key}>
                    <button
                      disabled={state.disabled}
                      onClick={() => void pick(only)}
                      className={`${ROW} flex w-full items-center justify-between px-4 py-3 text-left disabled:opacity-50`}
                    >
                      <ResultLine name={g.name} location={g.location} />
                      <CourseSourceMark source={only.source} mine={only.mine} />
                      <span className="ml-2 shrink-0 text-lg text-felt-400">{state.action}</span>
                    </button>
                  </li>
                )
              }

              const open = expanded === g.key
              const panelId = `${panelBase}-${g.key}`
              // without this a course already in your library reads only
              // "2 versions", and you add a SECOND version of it — the
              // duplicate problem, rebuilt inside your own library
              const savedHere = g.versions.some((v) => savedAs(v) !== undefined)

              return (
                <li key={g.key} className={ROW}>
                  {/* two lines, unlike the single-version row: the count and
                      the saved mark on one line with the name left the town
                      four characters of room ("Indi…") on a phone */}
                  <button
                    aria-expanded={open}
                    // only while it exists: the panel is unmounted when closed,
                    // and aria-controls pointing at nothing is an ARIA error
                    aria-controls={open ? panelId : undefined}
                    onClick={() => setExpanded(open ? undefined : g.key)}
                    className="flex w-full flex-col gap-1 px-4 py-3 text-left"
                  >
                    <ResultLine name={g.name} location={g.location} />
                    {/* no source mark here — a group spans both kinds, and a
                        mark on the header would claim one it hasn't committed to.
                        The arrow is ↓/↑ because Press Start 2P has no ▾/▸: they
                        fall back to a glyph that renders as an invisible speck. */}
                    <span className="font-display flex w-full items-center gap-3 text-[10px] uppercase text-felt-400">
                      <span>
                        {g.versions.length} versions{' '}
                        {/* decorative: aria-expanded already states this */}
                        <span aria-hidden="true">{open ? '↑' : '↓'}</span>
                      </span>
                      {savedHere && <span className="text-felt-300">saved ✓</span>}
                    </span>
                  </button>
                  {open && (
                    <ul id={panelId} className="border-t border-felt-800/60">
                      {g.versions.map((v) => {
                        const state = rowState(v)
                        // A card we already hold is served from the cache, so
                        // the directory's "last corrected" date describes a
                        // scorecard we are NOT about to hand over. Say which
                        // one you're getting instead of quoting a date for
                        // something else.
                        const on = state.here ? undefined : updatedOn(v)
                        return (
                        <li key={v.id}>
                          <button
                            disabled={state.disabled}
                            onClick={() => void pick(v)}
                            aria-label={versionLabel(v, state.here, on, intent)}
                            className="flex w-full items-center justify-between px-4 py-2.5 text-left disabled:opacity-50"
                          >
                            <span className="min-w-0 truncate">
                              <CourseSourceMark source={v.source} mine={v.mine} />
                              {on && (
                                <span className="font-display ml-2 text-[9px] uppercase text-stone-500">
                                  · {on}
                                </span>
                              )}
                              {state.here && (
                                <span className="font-display ml-2 text-[9px] uppercase text-stone-500">
                                  · in your library
                                </span>
                              )}
                              {/* over-merge insurance: the group key ignores
                                  punctuation and case, so a version that isn't
                                  literally the group's label says its own name */}
                              {v.name !== g.name && (
                                <span className="ml-2 truncate text-stone-400">{v.name}</span>
                              )}
                            </span>
                            <span className="ml-2 shrink-0 text-lg text-felt-400">
                              {state.action}
                            </span>
                          </button>
                        </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
            {!searching && groups.length === 0 && (
              <p className="text-lg text-stone-500">Nothing found — add it manually below.</p>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

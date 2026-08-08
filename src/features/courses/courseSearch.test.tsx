import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Course } from '../../engine/core/types'
import type { CourseGroup, CourseVersion } from '../../remote/courseSearch'

/**
 * The search RESULTS surface, which had no coverage at all before MAI-79 — the
 * ranking is pinned purely in courseSearch.test.ts, so this file is about what
 * a golfer actually sees and taps: one row per place, versions on demand.
 *
 * The remote module is mocked whole (no supabase client, no fetch, no env) and
 * the fixtures are the CourseGroups grouping would have produced.
 */
const searchMock = vi.hoisted(() => vi.fn())
const importMock = vi.hoisted(() => vi.fn())
vi.mock('../../remote/courseSearch', () => ({
  searchCourses: searchMock,
  importCourseHit: importMock,
  // pure one-liner, mirrored rather than imported (importOriginal would pull in
  // the supabase client); the real one is pinned in courseSearch.test.ts
  versionIds: (v: CourseVersion) => [v.id, ...v.aliasIds],
}))
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ activeUserId: 'me-uid' }) }))
// only `get` is reached from here — picking a card already in the library
const getMock = vi.hoisted(() => vi.fn())
vi.mock('../../db/repos', () => ({ courseRepo: { get: getMock } }))

import { CourseSearch } from './CourseSearch'

const version = (
  id: string,
  kind: CourseVersion['kind'],
  extra: Partial<CourseVersion> = {},
): CourseVersion => ({
  id,
  name: 'Broadmoor Country Club',
  location: 'Indianapolis, IN',
  origin: kind === 'api' ? 'golfcourseapi' : 'library',
  source: kind === 'api' ? undefined : 'user',
  kind,
  mine: false,
  aliasIds: [],
  ...extra,
})

/** midday UTC so the rendered day is the same in every timezone */
const MINE = version('v-mine', 'community', {
  mine: true,
  createdBy: 'me-uid',
  updatedAt: '2026-07-12T12:00:00.000Z',
})
const THEIRS = version('v-theirs', 'community', {
  createdBy: 'ann',
  updatedAt: '2026-06-03T12:00:00.000Z',
})
const API = version('gca:9', 'api')

const broadmoor: CourseGroup = {
  key: 'broadmoorcountryclub|indianapolisin',
  name: 'Broadmoor Country Club',
  location: 'Indianapolis, IN',
  versions: [MINE, THEIRS, API],
}

const ranchoOnly: CourseVersion = {
  id: 'og-7',
  name: 'Rancho Park GC',
  location: 'Los Angeles, CA',
  origin: 'opengolfapi',
  kind: 'api',
  mine: false,
  aliasIds: [],
}
const rancho: CourseGroup = {
  key: 'ranchoparkgc|losangelesca',
  name: 'Rancho Park GC',
  location: 'Los Angeles, CA',
  versions: [ranchoOnly],
}

const imported = { id: 'v-theirs', name: 'Broadmoor Country Club' } as Course
/** the cached card `courseRepo.get` hands back for an already-saved version */
const localCourse = { id: 'og-7', name: 'Rancho Park GC' } as Course

function search(groups: CourseGroup[], localIds: string[] = [], onPicked?: (c: Course) => void) {
  searchMock.mockResolvedValue(groups)
  render(<CourseSearch localIds={new Set(localIds)} onPicked={onPicked} />)
  // one change event, not per-keystroke typing — the 350 ms debounce then runs once
  fireEvent.change(screen.getByPlaceholderText('Search courses (online)…'), {
    target: { value: 'broadmoor' },
  })
}

const header = (name: RegExp) => screen.findByRole('button', { name })

beforeEach(() => {
  searchMock.mockReset()
  importMock.mockReset()
  getMock.mockReset()
  importMock.mockResolvedValue(imported)
  getMock.mockResolvedValue(localCourse)
})

describe('CourseSearch — one row per place (MAI-79)', () => {
  it('collapses a course with three versions into a single result row', async () => {
    search([broadmoor])

    expect(await screen.findByText('Results (1)')).toBeInTheDocument()
    const row = await header(/Broadmoor Country Club/)
    expect(row).toHaveTextContent('3 versions')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    // nothing is offered for import until the golfer opens the result
    expect(screen.queryByText('✎ yours')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /directory version/ })).not.toBeInTheDocument()
  })

  it('passes the viewer to the search so ranking knows whose version is whose', async () => {
    search([broadmoor])
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith('broadmoor', 'me-uid'))
  })

  it('reveals the versions on tap, each marked and dated', async () => {
    search([broadmoor])
    const row = await header(/Broadmoor Country Club/)
    await userEvent.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    const panel = document.getElementById(row.getAttribute('aria-controls')!)
    expect(panel).toBeInTheDocument()

    // API vs COMMUNITY, and which one is mine — in words, not colour alone
    expect(screen.getByText('✎ yours')).toBeInTheDocument()
    expect(screen.getByText('✎ community')).toBeInTheDocument()
    expect(screen.getByText('⛳ api')).toBeInTheDocument()

    // community versions say when they were last corrected; the API row doesn't
    expect(screen.getByText('· 12 Jul 2026')).toBeInTheDocument()
    expect(screen.getByText('· 3 Jun 2026')).toBeInTheDocument()
    expect(screen.getAllByText(/^· /)).toHaveLength(2)
  })

  it('imports the version the golfer chose, not the top-ranked one', async () => {
    const onPicked = vi.fn()
    search([broadmoor], [], onPicked)
    await userEvent.click(await header(/Broadmoor Country Club/))
    await userEvent.click(screen.getByRole('button', { name: /community version, updated 3 Jun 2026/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledWith('me-uid', THEIRS))
    expect(onPicked).toHaveBeenCalledWith(imported)
  })

  it('adds a single-version result on the first tap, with no disclosure', async () => {
    search([rancho])
    const row = await header(/Rancho Park GC/)
    expect(row).not.toHaveAttribute('aria-expanded')
    expect(row).toHaveTextContent('+ add')

    await userEvent.click(row)
    await waitFor(() => expect(importMock).toHaveBeenCalledWith('me-uid', ranchoOnly))
  })

  it('says a version is already saved — on the version AND on the collapsed row', async () => {
    // without the collapsed signal you re-add a DIFFERENT version of a course
    // you already have, rebuilding the duplicate problem in your own library
    search([broadmoor], ['v-mine'])
    const row = await header(/Broadmoor Country Club/)
    expect(row).toHaveTextContent('saved ✓')

    await userEvent.click(row)
    const saved = screen.getByRole('button', { name: /already in your library/ })
    expect(saved).toBeDisabled()
    expect(saved).toHaveTextContent('saved ✓')
  })

  it('recognises a copy saved under a folded-away id, instead of offering a second one', async () => {
    // the card was imported from OpenGolfAPI, so it sits in the library under
    // og-2; GolfCourseAPI won the fold, so the offered id is gca:1
    const folded: CourseGroup = {
      key: 'penmargolfcourse|veniceca',
      name: 'Penmar Golf Course',
      location: 'Venice, CA',
      versions: [
        { ...version('gca:1', 'api'), name: 'Penmar Golf Course', aliasIds: ['og-2'] },
      ],
    }
    search([folded], ['og-2'])

    const row = await header(/Penmar Golf Course/)
    expect(row).toHaveTextContent('saved ✓')
    expect(row).toBeDisabled()
  })

  it('disables every add while one is in flight, so two picks cannot overlap', async () => {
    // one `importing` slot is shared: the first to settle would re-enable the
    // second's row mid-flight and fire onImported twice
    let release: (c: Course) => void = () => {}
    importMock.mockReturnValue(new Promise<Course>((r) => (release = r)))
    search([broadmoor])
    await userEvent.click(await header(/Broadmoor Country Club/))
    await userEvent.click(screen.getByRole('button', { name: /your version/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /directory version/ })).toBeDisabled(),
    )
    release(imported)
  })

  it('does not repaint stale results under a query cut below the search minimum', async () => {
    // clearTimeout cancels nothing once the debounce has fired; without a
    // sequence bump the in-flight search lands on an abandoned query
    let release: (g: CourseGroup[]) => void = () => {}
    searchMock.mockReturnValue(new Promise<CourseGroup[]>((r) => (release = r)))
    render(<CourseSearch localIds={new Set()} />)
    const input = screen.getByPlaceholderText('Search courses (online)…')
    fireEvent.change(input, { target: { value: 'broadmoor' } })
    await waitFor(() => expect(searchMock).toHaveBeenCalled())

    fireEvent.change(input, { target: { value: 'br' } })
    release([broadmoor])

    await waitFor(() => expect(screen.queryByText(/Results/)).not.toBeInTheDocument())
    expect(screen.queryByText(/Broadmoor/)).not.toBeInTheDocument()
  })

  it('says "play", not "add", when the search is for choosing where to play', async () => {
    searchMock.mockResolvedValue([rancho])
    render(<CourseSearch localIds={new Set()} intent="play" />)
    fireEvent.change(screen.getByPlaceholderText('Search courses (online)…'), {
      target: { value: 'rancho' },
    })

    const row = await header(/Rancho Park GC/)
    expect(row).toHaveTextContent('▶ play')
    expect(row).not.toHaveTextContent('add')
  })

  it('keeps a course you already have playable, without a second fetch', async () => {
    // "saved ✓" is the end of the story when you're stocking a library. When
    // you're picking where to play it is the likeliest choice on the screen —
    // greying it out would send you hunting for the course you already own.
    const onPicked = vi.fn()
    searchMock.mockResolvedValue([rancho])
    render(<CourseSearch localIds={new Set(['og-7'])} intent="play" onPicked={onPicked} />)
    fireEvent.change(screen.getByPlaceholderText('Search courses (online)…'), {
      target: { value: 'rancho' },
    })

    const row = await header(/Rancho Park GC/)
    expect(row).toHaveTextContent('▶ play')
    expect(row).toBeEnabled()

    await userEvent.click(row)
    await waitFor(() => expect(onPicked).toHaveBeenCalledWith(localCourse))
    expect(importMock).not.toHaveBeenCalled() // the card was already here
  })

  it('still finishes at "saved ✓" when the search is for stocking the library', async () => {
    search([rancho], ['og-7'])
    const row = await header(/Rancho Park GC/)
    expect(row).toHaveTextContent('saved ✓')
    expect(row).toBeDisabled()
  })

  it('clears a failure banner when the query drops below the search minimum', async () => {
    // the message moved outside the results block so a failed search has
    // somewhere to render — which also means it no longer vanishes with them
    searchMock.mockRejectedValue(new Error('boom'))
    render(<CourseSearch localIds={new Set()} />)
    const input = screen.getByPlaceholderText('Search courses (online)…')
    fireEvent.change(input, { target: { value: 'broadmoor' } })
    expect(await screen.findByText('search failed')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'br' } })
    await waitFor(() => expect(screen.queryByText('search failed')).not.toBeInTheDocument())
  })

  it('cancels a search still queued behind the debounce when a version is picked', async () => {
    // the pick empties the search box; a timer armed a moment earlier would
    // otherwise fire and repaint a full result list under an empty input
    search([rancho])
    const row = await header(/Rancho Park GC/)
    // arm a fresh debounce, then pick before it fires
    fireEvent.change(screen.getByPlaceholderText('Search courses (online)…'), {
      target: { value: 'rancho p' },
    })
    await userEvent.click(row)
    await waitFor(() => expect(importMock).toHaveBeenCalled())

    searchMock.mockClear()
    await new Promise((r) => setTimeout(r, 500)) // past the 350 ms debounce
    expect(searchMock).not.toHaveBeenCalled()
    expect(screen.queryByText(/Results/)).not.toBeInTheDocument()
  })

  it('surfaces a failed search instead of spinning on "Searching…" forever', async () => {
    searchMock.mockRejectedValue(new Error('boom'))
    render(<CourseSearch localIds={new Set()} />)
    fireEvent.change(screen.getByPlaceholderText('Search courses (online)…'), {
      target: { value: 'broadmoor' },
    })

    expect(await screen.findByText('search failed')).toBeInTheDocument()
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument()
  })

  it('keeps the versions open when one fails to fetch, so another can be tried', async () => {
    importMock.mockRejectedValue(new Error('course fetch failed'))
    search([broadmoor])
    await userEvent.click(await header(/Broadmoor Country Club/))
    await userEvent.click(screen.getByRole('button', { name: /directory version/ }))

    expect(await screen.findByText('course fetch failed')).toBeInTheDocument()
    expect(screen.getByText('✎ yours')).toBeInTheDocument()
  })
})

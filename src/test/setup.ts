import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

/**
 * jsdom keeps one `localStorage` per file, so a display preference written by
 * one test is still set for the next one. Demonstrated, not theoretical: delete
 * this and two of MAI-104's own pinned-bar tests fail, because a test that
 * folds the bar leaves it folded for whatever renders next.
 *
 * The wider trap is the one to keep in mind — a folded bar hides exactly the
 * row MAI-50's `Side bets` assertions look for, in the same file. Today's
 * source order spares them; a reordering would not.
 *
 * Global rather than in one describe, so it is disarmed for whoever adds the
 * next preference rather than only for the test that found it.
 */
afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    // a jsdom build without storage has nothing to clear
  }
})

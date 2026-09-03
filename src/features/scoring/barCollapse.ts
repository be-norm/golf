/**
 * Whether the scoring screen's pinned bar is folded down to one row.
 *
 * A DISPLAY PREFERENCE, not round data — which is why it lives here and not in
 * the event log or on the `Round` row. Either of those would sync one viewer's
 * choice of how much bar they want into an archive every device reads back, and
 * the log is for what happened in the golf (CLAUDE.md invariant #2).
 *
 * Device-wide rather than per-round for the same reason: a group that wants the
 * room wants it on every round they play on that phone, and a per-round key
 * would ask them again each Saturday.
 *
 * GUARDED, unlike `InstallHint`'s bare read. This runs during the scoring
 * screen's first render, so a browser with storage blocked (Safari private
 * browsing, a locked-down enterprise profile) would take down the one screen a
 * round cannot proceed without. Failing to expanded is the safe direction:
 * nothing is hidden, and the fold is one tap away again.
 */
const KEY = 'golf-bar-collapsed'

export function readBarCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function writeBarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // A preference that cannot be remembered is still a preference that works
    // for this round; there is nothing to tell the user about.
  }
}

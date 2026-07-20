export interface SummaryPart {
  /** small gold metadata chip, e.g. "H4"; empty string renders value-only */
  label: string
  value: string
}

/**
 * THE pinned-bar convention every stroke-decided game follows: the bar recaps
 * the LATEST decided hole — what just happened — as a gold hole-chip + value.
 * The full accounting lives in the standings sheet, never the bar.
 *
 * `recap(hole)` returns a one-line recap for a decided hole, or null if that
 * hole isn't decided yet (pending / not finalized); `empty` shows before any
 * hole decides. Games walk their own `holeResults`; this centralizes the
 * "find the most recent decided hole and chip it" logic so every game — and
 * every future game — reads identically.
 *
 * (Match-play games like Nassau are the deliberate exception: their bar shows
 * live bet status, because the stakes are the running match, not a single hole.)
 */
export function latestHoleSummary(
  holesPlayed: readonly number[],
  recap: (hole: number) => string | null,
  empty = 'no results yet',
): SummaryPart[] {
  for (let i = holesPlayed.length - 1; i >= 0; i--) {
    const hole = holesPlayed[i]!
    const value = recap(hole)
    if (value !== null) return [{ label: `H${hole}`, value }]
  }
  return [{ label: '', value: empty }]
}

/** Render summary parts to the plain fallback string (GameSummary styles the parts). */
export function summaryString(parts: SummaryPart[]): string {
  return parts.map((p) => (p.label ? `${p.label}: ${p.value}` : p.value)).join(' · ')
}

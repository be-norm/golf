const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The app's one date shape: `18 Jul 2026`.
 *
 * Fixed format rather than toLocaleDateString — deterministic across locales
 * and in tests. Shared so the share card and the course-version list can't
 * drift into two different-looking dates.
 */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

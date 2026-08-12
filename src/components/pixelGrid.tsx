import type { ReactElement } from 'react'

/**
 * A CHARACTER GRID TO RECTS, merged in both directions — greedily: widen, then
 * deepen while the whole span still matches.
 *
 * One emitter for every drawing in the app. Row runs alone were what each of
 * them started with and it is not enough at any size: flat fields get re-stated
 * once per row, and a sprite is mounted as DOM nodes that a phone has to hold.
 * The output is identical pixels either way — this is purely how many nodes the
 * browser is asked for.
 *
 * A character with no entry in the legend is transparent, which is how a
 * silhouette leaves its background alone.
 */
export function mergedRects(
  grid: readonly (readonly string[])[],
  legend: Readonly<Record<string, string>>,
  key: string,
): ReactElement {
  const h = grid.length
  const w = grid[0]?.length ?? 0
  const taken = Array.from({ length: h }, () => Array<boolean>(w).fill(false))
  const out: ReactElement[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (taken[y]![x]) continue
      const ch = grid[y]![x]!
      const paint = legend[ch]
      if (paint === undefined) {
        taken[y]![x] = true
        continue
      }
      let rw = 1
      while (x + rw < w && !taken[y]![x + rw] && grid[y]![x + rw] === ch) rw += 1
      // Deepening does NOT re-check `taken`, and cannot need to: rows are
      // consumed top to bottom, so a cell below this run can only have been
      // claimed by a rectangle that also covered this one — in which case we
      // would have skipped it. Widening does need the check, because a run
      // earlier in this row may already have grown down past us.
      let rh = 1
      grow: while (y + rh < h) {
        for (let i = 0; i < rw; i++) if (grid[y + rh]![x + i] !== ch) break grow
        rh += 1
      }
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) taken[y + j]![x + i] = true
      out.push(<rect key={`${key}-${y}-${x}`} x={x} y={y} width={rw} height={rh} fill={paint} />)
    }
  }
  return <>{out}</>
}

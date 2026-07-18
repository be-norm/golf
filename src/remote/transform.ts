import { rankStrokeIndexes } from '../engine/core/handicap'
import type { Course, HoleCore, TeeSet } from '../engine/core/types'

export interface RawHole {
  number: number
  par: number
  handicapIndex: number | null | undefined
}

export interface RawTee {
  name: string
  color?: string | null
  rating?: number | null
  slope?: number | null
  yardages?: (number | undefined)[]
}

/**
 * Normalize messy source scorecards into our invariant-holding shape:
 * holes renumbered 1..N in source order, stroke indexes repaired into a
 * dense permutation (rank by claimed index, stable by position).
 */
export function normalizeHoles(raw: RawHole[]): HoleCore[] {
  const ordered = [...raw].sort((a, b) => a.number - b.number)
  const claimed = ordered.map((h, i) => h.handicapIndex ?? 100 + i)
  const ranks = rankStrokeIndexes(claimed)
  return ordered.map((h, i) => ({
    number: i + 1,
    par: h.par >= 3 && h.par <= 6 ? h.par : 4,
    strokeIndex: ranks[i]!,
  }))
}

/**
 * Build a Course document from external data. Missing ratings fall back to
 * neutral values (rating = par, slope = 113 → course handicap ≈ index),
 * clearly editable in the course editor.
 */
export function buildRemoteCourse(input: {
  id: string
  name: string
  city?: string | null
  state?: string | null
  holes: RawHole[]
  tees?: RawTee[]
}): Course {
  const holes = normalizeHoles(input.holes)
  const par = holes.reduce((a, h) => a + h.par, 0)
  const teeSets: TeeSet[] =
    input.tees && input.tees.length > 0
      ? input.tees.map((t, i) => ({
          id: `tee-${i}-${t.name.toLowerCase().replace(/\W+/g, '-')}`,
          name: t.name,
          color: t.color ?? undefined,
          rating: t.rating ?? par,
          slope: t.slope ?? 113,
          yardages: t.yardages?.every((y) => y !== undefined)
            ? (t.yardages as number[])
            : undefined,
        }))
      : [{ id: 'tee-standard', name: 'Standard', rating: par, slope: 113 }]

  return {
    id: input.id,
    name: input.name,
    location: [input.city, input.state].filter(Boolean).join(', ') || undefined,
    holeCount: holes.length as 9 | 18,
    holes,
    teeSets,
    source: 'remote',
    updatedAt: new Date().toISOString(),
    revision: 1,
  }
}

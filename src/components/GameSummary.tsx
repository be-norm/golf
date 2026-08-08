import type { GameDerivation } from '../engine/catalog'

export interface SummaryPart {
  label: string
  value: string
}

/**
 * The pinned bar's one-line status form: segment labels (F9 / B9 / 18, or a
 * hole number) as small gold metadata chips, results as values.
 *
 * Split from `GameSummary` because the bar also renders a line that belongs to
 * no single game — the collapsed side-bets aggregate — and that must not have
 * to fake a `GameDerivation` to be drawn the same way (MAI-50).
 */
export function SummaryParts({ parts }: { parts: readonly SummaryPart[] }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
          {part.label && (
            <span className="font-display text-[9px] uppercase text-coin-400">{part.label}</span>
          )}
          <span className="text-lg tabular-nums text-stone-200">{part.value}</span>
        </span>
      ))}
    </span>
  )
}

/**
 * Renders a game's one-line status with typographic hierarchy.
 * Falls back to the plain summary string for games without parts.
 */
export function GameSummary({ derivation }: { derivation: GameDerivation }) {
  if (!derivation.summaryParts?.length) {
    return <span className="text-lg text-stone-300">{derivation.summary}</span>
  }
  return <SummaryParts parts={derivation.summaryParts} />
}

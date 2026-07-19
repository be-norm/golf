import type { GameDerivation } from '../engine/catalog'

/**
 * Renders a game's one-line status with typographic hierarchy: segment
 * labels (F9 / B9 / 18) as small gold metadata chips, results as values.
 * Falls back to the plain summary string for games without parts.
 */
export function GameSummary({ derivation }: { derivation: GameDerivation }) {
  if (!derivation.summaryParts?.length) {
    return <span className="text-lg text-stone-300">{derivation.summary}</span>
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      {derivation.summaryParts.map((part, i) => (
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

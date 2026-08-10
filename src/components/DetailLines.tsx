import { formatCentsSigned } from '../engine/core/money'

interface Line {
  label: string
  value: string
  depth?: number
  /** what this line did to the player its text names — green up, red down */
  amountCents?: number
}

/**
 * The gold-chip status ledger (bet-by-bet lines with indented children) —
 * one renderer for the standings sheet and the settle screen.
 */
export function DetailLines({ lines, valueClass = 'text-stone-200' }: { lines: Line[]; valueClass?: string }) {
  if (lines.length === 0) return null
  return (
    <ul className="space-y-1.5">
      {lines.map((line, i) => (
        <li
          key={i}
          className={`flex items-baseline justify-between gap-2 ${line.depth ? 'pl-4' : ''}`}
        >
          {/* BOUNDED, for the same reason the painter bounds it: this label
              held Nassau's F9/B9/18 until the grouped side-bets panel started
              putting a game NAME here. Left unbounded it squeezes the money
              value or pushes the row past the panel edge on a phone. */}
          <span className="font-display max-w-[45%] shrink-0 truncate text-[9px] uppercase text-coin-400">
            {line.label}
          </span>
          <span className={`text-lg tabular-nums ${valueClass}`}>
            {line.value}
            {line.amountCents !== undefined && (
              <span className={line.amountCents > 0 ? 'text-felt-300' : 'text-flag-500'}>
                {' '}
                ({formatCentsSigned(line.amountCents)})
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

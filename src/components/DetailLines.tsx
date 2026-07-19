interface Line {
  label: string
  value: string
  depth?: number
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
          <span className="font-display shrink-0 text-[9px] uppercase text-coin-400">
            {line.label}
          </span>
          <span className={`text-lg tabular-nums ${valueClass}`}>{line.value}</span>
        </li>
      ))}
    </ul>
  )
}

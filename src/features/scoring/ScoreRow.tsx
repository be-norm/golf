import { motion } from 'motion/react'

interface ScoreRowProps {
  name: string
  par: number
  gross: number | undefined
  /** handicap strokes received on this hole (primary game) — shown as dots */
  strokes: number
  onScore: (gross: number) => void
}

/**
 * The default-to-par chip: tap once to confirm par; ± adjusts and commits
 * immediately (the event log absorbs corrections). ~4–6 taps per hole for four.
 */
export function ScoreRow({ name, par, gross, strokes, onScore }: ScoreRowProps) {
  const shown = gross ?? par
  const diff = gross !== undefined ? gross - par : 0

  return (
    <div className="flex items-center justify-between rounded-2xl bg-stone-900/70 py-2.5 pl-4 pr-2.5 ring-1 ring-stone-800">
      <div className="min-w-0">
        <p className="truncate text-lg font-semibold">{name}</p>
        {strokes !== 0 && (
          <p className="text-xs tracking-widest text-felt-400" aria-label={`${strokes} strokes`}>
            {strokes > 0 ? '●'.repeat(strokes) : `+${-strokes}`}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <TapButton label={`${name} minus`} onClick={() => onScore(Math.max(1, shown - 1))}>
          −
        </TapButton>
        <motion.button
          aria-label={`${name} score`}
          onClick={() => gross === undefined && onScore(par)}
          whileTap={{ scale: 0.94 }}
          className={`flex h-14 w-16 flex-col items-center justify-center rounded-2xl text-2xl font-extrabold tabular-nums ring-1 transition-colors ${
            gross === undefined
              ? 'bg-stone-800/50 text-stone-500 ring-stone-700'
              : diff < 0
                ? 'bg-felt-700 text-white ring-felt-500'
                : diff === 0
                  ? 'bg-stone-700 text-white ring-stone-500'
                  : 'bg-stone-800 text-amber-200 ring-amber-700/50'
          }`}
        >
          {shown}
          <span className="text-[10px] font-medium leading-none opacity-70">
            {gross === undefined ? 'par?' : diffLabel(diff)}
          </span>
        </motion.button>
        <TapButton label={`${name} plus`} onClick={() => onScore(shown + 1)}>
          +
        </TapButton>
      </div>
    </div>
  )
}

function TapButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: string
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="flex size-12 select-none items-center justify-center rounded-xl bg-stone-800 text-2xl font-bold text-stone-300 active:bg-stone-700"
    >
      {children}
    </button>
  )
}

function diffLabel(diff: number): string {
  if (diff <= -3) return 'albatross'
  if (diff === -2) return 'eagle'
  if (diff === -1) return 'birdie'
  if (diff === 0) return 'par'
  if (diff === 1) return 'bogey'
  if (diff === 2) return 'double'
  return `+${diff}`
}

import { motion } from 'motion/react'

interface ScoreRowProps {
  name: string
  par: number
  gross: number | undefined
  /** handicap strokes received on this hole (primary game) — shown as dots */
  strokes: number
  onScore: (gross: number) => void
  /**
   * Putts on this hole, when the round is counting them (MAI-90). `undefined`
   * is "not recorded" and 0 is a chip-in — the two are different everywhere,
   * including here, where one reads "putts?" and the other reads "0".
   * Omitting `onPutts` is what turns the affordance off entirely.
   */
  putts?: number
  onPutts?: (putts: number) => void
}

/**
 * The default-to-par chip: tap once to confirm par; ± adjusts and commits
 * immediately (the event log absorbs corrections). ~4–6 taps per hole for four.
 */
export function ScoreRow({
  name,
  par,
  gross,
  strokes,
  onScore,
  putts,
  onPutts,
}: ScoreRowProps) {
  const shown = gross ?? par
  const diff = gross !== undefined ? gross - par : 0

  return (
    <div className="pixel flex items-center justify-between border-stone-700 bg-stone-900/80 py-2.5 pl-4 pr-2.5">
      <div className="min-w-0">
        <p className="truncate text-xl font-semibold">{name}</p>
        {strokes !== 0 && (
          <p className="text-sm tracking-widest text-felt-300" aria-label={`${strokes} strokes`}>
            {strokes > 0 ? '■'.repeat(strokes) : `+${-strokes}`}
          </p>
        )}
        {/* Under the name rather than beside the score: putts are a second,
            optional fact about the hole, and the stroke is what the group is
            actually calling out. Two small taps — the count steps up and wraps,
            because a putt count is a small number and a −/+ pair here would
            crowd the row it hangs off. */}
        {onPutts && (
          <button
            onClick={() => onPutts(((putts ?? 0) + 1) % 6)}
            aria-label={`${name} putts`}
            className={`pixel-press font-display mt-1.5 px-2 py-1 text-[10px] uppercase ${
              putts === undefined
                ? 'border-stone-700 bg-stone-900 text-stone-500'
                : 'border-felt-600 bg-felt-900/60 text-felt-300'
            }`}
          >
            {putts === undefined ? 'putts?' : `${putts} putts`}
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <TapButton label={`${name} minus`} onClick={() => onScore(Math.max(1, shown - 1))}>
          −
        </TapButton>
        <motion.button
          aria-label={`${name} score`}
          onClick={() => gross === undefined && onScore(par)}
          whileTap={{ scale: 0.92 }}
          transition={{ duration: 0.05 }}
          className={`font-display flex h-14 w-16 flex-col items-center justify-center gap-1 border-2 text-xl ${
            gross === undefined
              ? 'border-dashed border-stone-600 bg-stone-800/40 text-stone-500'
              : diff < 0
                ? 'pixel border-felt-300 bg-felt-600 text-white'
                : diff === 0
                  ? 'pixel border-stone-400 bg-stone-700 text-white'
                  : 'pixel border-coin-500 bg-stone-800 text-coin-400'
          }`}
        >
          {shown}
          <span className="font-body text-xs leading-none opacity-80">
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
      className="pixel-press flex size-12 select-none items-center justify-center border-stone-600 bg-stone-800 text-2xl font-bold text-stone-200"
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

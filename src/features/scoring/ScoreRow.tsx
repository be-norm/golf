import { motion } from 'motion/react'

interface ScoreRowProps {
  /**
   * Whose row this is — the anchor a celebration flies to (`CelebrationLayer`
   * finds it by `data-player-row`). Presentation only; the row itself never
   * reads it.
   */
  playerId: string
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
  /**
   * A DIRECTION, not a number. The row renders the derived count, which lags a
   * tap by a database round trip, so a value computed here would step from a
   * stale one — three quick taps for a three-putt would all send "1". The
   * screen resolves the current count against what it last sent instead.
   */
  onPutts?: (step: 'more' | 'fewer') => void
}

/** What the schema accepts. A six-putt is a real, memorable disaster and has to
 *  be recordable as one; the old control wrapped at 5 straight to "chip-in". */
export const MAX_PUTTS = 10

/**
 * The default-to-par chip: tap once to confirm par; ± adjusts and commits
 * immediately (the event log absorbs corrections). ~4–6 taps per hole for four.
 */
export function ScoreRow({
  playerId,
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
    <div
      data-player-row={playerId}
      className="pixel flex items-center justify-between border-stone-700 bg-stone-900/80 py-2.5 pl-4 pr-2.5"
    >
      <div className="min-w-0">
        <p className="truncate text-xl font-semibold">{name}</p>
        {strokes !== 0 && (
          <p className="text-sm tracking-widest text-felt-300" aria-label={`${strokes} strokes`}>
            {strokes > 0 ? '■'.repeat(strokes) : `+${-strokes}`}
          </p>
        )}
        {/* Under the name rather than beside the score: putts are a second,
            optional fact, and the stroke is what the group calls out.
            A STEPPER, NOT A CYCLE. Cycling looked cheaper and was wrong twice
            over: a tap lost to a stale render silently became the WRONG number
            rather than a smaller one, and wrapping past the top landed on 0 —
            which does not mean "I mis-tapped", it means chip-in, and Dots pays
            for one. Stepping down off 0 is the way back to not-recorded. */}
        {onPutts && (
          <div className="mt-1.5 flex items-center gap-1">
            <PuttButton
              label={`${name} fewer putts`}
              disabled={putts === undefined}
              onClick={() => onPutts('fewer')}
            >
              −
            </PuttButton>
            <span
              aria-label={`${name} putts`}
              className={`font-display min-w-20 text-center text-[10px] uppercase ${
                putts === undefined ? 'text-stone-500' : 'text-felt-300'
              }`}
            >
              {putts === undefined ? 'putts?' : `${putts} putts`}
            </span>
            <PuttButton
              label={`${name} more putts`}
              disabled={putts !== undefined && putts >= MAX_PUTTS}
              onClick={() => onPutts('more')}
            >
              +
            </PuttButton>
          </div>
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

/** Smaller than the score's ±: putts are the secondary fact on the row, and the
 *  stroke chip must stay the biggest target on it. */
function PuttButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="pixel-press flex size-8 select-none items-center justify-center border-stone-600 bg-stone-800 text-lg font-bold text-stone-300 disabled:opacity-30"
    >
      {children}
    </button>
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

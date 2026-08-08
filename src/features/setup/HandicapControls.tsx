import type { HandicapSettings } from '../../engine/core/types'
import { Stepper } from '../../components/Stepper'

/**
 * Net/gross and the allowance — shared by a main game's card and a side bet's
 * expanded row, for the same reason `ConfigField` is: two copies would drift.
 *
 * A side bet's handicap policy is its own. Skins played gross under a net
 * Nassau is an ordinary round, and `gameLabel`'s first discriminator exists
 * precisely to tell those two apart.
 */
export function HandicapControls({
  handicap,
  onChange,
}: {
  handicap: HandicapSettings
  onChange: (handicap: HandicapSettings) => void
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">Handicaps</p>
          <p className="text-xs text-stone-400">
            {handicap.mode === 'net' ? 'Net — strokes off the low player' : 'Gross — no strokes'}
          </p>
        </div>
        <button
          className={`shrink-0 px-4 py-2 text-lg ${
            handicap.mode === 'net'
              ? 'pixel border-felt-300 bg-felt-700'
              : 'border-2 border-stone-700 bg-stone-800 text-stone-400'
          }`}
          onClick={() =>
            onChange(
              handicap.mode === 'net'
                ? { ...handicap, mode: 'gross' }
                : { mode: 'net', allowancePct: 100, reference: 'offLow' },
            )
          }
        >
          {handicap.mode === 'net' ? 'Net' : 'Gross'}
        </button>
      </div>

      {handicap.mode === 'net' && (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">Allowance</p>
            <p className="text-xs text-stone-400">% of course handicap given</p>
          </div>
          <Stepper
            value={handicap.allowancePct}
            min={50}
            max={100}
            step={5}
            onChange={(v) => onChange({ ...handicap, allowancePct: v })}
            format={(v) => `${v}%`}
          />
        </div>
      )}
    </>
  )
}

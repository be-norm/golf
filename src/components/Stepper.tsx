interface StepperProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  /** increment per tap (default 1) */
  step?: number
  format?: (value: number) => string
}

export function Stepper({ value, onChange, min, max, step = 1, format }: StepperProps) {
  const dec = () => onChange(min !== undefined ? Math.max(min, value - step) : value - step)
  const inc = () => onChange(max !== undefined ? Math.min(max, value + step) : value + step)
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="decrease"
        onClick={dec}
        className="pixel-press flex size-11 select-none items-center justify-center border-stone-600 bg-stone-800 text-xl font-bold text-stone-200"
      >
        −
      </button>
      <span className="min-w-12 text-center text-xl tabular-nums">
        {format ? format(value) : value}
      </span>
      <button
        type="button"
        aria-label="increase"
        onClick={inc}
        className="pixel-press flex size-11 select-none items-center justify-center border-stone-600 bg-stone-800 text-xl font-bold text-stone-200"
      >
        +
      </button>
    </div>
  )
}

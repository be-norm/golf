interface StepperProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  format?: (value: number) => string
}

export function Stepper({ value, onChange, min, max, format }: StepperProps) {
  const dec = () => onChange(min !== undefined ? Math.max(min, value - 1) : value - 1)
  const inc = () => onChange(max !== undefined ? Math.min(max, value + 1) : value + 1)
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="decrease"
        onClick={dec}
        className="flex size-11 select-none items-center justify-center rounded-xl bg-stone-800 text-xl font-bold text-stone-300 active:bg-stone-700"
      >
        −
      </button>
      <span className="min-w-12 text-center text-lg font-semibold tabular-nums">
        {format ? format(value) : value}
      </span>
      <button
        type="button"
        aria-label="increase"
        onClick={inc}
        className="flex size-11 select-none items-center justify-center rounded-xl bg-stone-800 text-xl font-bold text-stone-300 active:bg-stone-700"
      >
        +
      </button>
    </div>
  )
}

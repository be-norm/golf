import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'

const variantClasses: Record<Variant, string> = {
  primary: 'bg-felt-600 text-white active:bg-felt-500 shadow-lg shadow-felt-950/40',
  ghost: 'bg-transparent text-stone-300 active:bg-stone-800/60',
  outline: 'bg-felt-900/40 text-stone-100 ring-1 ring-felt-700 active:bg-felt-800/60',
  danger: 'bg-flag-600 text-white active:bg-flag-500',
}

export function BigButton({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`min-h-14 select-none rounded-2xl px-5 text-lg font-semibold transition-transform active:scale-[0.98] disabled:opacity-40 ${variantClasses[variant]} ${className}`}
      {...props}
    />
  )
}

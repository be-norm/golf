import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'

const variantClasses: Record<Variant, string> = {
  primary: 'pixel-press bg-felt-600 text-white border-felt-300',
  ghost: 'bg-transparent text-stone-300 active:bg-stone-800/60',
  outline: 'pixel-press bg-felt-900/60 text-stone-100 border-felt-600',
  danger: 'pixel-press bg-flag-600 text-white border-flag-500',
}

export function BigButton({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`font-display min-h-14 select-none px-5 text-xs uppercase disabled:opacity-40 ${variantClasses[variant]} ${className}`}
      {...props}
    />
  )
}

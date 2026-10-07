import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

const variants = {
  primary:
    'bg-accent text-on-accent hover:bg-accent-hover shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(0_0_0/0.18)]',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-hover shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
  ghost: 'text-ink-2 hover:text-ink hover:bg-hover',
  danger: 'bg-bad text-white hover:brightness-110 shadow-[0_1px_2px_rgb(0_0_0/0.18)]',
  'danger-ghost': 'text-bad-ink hover:bg-bad-soft',
} as const

const sizes = {
  sm: 'h-8 px-2.5 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-xl',
  icon: 'h-8 w-8 rounded-lg justify-center',
  'icon-sm': 'h-7 w-7 rounded-md justify-center',
} as const

export type ButtonProps = ComponentProps<'button'> & {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 select-none items-center font-medium whitespace-nowrap transition-[background-color,color,box-shadow,filter] duration-150',
        'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
}

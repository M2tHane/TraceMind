import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import clsx from 'clsx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon'
export type ButtonSize = 'md' | 'sm'

/** Class string for links and labels that must look like buttons. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return clsx('tm-btn', variant !== 'secondary' && `tm-btn-${variant}`, size === 'sm' && variant !== 'icon' && 'tm-btn-sm', className)
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; busy?: boolean }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, variant = 'primary', size = 'md', busy = false, className, disabled, type = 'button', ...props }, ref,
) {
  return <button ref={ref} type={type} {...props} disabled={disabled || busy} aria-busy={busy || undefined} className={buttonClass(variant, size, className)}>
    {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{children}
  </button>
})

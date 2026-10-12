import { useRef } from 'react'
import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from './Button'

/**
 * Right-hand drawer over the content area (below the 56px top bar when the page provides a
 * `data-drawer-host` element). Radix traps focus, closes on Esc / overlay click and restores focus
 * to whatever opened it.
 */
export function Drawer({ open, onOpenChange, title, leading, position, onPrev, onNext, footer, children, width = 520, label }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  leading?: ReactNode
  position?: string
  onPrev?: () => void
  onNext?: () => void
  footer?: ReactNode
  children: ReactNode
  width?: number
  label?: string
}) {
  // Radix returns focus only to a Dialog.Trigger; this drawer is opened from table rows, so remember the opener here.
  const opener = useRef<HTMLElement | null>(null)
  const host = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('[data-drawer-host]')
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal container={host ?? undefined}>
      <Dialog.Overlay className="tm-drawer-overlay" />
      <Dialog.Content className="tm-drawer" style={{ width }} aria-describedby={undefined}
        onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
        onCloseAutoFocus={event => { const target = opener.current; opener.current = null; if (target?.isConnected && target !== document.body) { event.preventDefault(); target.focus() } }}
        onEscapeKeyDown={event => { if (document.querySelector('.tm-pop, .select-content')) event.preventDefault() }}>
        <div className="tm-drawer-head">
          {leading}
          <Dialog.Title asChild><h2 aria-label={label}>{title}</h2></Dialog.Title>
          {position && <span className="tm-faint tm-num text-xs">{position}</span>}
          {onPrev && <Button variant="icon" aria-label="上一项" onClick={onPrev}><ChevronUp size={15} /></Button>}
          {onNext && <Button variant="icon" aria-label="下一项" onClick={onNext}><ChevronDown size={15} /></Button>}
          <Dialog.Close asChild><Button variant="icon" aria-label="关闭"><X size={15} /></Button></Dialog.Close>
        </div>
        <div className="tm-drawer-body">{children}</div>
        {footer && <div className="tm-drawer-foot">{footer}</div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

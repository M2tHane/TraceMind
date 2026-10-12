import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Component } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, ChevronRight, Inbox, Loader2, RefreshCw, X, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { ApiError, errorText } from '../../lib/api'
import { Button } from './Button'

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="text-xs text-t3">{hint}</span>}</label>
}

/** List state for “nothing here yet” and “no match”: an icon in a grey disc, a title, one line, then actions. */
export function Empty({ title, description, action, icon: Icon = Inbox }: { title: string; description?: string; action?: ReactNode; icon?: LucideIcon }) {
  return <div className="tm-empty">
    <span className="tm-empty-ic" aria-hidden="true"><Icon size={20} strokeWidth={1.7} /></span>
    <h3>{title}</h3>{description && <p>{description}</p>}
    {action && <div className="tm-empty-actions">{action}</div>}
  </div>
}

/** Loading indicator; it appears only after 300ms so quick responses do not flash. */
export function Loading({ label = '正在加载…' }: { label?: string }) {
  const [shown, setShown] = useState(false)
  useEffect(() => { const timer = window.setTimeout(() => setShown(true), 300); return () => window.clearTimeout(timer) }, [])
  return <div className="flex items-center justify-center gap-2 p-10 text-t2" role="status" aria-busy="true">
    {shown ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" />{label}</> : <span className="sr-only">{label}</span>}
  </div>
}

/** Failure: what went wrong, retry, and the status code to quote when asking for help. */
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const code = error instanceof ApiError && error.status ? `HTTP ${error.status}` : null
  return <div role="alert" className="tm-alert error-state">
    <AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="m-0 font-semibold tm-alert-title">暂时无法完成操作</p>
      <p className="mt-0.5 mb-0 break-words">{errorText(error)}{code && <span className="tm-faint tm-num">（{code}）</span>}</p>
    </div>
    {retry && <Button variant="secondary" size="sm" onClick={retry}><RefreshCw size={13} aria-hidden="true" />重试</Button>}
  </div>
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="tm-note notice"><AlertCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" /><div className="min-w-0">{children}</div></div>
}

export function Modal({ open, onOpenChange, title, description, children, wide = false, drawer = false, preventClose = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean; drawer?: boolean; preventClose?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={next => { if (next || !preventClose) onOpenChange(next) }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content onEscapeKeyDown={event => { if (document.querySelector('.select-content, .tm-pop')) event.preventDefault() }} className={clsx('dialog-content', wide && 'dialog-wide', drawer && 'dialog-drawer')}>
        <div className="dialog-header">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{description ?? title}</Dialog.Description>
          <Dialog.Close asChild><Button variant="icon" className="dialog-close" aria-label="关闭"><X size={16} /></Button></Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

/** Underline tabs that switch a view in place. */
export function Tabs({ value, onChange, items, label = '视图' }: { value: string; onChange: (value: string) => void; items: { value: string; label: ReactNode; count?: number }[]; label?: string }) {
  return <div className="tm-tabs" role="tablist" aria-label={label}>{items.map(item => <button key={item.value} type="button" role="tab" aria-selected={item.value === value} className="tm-tab" onClick={() => onChange(item.value)}>{item.label}{item.count !== undefined && <span className="tm-tab-count">{item.count}</span>}</button>)}</div>
}

export function JsonDetails({ value, label = '查看原始数据' }: { value: unknown; label?: string }) { return <details className="json-details"><summary><ChevronRight size={14} />{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details> }

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } { return { error } }
  render(): ReactNode { return this.state.error ? <div className="p-8 max-w-2xl mx-auto"><ErrorState error={this.state.error} retry={() => window.location.reload()} /></div> : this.props.children }
}

/** TraceMind mark: a white T on the brand-orange tile. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return <span className="tm-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }} aria-hidden="true">T</span>
}

import type { ReactNode } from 'react'
import { Component } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, ChevronRight, Loader2, RefreshCw, X, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { errorText } from '../../lib/api'
import { Button } from './Button'

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="text-xs text-faint">{hint}</span>}</label>
}
export function Empty({ title, description, action, icon: Icon }: { title: string; description?: string; action?: ReactNode; icon?: LucideIcon }) {
  return <div className="tm-empty empty">{Icon && <Icon size={20} strokeWidth={1.6} aria-hidden="true" />}<h3>{title}</h3>{description && <p>{description}</p>}{action}</div>
}
export function Loading({ label = '正在加载…' }: { label?: string }) { return <div className="flex items-center justify-center gap-2 p-10 text-muted" role="status"><Loader2 size={16} className="animate-spin" />{label}</div> }
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div role="alert" className="tm-alert error-state"><AlertCircle size={16} className="shrink-0 mt-0.5" /><div className="min-w-0 flex-1"><p className="font-medium m-0">暂时无法完成操作</p><p className="mt-1 mb-0 break-words">{errorText(error)}</p></div>{retry && <Button variant="secondary" size="sm" onClick={retry}><RefreshCw size={13} />重试</Button>}</div>
}
export function Notice({ children }: { children: ReactNode }) { return <div className="tm-note notice"><AlertCircle size={15} className="shrink-0 mt-0.5" /><div>{children}</div></div> }
export function Modal({ open, onOpenChange, title, description, children, wide = false, drawer = false, preventClose = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean; drawer?: boolean; preventClose?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={next => { if (next || !preventClose) onOpenChange(next) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content onEscapeKeyDown={event => { if (document.querySelector('.select-content, .tm-pop')) event.preventDefault() }} className={clsx('dialog-content', wide && 'dialog-wide', drawer && 'dialog-drawer')}><div className="dialog-header"><Dialog.Title className="dialog-title">{title}</Dialog.Title><Dialog.Description className="sr-only">{description ?? title}</Dialog.Description><Dialog.Close asChild><Button variant="icon" className="absolute right-3 top-3" aria-label="关闭"><X size={16} /></Button></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>
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

/** TraceMind mark: an ink tile with a T whose foot is a highlighter stroke. */
export function BrandMark({ size = 36, tile = true }: { size?: number; tile?: boolean }) {
  const glyph = <svg width={tile ? size * 0.56 : size} height={tile ? size * 0.56 : size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 6h14M12 6v12" stroke={tile ? '#fff' : 'var(--tm-ink)'} strokeWidth={tile ? 2.4 : 2.6} strokeLinecap="round" />
    <rect x="9" y="17" width="9" height="4" rx="1" fill={tile ? 'var(--tm-cite-on)' : '#E2BE2A'} />
  </svg>
  if (!tile) return glyph
  return <span className="brand-mark" style={{ width: size, height: size, borderRadius: size * 0.22, background: 'var(--tm-ink)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }} aria-hidden="true">{glyph}</span>
}

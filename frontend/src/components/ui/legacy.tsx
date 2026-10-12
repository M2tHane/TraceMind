import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Component, useId } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, ArrowLeft, Check, ChevronRight, FileQuestion, Loader2, RefreshCw, X, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { errorText } from '../lib/api'
import { METHODS, type Method } from '../lib/types'

export function Button({ children, variant = 'primary', busy = false, className, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean }) {
  return <button type="button" {...props} disabled={disabled || busy} className={clsx('btn', `btn-${variant}`, className)}>{busy && <Loader2 size={16} className="animate-spin" />}{children}</button>
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="text-xs text-slate-500 leading-relaxed">{hint}</span>}</label>
}
export function PageHeader({ title, actions, back }: { title: string; description: string; actions?: ReactNode; back?: { to: string; label: string } }) {
  return <header className="page-header">{back && <Link className="back-link" to={back.to}><ArrowLeft size={14} />{back.label}</Link>}<div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h1>{title}</h1></div>{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}</div></header>
}
export function Empty({ title, description, action, icon: Icon = FileQuestion }: { title: string; description: string; action?: ReactNode; icon?: LucideIcon }) {
  return <div className="empty"><div className="empty-icon" aria-hidden="true"><Icon size={22} strokeWidth={1.6} /></div><h3 className="font-semibold text-slate-800">{title}</h3><p className="max-w-md text-sm text-slate-500 leading-6">{description}</p>{action}</div>
}
export function Loading({ label = '正在加载…' }: { label?: string }) { return <div className="flex items-center justify-center gap-3 p-12 text-sm text-slate-500" role="status"><Loader2 size={18} className="animate-spin" />{label}</div> }
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div role="alert" className="error-state"><AlertCircle size={19} className="shrink-0" /><div className="min-w-0 flex-1"><p className="font-medium">暂时无法完成操作</p><p className="text-sm mt-1 break-words">{errorText(error)}</p></div>{retry && <Button variant="secondary" onClick={retry}><RefreshCw size={14} />重试</Button>}</div>
}
export function Notice({ children }: { children: ReactNode }) { return <div className="notice"><AlertCircle size={16} className="shrink-0 mt-0.5" /><div>{children}</div></div> }
const STATUS: Record<string, string> = { queued: '排队中', processing: '处理中', ready: '已就绪', completed: '已完成', failed: '失败', running: '运行中', paused: '已暂停', parsing: '解析 PDF', chunking: '文本分块', embedding: '向量化', indexing: '建立索引', generating: '生成回答', retrieving: '检索中', pending: '待审核', reviewed: '已审核', pending_review: '待管理员审批', rejected: '已驳回', approved: '已通过', active: '启用', disabled: '已停用', merged: '已合并', deleted: '已删除', deleting: '删除中', ok: '正常', configured: '已配置', error: '异常', not_configured: '未配置', skipped: '未检查' }
export function statusLabel(value: string): string { return STATUS[value] ?? value }
export function Status({ value }: { value: string }) {
  const good = ['ready', 'completed', 'reviewed', 'ok', 'configured', 'approved', 'active'].includes(value)
  const bad = ['failed', 'error', 'not_configured', 'rejected', 'disabled'].includes(value)
  const active = ['queued', 'processing', 'running'].includes(value)
  return <span data-status={value} className={clsx('status', good ? 'status-good' : bad ? 'status-bad' : active ? 'status-active' : 'status-neutral')}>{active ? <Loader2 size={12} className="animate-spin" /> : good ? <Check size={12} /> : <span className="status-dot" />}{statusLabel(value)}</span>
}
export function Modal({ open, onOpenChange, title, description, children, wide = false, drawer = false, preventClose = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean; drawer?: boolean; preventClose?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={next => { if (next || !preventClose) onOpenChange(next) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content onEscapeKeyDown={event => { if (document.querySelector('.select-content')) event.preventDefault() }} className={clsx('dialog-content', wide && 'dialog-wide', drawer && 'dialog-drawer')}><div className="dialog-header"><Dialog.Title className="font-semibold text-lg pr-8 break-words">{title}</Dialog.Title><Dialog.Description className="sr-only">{description ?? title}</Dialog.Description><Dialog.Close className="icon-button absolute right-4 top-4" aria-label="关闭"><X size={19} /></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>
}
export function MethodPicker({ selected, onChange }: { selected: Method[]; onChange: (next: Method[]) => void }) {
  return <fieldset><legend className="field-label mb-2">检索方法（至少选择一种）</legend><div className="method-picker">{METHODS.map(method => <label key={method.value} className={clsx('method-option', selected.includes(method.value) && 'method-selected')}><input type="checkbox" checked={selected.includes(method.value)} onChange={e => onChange(e.target.checked ? [...selected, method.value] : selected.filter(m => m !== method.value))} /><span><strong>{method.label}</strong><small>{method.description}</small></span></label>)}</div></fieldset>
}
export function Tabs({ value, onChange, items }: { value: string; onChange: (value: string) => void; items: { value: string; label: string }[] }) {
  const id = useId()
  return <div className="tabs" aria-label="视图选择">{items.map(item => <button key={item.value} type="button" aria-pressed={item.value === value} className={clsx('tab', item.value === value && 'tab-active')} onClick={() => onChange(item.value)} id={`${id}-${item.value}`}>{item.label}</button>)}</div>
}
export function JsonDetails({ value, label = '查看原始数据' }: { value: unknown; label?: string }) { return <details className="json-details"><summary><ChevronRight size={14} />{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details> }
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } { return { error } }
  render(): ReactNode { return this.state.error ? <main className="p-8 max-w-2xl mx-auto"><ErrorState error={this.state.error} retry={() => window.location.reload()} /></main> : this.props.children }
}

/** TraceMind mark: a source node traced through retrieval to an answer node. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="9" className="brand-mark-ground" />
    <path d="M9 22.5 L15.5 10 L23 17.5" className="brand-mark-thread" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="9" cy="22.5" r="3" className="brand-mark-source" />
    <circle cx="15.5" cy="10" r="2.4" className="brand-mark-node" />
    <circle cx="23" cy="17.5" r="3.4" className="brand-mark-answer" />
  </svg>
}

const PIPELINE = [{ stage: 'queued', label: '排队' }, { stage: 'parsing', label: '解析' }, { stage: 'chunking', label: '分块' }, { stage: 'embedding', label: '向量化' }, { stage: 'indexing', label: '索引' }]
/** Ingestion progress as a trace: finished steps filled, the current step pulsing. */
export function PipelineSteps({ stage, status }: { stage: string; status: string }) {
  const current = status === 'queued' ? 0 : Math.max(0, PIPELINE.findIndex(step => step.stage === stage))
  return <ol className="pipeline" aria-label={`处理进度：${statusLabel(stage)}`}>{PIPELINE.map((step, index) =>
    <li key={step.stage} className={clsx('pipeline-step', index < current && 'pipeline-done', index === current && 'pipeline-current')}><span className="pipeline-node" />{step.label}</li>)}</ol>
}

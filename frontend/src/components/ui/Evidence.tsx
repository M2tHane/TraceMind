import type { ReactNode } from 'react'
import clsx from 'clsx'

export interface Fact { label: string; value: ReactNode }

/** Equal-width “label / value” strip at the top of detail pages. */
export function FactStrip({ items, className }: { items: Fact[]; className?: string }) {
  return <dl className={clsx('tm-panel tm-facts', className)}>{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
}
/** Two-column fact list used inside drawers and side panels. */
export function FactList({ items }: { items: Fact[] }) {
  return <dl className="tm-fact-list">{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
}

export type StepState = 'done' | 'now' | 'todo' | 'fail'
export const DOCUMENT_STEPS = ['上传', '解析', '分块', '向量化', '索引'] as const
const STAGE_INDEX: Record<string, number> = { queued: 0, pending: 0, uploading: 0, parsing: 1, chunking: 2, embedding: 3, indexing: 4 }

/** Map Document.status / stage to the five ingestion segments. */
export function documentSteps(status: string, stage: string): { steps: StepState[]; current: string } {
  if (status === 'ready' || stage === 'ready') return { steps: DOCUMENT_STEPS.map(() => 'done'), current: '全部完成' }
  const index = STAGE_INDEX[stage] ?? STAGE_INDEX[status] ?? 0
  const failed = status === 'failed' || stage === 'failed'
  return {
    steps: DOCUMENT_STEPS.map((_, i) => i < index ? 'done' : i === index ? (failed ? 'fail' : 'now') : 'todo'),
    current: `${DOCUMENT_STEPS[index]}${failed ? '失败' : ''}`,
  }
}

export function StepBar({ steps, label, size = 'md' }: { steps: StepState[]; label: string; size?: 'md' | 'sm' }) {
  return <div className={clsx('tm-steps', size === 'sm' && 'tm-steps-sm')} role="img" aria-label={label}>{steps.map((step, index) => <span key={index} data-step={step} />)}</div>
}

/** Memory importance as five bars (never stars). */
export function ImportanceMeter({ value, max = 5 }: { value: number; max?: number }) {
  return <span className="tm-imp" role="img" aria-label={`重要度 ${value} / ${max}`}>{Array.from({ length: max }, (_, index) => <span key={index} data-on={index < value} />)}</span>
}

/** Citation number inside answer text; clickable unless rendered as a static label. */
export function CiteMarker({ n, active = false, onClick, label }: { n: number; active?: boolean; onClick?: () => void; label?: string }) {
  if (!onClick) return <span className="tm-cite" data-active={active || undefined}>{n}</span>
  return <button type="button" className="tm-cite" aria-pressed={active} aria-label={label ?? `引用 ${n}`} onClick={onClick}>{n}</button>
}

/** Highlighter stroke for quoted evidence. */
export function Highlight({ children }: { children: ReactNode }) {
  return <span className="tm-hl">{children}</span>
}

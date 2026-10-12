import { useState } from 'react'
import type { ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import { useApi } from '../lib/api'
import { DEFAULT_RETRIEVAL, METHODS, type Dataset, type KnowledgeBase, type Method, type RetrievalConfig } from '../lib/types'
import { SearchableSelect, buttonClass, type SelectChoice } from '../components/ui'

export const OBJECTIVE_LABELS: Record<string, string> = {
  hit_at_1: 'Hit@1', hit_at_3: 'Hit@3', hit_at_5: 'Hit@5', hit_at_10: 'Hit@10', recall_at_5: 'Recall@5',
  recall_at_10: 'Recall@10', mrr_at_10: 'MRR@10', ndcg_at_10: 'nDCG@10',
}
export const objectiveLabel = (value: string): string => OBJECTIVE_LABELS[value] ?? value

/** Share of the whole as “93.8%”; a missing value is a dash, never zero. */
export function pct(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`
}
export function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`
}
export const formatCount = (value: number | null | undefined): string => value == null ? '—' : value.toLocaleString('zh-CN')

/** Colour per retrieval method, shared with the recall-trace palette. */
export const METHOD_COLORS: Record<string, string> = {
  bm25: 'var(--tm-stage-bm25)', vector: 'var(--tm-stage-vector)', hybrid: 'var(--tm-stage-fusion)',
  hybrid_rerank: 'var(--tm-stage-rerank)', no_context: 'var(--tm-stage-scope)', custom: 'var(--tm-stage-post)',
}
export const methodColor = (method: string): string => METHOD_COLORS[method] ?? 'var(--tm-stage-scope)'

export function useNames() {
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases')
  const datasets = useApi<Dataset[]>('/datasets')
  return {
    kbs, datasets,
    kbName: (id: string): string => kbs.data?.find(kb => kb.id === id)?.name ?? '—',
    datasetName: (id: string): string => datasets.data?.find(dataset => dataset.id === id)?.name ?? '—',
  }
}

/** Save JSON from memory as a file. */
export function downloadJson(filename: string, payload: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Label over a control, as used in the creation dialogs. */
export function FormField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="ev-field"><span className="ev-label">{label}</span>{children}{hint && <span className="ev-hint">{hint}</span>}</label>
}

/** A SearchableSelect that fills its row; the field label above names it. */
export function FieldSelect({ label, options, value, onChange, placeholder, disabled }: {
  label: string; options: SelectChoice[]; value: string; onChange: (value: string) => void; placeholder: string; disabled?: boolean
}) {
  const current = options.find(option => option.value === value)
  return <SearchableSelect label={label} options={options} value={value} onChange={onChange} disabled={disabled} width={360} triggerClassName="ev-select"
    trigger={<span className={current ? 'ev-select-value' : 'ev-select-value tm-faint'}>{current?.label ?? placeholder}</span>} />
}

export function kbOptions(kbs: KnowledgeBase[] | undefined, platformOnly: boolean): SelectChoice[] {
  return (kbs ?? []).filter(kb => !platformOnly || kb.scope === 'platform')
    .map(kb => ({ value: kb.id, label: kb.name, hint: `${kb.ready_count} 份就绪`, group: platformOnly ? undefined : kb.scope === 'platform' ? '平台' : '我的' }))
}
export function datasetOptions(datasets: Dataset[] | undefined): SelectChoice[] {
  return (datasets ?? []).map(dataset => ({ value: dataset.id, label: dataset.name, hint: `${dataset.question_count} 题` }))
}

export function MethodChecks({ selected, onChange, disabled }: { selected: Method[]; onChange: (next: Method[]) => void; disabled?: boolean }) {
  return <fieldset className="ev-fieldset" disabled={disabled}>
    <legend className="ev-label">检索方法</legend>
    <div className="ev-methods">{METHODS.map(method => <label key={method.value} className="ev-check">
      <input type="checkbox" className="tm-check" checked={selected.includes(method.value)} onChange={event => onChange(event.target.checked ? [...selected, method.value] : selected.filter(item => item !== method.value))} />
      <span>{method.label}</span>
    </label>)}</div>
  </fieldset>
}

/** “…” button that opens a small action menu; a click on an item closes it. */
export function MenuPopover({ label, children, text }: { label: string; children: ReactNode; text?: string }) {
  const [open, setOpen] = useState(false)
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>{text
      ? <button type="button" className={buttonClass('secondary')} aria-label={label}>{text}<ChevronDown size={12} aria-hidden="true" /></button>
      : <button type="button" className={buttonClass('icon')} aria-label={label}><MoreHorizontal size={16} aria-hidden="true" /></button>}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="tm-pop ev-menu" align="end" sideOffset={4} collisionPadding={12} onClick={event => { if ((event.target as HTMLElement).closest('button, a')) setOpen(false) }}>
        {children}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

// ---- Retrieval configuration wording -------------------------------------------------------------

const ROUTE_TEXT = (routes: RetrievalConfig['routes']): string => routes.length > 1 ? '向量 + BM25' : routes[0] === 'bm25' ? '仅 BM25' : '仅向量'
const onOff = (value: boolean): string => value ? '开' : '关'

interface ConfigField { keys: (keyof RetrievalConfig)[]; label: string; value: (config: RetrievalConfig) => string; show?: (config: RetrievalConfig) => boolean }
const FIELDS: ConfigField[] = [
  { keys: ['routes'], label: '召回路线', value: c => ROUTE_TEXT(c.routes) },
  { keys: ['vector_weight', 'bm25_weight'], label: '权重', value: c => `${c.vector_weight} : ${c.bm25_weight}`, show: c => c.routes.length > 1 },
  { keys: ['route_k'], label: '每路召回', value: c => String(c.route_k) },
  { keys: ['fusion_k'], label: '融合保留数', value: c => String(c.fusion_k), show: c => c.fusion_k !== DEFAULT_RETRIEVAL.fusion_k },
  { keys: ['rrf_k'], label: 'RRF k', value: c => String(c.rrf_k), show: c => c.rrf_k !== DEFAULT_RETRIEVAL.rrf_k },
  { keys: ['rerank'], label: '重排', value: c => onOff(c.rerank) },
  { keys: ['min_score'], label: '重排最低分', value: c => c.min_score == null ? '无' : String(c.min_score), show: c => c.min_score != null },
  { keys: ['query_rewrite', 'rewrite_count'], label: '多查询改写', value: c => c.query_rewrite === 'multi_query' ? `开，${c.rewrite_count} 条` : '关', show: c => c.query_rewrite === 'multi_query' },
  { keys: ['mmr_lambda'], label: 'MMR λ', value: c => c.mmr_lambda == null ? '关' : String(c.mmr_lambda), show: c => c.mmr_lambda != null },
  { keys: ['dedupe_threshold'], label: '去重阈值', value: c => c.dedupe_threshold >= 1 ? '不去重' : String(c.dedupe_threshold), show: c => c.dedupe_threshold < 1 },
  { keys: ['neighbor_window'], label: '邻块扩展', value: c => c.neighbor_window ? `±${c.neighbor_window}` : '无', show: c => c.neighbor_window > 0 },
  { keys: ['top_k'], label: '引用 top', value: c => String(c.top_k) },
]
export const normalizeConfig = (config: Partial<RetrievalConfig> | null | undefined): RetrievalConfig => ({ ...DEFAULT_RETRIEVAL, ...(config ?? {}), document_ids: undefined })
const ids = (config: RetrievalConfig, keys: (keyof RetrievalConfig)[]): string => JSON.stringify(keys.map(key => config[key] ?? null))

/** Whether two configurations describe the same pipeline (the document filter is not part of it). */
export function sameConfig(left: Partial<RetrievalConfig> | null | undefined, right: Partial<RetrievalConfig> | null | undefined): boolean {
  const a = normalizeConfig(left); const b = normalizeConfig(right)
  return FIELDS.every(field => ids(a, field.keys) === ids(b, field.keys))
}

/** One-line Chinese summary: “向量 + BM25，权重 1 : 1，每路 40，重排，top 5”. */
export function configSummary(config: Partial<RetrievalConfig>, skip: ReadonlySet<string> = new Set()): string {
  const full = normalizeConfig(config)
  return FIELDS.filter(field => (field.show?.(full) ?? true) && !field.keys.some(key => skip.has(key))).map(field => {
    const text = field.value(full)
    switch (field.keys[0]) {
      case 'routes': return text
      case 'mmr_lambda': return `MMR ${text}`
      case 'vector_weight': return `权重 ${text}`
      case 'route_k': return `每路 ${text}`
      case 'fusion_k': return `融合保留 ${text}`
      case 'rrf_k': return `RRF k ${text}`
      case 'rerank': return text === '开' ? '重排' : '不重排'
      case 'min_score': return `最低分 ${text}`
      case 'query_rewrite': return '多查询'
      case 'dedupe_threshold': return `去重 ${text}`
      case 'neighbor_window': return `邻块 ${text}`
      case 'top_k': return `top ${text}`
      default: return text
    }
  }).join('，')
}

export interface ConfigChange { key: string; label: string; from: string; to: string }
/** Parameters on which `next` differs from `current`. */
export function configChanges(current: Partial<RetrievalConfig>, next: Partial<RetrievalConfig>): ConfigChange[] {
  const a = normalizeConfig(current); const b = normalizeConfig(next)
  return FIELDS.filter(field => ids(a, field.keys) !== ids(b, field.keys)).map(field => ({ key: field.keys[0], label: field.label, from: field.value(a), to: field.value(b) }))
}
export const changedKeys = (current: Partial<RetrievalConfig>, next: Partial<RetrievalConfig>): Set<string> => {
  const a = normalizeConfig(current); const b = normalizeConfig(next)
  return new Set(FIELDS.filter(field => ids(a, field.keys) !== ids(b, field.keys)).flatMap(field => field.keys))
}

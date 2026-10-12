import { DEFAULT_RETRIEVAL, type RetrievalConfig, type TraceStage } from '../lib/types'
import type { ReactNode } from 'react'
import { TraceView } from './TraceView'

/** Recall chain of one result (kept for the comparison page and evaluation inspection). */
export function RecallTrace({ stages, queries, config }: { stages: TraceStage[]; queries?: string[]; config?: RetrievalConfig | null }) {
  if (!stages.length) return null
  return <TraceView stages={stages} queries={queries} config={config} />
}

type NumberKey = 'route_k' | 'fusion_k' | 'top_k' | 'bm25_weight' | 'vector_weight' | 'rrf_k' | 'neighbor_window' | 'rewrite_count' | 'dedupe_threshold'
const NUMBER_FIELDS: { key: NumberKey; label: string; min: number; max: number; step?: number }[] = [
  { key: 'route_k', label: '每路召回数', min: 1, max: 200 },
  { key: 'fusion_k', label: '融合保留数', min: 1, max: 200 },
  { key: 'top_k', label: 'top_k', min: 1, max: 20 },
  { key: 'vector_weight', label: '向量权重', min: 0, max: 10, step: 0.1 },
  { key: 'bm25_weight', label: 'BM25 权重', min: 0, max: 10, step: 0.1 },
  { key: 'rrf_k', label: 'RRF k', min: 1, max: 1000 },
  { key: 'dedupe_threshold', label: '去重阈值', min: 0.5, max: 1, step: 0.01 },
  { key: 'neighbor_window', label: '相邻块扩展', min: 0, max: 2 },
]

function NumberField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="ev-field"><span className="ev-label">{label}</span>{children}</label>
}

/** Controlled editor for a full RetrievalConfig; unset optional fields stay null. */
export function RetrievalConfigEditor({ value, onChange, disabled = false }: { value: RetrievalConfig; onChange: (next: RetrievalConfig) => void; disabled?: boolean }) {
  const set = <K extends keyof RetrievalConfig>(key: K, next: RetrievalConfig[K]) => onChange({ ...value, [key]: next })
  const toggleRoute = (route: 'vector' | 'bm25') => {
    const routes = value.routes.includes(route) ? value.routes.filter(r => r !== route) : [...value.routes, route]
    if (routes.length) set('routes', routes)
  }
  return <fieldset className="ev-fieldset retrieval-editor" disabled={disabled}>
    <div className="ev-methods">
      {(['vector', 'bm25'] as const).map(route => <label key={route} className="ev-check"><input type="checkbox" className="tm-check" checked={value.routes.includes(route)} onChange={() => toggleRoute(route)} /><span>{route === 'vector' ? '向量召回' : 'BM25 召回'}</span></label>)}
      <label className="ev-check"><input type="checkbox" className="tm-check" checked={value.rerank} onChange={e => onChange({ ...value, rerank: e.target.checked, min_score: e.target.checked ? value.min_score : null })} /><span>重排序</span></label>
      <label className="ev-check"><input type="checkbox" className="tm-check" checked={value.query_rewrite === 'multi_query'} onChange={e => set('query_rewrite', e.target.checked ? 'multi_query' : 'none')} /><span>多查询改写</span></label>
    </div>
    <div className="retrieval-editor-grid">
      {NUMBER_FIELDS.map(field => <NumberField key={field.key} label={field.label}><input className="tm-input tm-num" type="number" min={field.min} max={field.max} step={field.step ?? 1} value={value[field.key]} onChange={e => set(field.key, Number(e.target.value))} required /></NumberField>)}
      <NumberField label="重排最低分"><input className="tm-input tm-num" type="number" step={0.01} placeholder="不过滤" value={value.min_score ?? ''} disabled={!value.rerank} onChange={e => set('min_score', e.target.value === '' ? null : Number(e.target.value))} /></NumberField>
      <NumberField label="MMR λ"><input className="tm-input tm-num" type="number" min={0} max={1} step={0.05} placeholder="关闭" value={value.mmr_lambda ?? ''} onChange={e => set('mmr_lambda', e.target.value === '' ? null : Number(e.target.value))} /></NumberField>
    </div>
  </fieldset>
}

export function retrievalSummary(config: Partial<RetrievalConfig> | null | undefined): string {
  if (!config || !config.routes) return '默认（混合 + 重排）'
  const merged = { ...DEFAULT_RETRIEVAL, ...config }
  const parts = [merged.routes.map(r => (r === 'vector' ? '向量' : 'BM25')).join('+')]
  if (merged.routes.length > 1) parts.push(`权重 ${merged.vector_weight}:${merged.bm25_weight}`)
  parts.push(`召回 ${merged.route_k}`)
  if (merged.rerank) parts.push('重排')
  if (merged.query_rewrite === 'multi_query') parts.push('多查询')
  if (merged.mmr_lambda != null) parts.push(`MMR ${merged.mmr_lambda}`)
  if (merged.dedupe_threshold < 1) parts.push(`去重 ${merged.dedupe_threshold}`)
  parts.push(`top ${merged.top_k}`)
  return parts.join(' · ')
}

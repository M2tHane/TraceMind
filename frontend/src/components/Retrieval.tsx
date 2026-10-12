import { formatNumber } from '../lib/api'
import { DEFAULT_RETRIEVAL, type RetrievalConfig, type TraceStage } from '../lib/types'
import { Field } from './ui'

const STAGE_LABELS: Record<string, string> = {
  scope: '范围过滤', query_rewrite: '查询改写', 'recall.vector': '向量召回', 'recall.bm25': 'BM25 召回',
  fusion: '融合', rerank: '重排序', postprocess: '后处理',
}
const DETAIL_KEYS: Record<string, string> = {
  corpus_chunks: '候选分块', k: 'k', method: '方式', rrf_k: 'RRF k', weights: '权重', input: '输入', kept: '保留',
  min_score: '最低分', dedupe_threshold: '去重阈值', mmr_lambda: 'MMR λ', neighbor_window: '相邻扩展', top_k: 'top_k',
}

function detailText(stage: TraceStage): string {
  return Object.entries(DETAIL_KEYS)
    .filter(([key]) => stage[key] !== undefined && stage[key] !== null && !(key === 'dedupe_threshold' && stage[key] === 1))
    .map(([key, label]) => `${label} ${Array.isArray(stage[key]) ? (stage[key] as unknown[]).join(' / ') : String(stage[key])}`)
    .join(' · ')
}

/** Stage-by-stage recall chain: what each step received, kept and how long it took. */
export function RecallTrace({ stages, queries }: { stages: TraceStage[]; queries?: string[] }) {
  if (!stages.length) return null
  const total = stages.reduce((sum, stage) => sum + (stage.ms || 0), 0)
  return <div className="trace">
    <div className="trace-header"><span>召回链路</span><span>{stages.length} 个阶段 · {formatNumber(total)} ms</span></div>
    {queries && queries.length > 1 && <p className="trace-queries">查询：{queries.map(q => <span key={q} className="file-tag">{q}</span>)}</p>}
    <ol className="trace-list">{stages.map((stage, index) => <li key={`${stage.stage}-${index}`} className="trace-stage">
      <div className="trace-stage-head">
        <span className="trace-index">{index + 1}</span>
        <strong>{STAGE_LABELS[stage.stage] ?? stage.stage}</strong>
        {stage.count !== undefined && <span className="count-badge">{stage.count}</span>}
        <span className="trace-ms">{formatNumber(stage.ms)} ms</span>
      </div>
      {typeof stage.query === 'string' && <p className="trace-detail">查询：{stage.query}</p>}
      {detailText(stage) && <p className="trace-detail">{detailText(stage)}</p>}
      {!!stage.candidates?.length && <details className="trace-candidates"><summary>前 {stage.candidates.length} 个候选</summary>
        <table><tbody>{stage.candidates.map(candidate => <tr key={candidate.id}>
          <td className="tabular-nums">#{candidate.rank}</td>
          <td className="break-all">{candidate.filename}{candidate.page ? ` · 第 ${candidate.page} 页` : ''}</td>
          <td className="tabular-nums text-right">{candidate.score.toFixed(4)}</td>
        </tr>)}</tbody></table>
      </details>}
    </li>)}</ol>
  </div>
}

type NumberKey = 'route_k' | 'fusion_k' | 'top_k' | 'bm25_weight' | 'vector_weight' | 'rrf_k' | 'neighbor_window' | 'rewrite_count' | 'dedupe_threshold'
const NUMBER_FIELDS: { key: NumberKey; label: string; min: number; max: number; step?: number; hint?: string }[] = [
  { key: 'route_k', label: '每路召回数', min: 1, max: 200 },
  { key: 'fusion_k', label: '融合保留数', min: 1, max: 200, hint: '也是送入重排的数量' },
  { key: 'top_k', label: 'top_k', min: 1, max: 20 },
  { key: 'vector_weight', label: '向量权重', min: 0, max: 10, step: 0.1 },
  { key: 'bm25_weight', label: 'BM25 权重', min: 0, max: 10, step: 0.1 },
  { key: 'rrf_k', label: 'RRF k', min: 1, max: 1000 },
  { key: 'dedupe_threshold', label: '去重阈值', min: 0.5, max: 1, step: 0.01, hint: '1 = 不去重' },
  { key: 'neighbor_window', label: '相邻块扩展', min: 0, max: 2 },
]

/** Controlled editor for a full RetrievalConfig; unset optional fields stay null. */
export function RetrievalConfigEditor({ value, onChange, disabled = false }: { value: RetrievalConfig; onChange: (next: RetrievalConfig) => void; disabled?: boolean }) {
  const set = <K extends keyof RetrievalConfig>(key: K, next: RetrievalConfig[K]) => onChange({ ...value, [key]: next })
  const toggleRoute = (route: 'vector' | 'bm25') => {
    const routes = value.routes.includes(route) ? value.routes.filter(r => r !== route) : [...value.routes, route]
    if (routes.length) set('routes', routes)
  }
  return <fieldset className="space-y-4" disabled={disabled}>
    <div className="flex flex-wrap gap-4 text-sm">
      {(['vector', 'bm25'] as const).map(route => <label key={route} className="inline-flex items-center gap-2"><input type="checkbox" checked={value.routes.includes(route)} onChange={() => toggleRoute(route)} />{route === 'vector' ? '向量召回' : 'BM25 召回'}</label>)}
      <label className="inline-flex items-center gap-2"><input type="checkbox" checked={value.rerank} onChange={e => onChange({ ...value, rerank: e.target.checked, min_score: e.target.checked ? value.min_score : null })} />重排序</label>
      <label className="inline-flex items-center gap-2"><input type="checkbox" checked={value.query_rewrite === 'multi_query'} onChange={e => set('query_rewrite', e.target.checked ? 'multi_query' : 'none')} />多查询改写<small className="text-slate-500">（调用对话模型）</small></label>
    </div>
    <div className="grid grid-cols-2 gap-3">
      {NUMBER_FIELDS.map(field => <Field key={field.key} label={field.label} hint={field.hint}><input type="number" min={field.min} max={field.max} step={field.step ?? 1} value={value[field.key]} onChange={e => set(field.key, Number(e.target.value))} required /></Field>)}
      <Field label="重排最低分" hint="留空不过滤"><input type="number" step={0.01} value={value.min_score ?? ''} disabled={!value.rerank} onChange={e => set('min_score', e.target.value === '' ? null : Number(e.target.value))} /></Field>
      <Field label="MMR λ" hint="留空关闭多样性"><input type="number" min={0} max={1} step={0.05} value={value.mmr_lambda ?? ''} onChange={e => set('mmr_lambda', e.target.value === '' ? null : Number(e.target.value))} /></Field>
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

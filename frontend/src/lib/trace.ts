import { DEFAULT_RETRIEVAL, type Method, type RetrievalConfig, type TraceCandidate, type TraceStage } from './types'

/** Same mapping as the backend's RetrievalConfig.from_method, so an explicit pipeline behaves like the method. */
export function configForMethod(method: Method, topK: number, candidateK: number): RetrievalConfig {
  const routes: RetrievalConfig['routes'] = method === 'bm25' ? ['bm25'] : method === 'vector' ? ['vector'] : ['vector', 'bm25']
  return { ...DEFAULT_RETRIEVAL, routes, route_k: candidateK, fusion_k: candidateK, top_k: Math.min(topK, candidateK), rerank: method === 'hybrid_rerank' }
}

export const STAGE_META: Record<string, { label: string; color: string; column?: string }> = {
  scope: { label: '范围过滤', color: 'var(--tm-stage-scope)' },
  query_rewrite: { label: '查询改写', color: 'var(--tm-stage-scope)' },
  'recall.vector': { label: '向量召回', color: 'var(--tm-stage-vector)', column: '向量' },
  'recall.bm25': { label: 'BM25 召回', color: 'var(--tm-stage-bm25)', column: 'BM25' },
  fusion: { label: '融合', color: 'var(--tm-stage-fusion)', column: '融合' },
  rerank: { label: '重排', color: 'var(--tm-stage-rerank)', column: '重排' },
  postprocess: { label: '后处理', color: 'var(--tm-stage-post)', column: '最终' },
}

const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

export interface StageRow { stage: TraceStage; label: string; color: string; input?: number; output?: number; ms: number; share: number; note: string }

/** Only parameters recorded in the trace, never an interpretation of them. */
function stageNote(stage: TraceStage, queries: number): string {
  const parts: string[] = []
  switch (stage.stage) {
    case 'scope': {
      const filter = stage.document_filter
      parts.push(Array.isArray(filter) ? `限定 ${filter.length} 份文档` : '全部文档')
      break
    }
    case 'query_rewrite': if (Array.isArray(stage.queries)) parts.push(`${stage.queries.length} 条查询`); break
    case 'recall.vector': case 'recall.bm25':
      if (num(stage.k) !== undefined) parts.push(`k ${stage.k}`)
      if (queries > 1 && typeof stage.query === 'string') parts.push(`查询“${stage.query}”`)
      break
    case 'fusion':
      if (stage.method === 'single_route') parts.push('单路')
      if (num(stage.rrf_k) !== undefined) parts.push(`rrf_k ${stage.rrf_k}`)
      if (Array.isArray(stage.weights)) parts.push(`weights ${(stage.weights as number[]).join(' : ')}`)
      break
    case 'postprocess':
      if (num(stage.kept) !== undefined) parts.push(`保留 ${stage.kept}`)
      if (num(stage.top_k) !== undefined) parts.push(`top_k ${stage.top_k}`)
      if (num(stage.min_score) !== undefined) parts.push(`min_score ${stage.min_score}`)
      if (num(stage.dedupe_threshold) !== undefined && stage.dedupe_threshold !== 1) parts.push(`去重 ${stage.dedupe_threshold}`)
      if (num(stage.mmr_lambda) !== undefined) parts.push(`MMR λ ${stage.mmr_lambda}`)
      if (num(stage.neighbor_window)) parts.push(`相邻块 ±${stage.neighbor_window}`)
      break
  }
  return parts.join('，')
}

export function stageRows(stages: TraceStage[]): StageRow[] {
  const total = stages.reduce((sum, stage) => sum + (stage.ms || 0), 0)
  const scope = stages.find(stage => stage.stage === 'scope')
  const corpus = num(scope?.corpus_chunks)
  const recallOut = stages.filter(stage => stage.stage.startsWith('recall.')).reduce((sum, stage) => sum + (num(stage.count) ?? 0), 0)
  const fusion = stages.find(stage => stage.stage === 'fusion')
  const queries = stages.filter(stage => stage.stage === 'recall.vector').length || stages.filter(stage => stage.stage === 'recall.bm25').length
  return stages.map(stage => {
    let input: number | undefined
    let output = num(stage.count)
    if (stage.stage === 'scope') { input = corpus; output = corpus }
    else if (stage.stage.startsWith('recall.')) input = corpus
    else if (stage.stage === 'fusion') input = recallOut || undefined
    else if (stage.stage === 'rerank') input = num(fusion?.count)
    else if (stage.stage === 'postprocess') input = num(stage.input)
    else if (stage.stage === 'query_rewrite') { input = 1; output = Array.isArray(stage.queries) ? stage.queries.length : undefined }
    const meta = STAGE_META[stage.stage] ?? { label: stage.stage, color: 'var(--tm-faint)' }
    return { stage, label: meta.label, color: meta.color, input, output, ms: stage.ms || 0, share: total ? (stage.ms || 0) / total : 0, note: stageNote(stage, queries) }
  })
}

export interface RankColumn { key: string; label: string; candidates: TraceCandidate[] }

/** Columns of the rank chart: first vector and BM25 lists (the original query), fusion, rerank, final. */
export function rankColumns(stages: TraceStage[]): RankColumn[] {
  const pick = (key: string) => stages.find(stage => stage.stage === key && stage.candidates?.length)
  return ['recall.vector', 'recall.bm25', 'fusion', 'rerank', 'postprocess']
    .map(key => ({ key, stage: pick(key) }))
    .filter((item): item is { key: string; stage: TraceStage } => !!item.stage)
    .map(({ key, stage }) => ({ key, label: STAGE_META[key].column!, candidates: stage.candidates! }))
}

export const candidateLabel = (candidate: Pick<TraceCandidate, 'filename' | 'page'>): string => `${candidate.filename}${candidate.page ? ` p.${candidate.page}` : ''}`

export function traceTotals(stages: TraceStage[]): { ms: number; corpus?: number; kept?: number } {
  const scope = stages.find(stage => stage.stage === 'scope')
  const post = stages.find(stage => stage.stage === 'postprocess')
  return { ms: stages.reduce((sum, stage) => sum + (stage.ms || 0), 0), corpus: num(scope?.corpus_chunks), kept: num(post?.count) }
}

export function configTags(config: Partial<RetrievalConfig> | null | undefined): { label: string; value: string }[] {
  if (!config?.routes) return []
  const c = { ...DEFAULT_RETRIEVAL, ...config }
  return [
    { label: '路线', value: c.routes.map(route => route === 'vector' ? '向量' : 'BM25').join(' + ') },
    { label: '每路召回', value: String(c.route_k) },
    ...(c.routes.length > 1 ? [{ label: 'RRF k', value: String(c.rrf_k) }, { label: '权重', value: `${c.vector_weight} : ${c.bm25_weight}` }] : []),
    { label: '重排', value: c.rerank ? '开' : '关' },
    { label: '引用', value: `top ${c.top_k}` },
    { label: '查询改写', value: c.query_rewrite === 'multi_query' ? `开（${c.rewrite_count} 条）` : '关' },
  ]
}

/** URL of the retrieval comparison page pre-filled with this pipeline. */
export function comparisonUrl(kbId: string | undefined, question: string | undefined, config: RetrievalConfig | null | undefined): string {
  const params = new URLSearchParams()
  if (kbId) params.set('kb', kbId)
  if (question) params.set('q', question)
  if (config) params.set('config', JSON.stringify(config))
  return `/evaluation/retrieval?${params.toString()}`
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
}

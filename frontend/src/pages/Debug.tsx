import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { post, useAction, useApi } from '../lib/api'
import { DEFAULT_RETRIEVAL, methodLabel, type KnowledgeBase, type Method, type RagResult, type RetrievalConfig } from '../lib/types'
import { RetrievalConfigEditor } from '../components/Retrieval'
import { Button, Empty, ErrorState, Loading, Notice } from '../components/ui'
import { ResultView } from '../components/sources'
import { Page } from '../components/shell/Shell'
import { EvaluationSide } from '../components/shell/ModuleNav'
import { FieldSelect, FormField, MethodChecks, kbOptions, methodColor } from './evalShared'

interface DebugInput { knowledge_base_id: string; question: string; methods: Method[]; retrieval_only: boolean; top_k: number; candidate_k: number; reference_answer?: string; retrieval?: RetrievalConfig }

/** Read the `config` query parameter (a JSON RetrievalConfig); anything unusable is ignored. */
function readConfig(raw: string | null): RetrievalConfig | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const merged: Record<string, unknown> = { ...DEFAULT_RETRIEVAL }
    for (const [key, value] of Object.entries(parsed)) if (key in DEFAULT_RETRIEVAL || key === 'document_ids') merged[key] = value
    const routes = merged.routes
    if (!Array.isArray(routes) || !routes.length || !routes.every(route => route === 'vector' || route === 'bm25')) return null
    return merged as unknown as RetrievalConfig
  } catch { return null }
}

export function DebugPage() {
  const [params] = useSearchParams()
  const search = params.toString()
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases')
  const [kbId, setKbId] = useState(params.get('kb') ?? '')
  const [methods, setMethods] = useState<Method[]>(['bm25', 'hybrid_rerank'])
  const [question, setQuestion] = useState(params.get('q') ?? '')
  const [retrievalOnly, setRetrievalOnly] = useState(true)
  const [custom, setCustom] = useState<RetrievalConfig | null>(() => readConfig(params.get('config')))
  const debug = useAction((body: DebugInput) => post<{ results: RagResult[] }>('/debug', body))
  // Arriving with kb / q / config (from the recall chain or a run) fills the form once per link; nothing is sent.
  const applied = useRef<string | null>(null)
  useEffect(() => {
    if (applied.current === search) return
    applied.current = search
    const config = readConfig(params.get('config'))
    if (params.has('config') && !config) toast.error('地址里的检索配置无法读取')
    if (params.has('kb')) setKbId(params.get('kb') ?? '')
    if (params.has('q')) setQuestion(params.get('q') ?? '')
    if (config) setCustom(config)
  }, [search, params])
  const selectedKb = kbs.data?.some(kb => kb.id === kbId) ? kbId : kbs.data?.[0]?.id ?? ''
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); if (debug.isPending) return
    const form = new FormData(event.currentTarget)
    debug.mutate({ knowledge_base_id: selectedKb, question: question.trim(), methods, retrieval_only: retrievalOnly, top_k: Number(form.get('top_k')), candidate_k: Number(form.get('candidate_k')), reference_answer: String(form.get('reference_answer') || '').trim() || undefined, retrieval: custom ? { ...custom, top_k: Math.min(custom.top_k, custom.fusion_k) } : undefined })
  }
  return <Page side={<EvaluationSide section="retrieval" />} title="检索对比">
    <div className="ev-debug">
      <form className="tm-panel ev-debug-form" onSubmit={handleSubmit}>
        <div className="tm-panel-title"><h2>实验配置</h2></div>
        <fieldset disabled={debug.isPending} className="ev-fieldset ev-form-fields ev-pad">
          <FormField label="知识库"><FieldSelect label="知识库" placeholder="选择知识库" options={kbOptions(kbs.data, false)} value={selectedKb} onChange={setKbId} disabled={debug.isPending} /></FormField>
          {kbs.isError && <ErrorState error={kbs.error} retry={() => { void kbs.refetch() }} />}
          <FormField label="测试问题"><textarea className="tm-input" rows={4} value={question} onChange={event => setQuestion(event.target.value)} required placeholder="输入需要对比检索效果的问题" /></FormField>
          <MethodChecks selected={methods} onChange={setMethods} />
          <label className="ev-check"><input type="checkbox" className="tm-check" checked={!!custom} onChange={event => setCustom(event.target.checked ? { ...DEFAULT_RETRIEVAL } : null)} /><span>追加自定义流水线</span></label>
          {custom && <div className="ev-custom"><RetrievalConfigEditor value={custom} onChange={setCustom} disabled={debug.isPending} /></div>}
          <div className="ev-row2">
            <FormField label="top_k"><input className="tm-input" name="top_k" type="number" min={1} max={20} defaultValue={5} required /></FormField>
            <FormField label="candidate_k"><input className="tm-input" name="candidate_k" type="number" min={1} max={100} defaultValue={20} required /></FormField>
          </div>
          <FormField label="参考答案（可选）"><textarea className="tm-input" name="reference_answer" rows={2} /></FormField>
          <label className="ev-check"><input type="checkbox" className="tm-check" checked={retrievalOnly} onChange={event => setRetrievalOnly(event.target.checked)} /><span>仅检索，不生成回答</span></label>
          {!retrievalOnly && <Notice>将为每种方法生成回答，可能耗时数分钟并产生模型调用费用。</Notice>}
          <Button type="submit" className="ev-submit" busy={debug.isPending} disabled={!question.trim() || !methods.length || !kbs.data?.length}>{debug.isPending ? '正在对比' : '开始对比'}</Button>
        </fieldset>
      </form>
      <section className="ev-debug-results" aria-label="对比结果">
        {debug.isPending ? <div className="tm-panel"><Loading label="正在依次检索与生成，请勿重复提交" /></div>
          : debug.isError ? <ErrorState error={debug.error} />
            : debug.data ? <>
              <div className="ev-debug-head"><h2>{debug.variables?.question}</h2><span className="tm-faint">{debug.variables?.retrieval_only ? '仅检索，未生成回答' : '检索并生成回答'}</span></div>
              <div className="ev-compare">{debug.data.results.map(result => <article className="tm-panel" key={result.method}>
                <header className="tm-panel-title"><span className="ev-swatch" style={{ background: methodColor(result.method) }} aria-hidden="true" /><h3>{methodLabel(result.method)}</h3><span className="flex-1" /><span className="tm-faint tm-num">{result.contexts?.length ?? 0} 条召回</span></header>
                <div className="ev-pad"><ResultView result={result} retrievalOnly={debug.variables?.retrieval_only} /></div>
              </article>)}</div>
            </> : <div className="tm-panel"><Empty title="还没有对比结果" /></div>}
      </section>
    </div>
  </Page>
}

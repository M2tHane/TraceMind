import { EvalNav } from '../components/EvalNav'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FlaskConical, Play } from 'lucide-react'
import { post, useAction, useApi } from '../lib/api'
import { DEFAULT_RETRIEVAL, methodLabel, type KnowledgeBase, type Method, type RagResult, type RetrievalConfig } from '../lib/types'
import { RetrievalConfigEditor } from '../components/Retrieval'
import { Button, Empty, ErrorState, Field, Loading, MethodPicker, Notice, PageHeader } from '../components/ui'
import { ResultView } from '../components/sources'
import { Select } from '../components/Select'

interface DebugInput { knowledge_base_id: string; question: string; methods: Method[]; retrieval_only: boolean; top_k: number; candidate_k: number; reference_answer?: string; retrieval?: RetrievalConfig }
export function DebugPage() {
  const [params] = useSearchParams()
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases')
  const [kbId, setKbId] = useState(params.get('kb') ?? '')
  const [methods, setMethods] = useState<Method[]>(['bm25', 'hybrid_rerank'])
  const [question, setQuestion] = useState('')
  const [retrievalOnly, setRetrievalOnly] = useState(true)
  const [custom, setCustom] = useState<RetrievalConfig | null>(null)
  const debug = useAction((body: DebugInput) => post<{ results: RagResult[] }>('/debug', body))
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); if (debug.isPending) return
    const form = new FormData(event.currentTarget)
    debug.mutate({ knowledge_base_id: kbId || kbs.data?.[0]?.id || '', question: question.trim(), methods, retrieval_only: retrievalOnly, top_k: Number(form.get('top_k')), candidate_k: Number(form.get('candidate_k')), reference_answer: String(form.get('reference_answer') || '').trim() || undefined, retrieval: custom ? { ...custom, top_k: Math.min(custom.top_k, custom.fusion_k) } : undefined })
  }
  return <div className="page page-wide"><PageHeader title="检索对比实验" description="同一个问题，并排观察不同方法的召回内容与回答。每次实验都请求真实服务。" /><EvalNav current="retrieval" /><div className="debug-layout"><form className="panel debug-form" onSubmit={handleSubmit}><div className="flex gap-2 items-center mb-5 font-semibold text-sm"><FlaskConical size={17} />实验配置</div><fieldset disabled={debug.isPending} className="space-y-5"><Field label="知识库"><Select label="知识库" value={kbId || kbs.data?.[0]?.id || ''} onChange={setKbId} disabled={debug.isPending} required options={(kbs.data ?? []).map(kb => ({ value: kb.id, label: kb.name }))} /></Field>{kbs.isError && <ErrorState error={kbs.error} retry={() => { void kbs.refetch() }} />}<Field label="测试问题"><textarea rows={4} value={question} onChange={e => setQuestion(e.target.value)} required placeholder="输入需要对比检索效果的问题…" /></Field><MethodPicker selected={methods} onChange={setMethods} /><label className="checkbox-label"><input type="checkbox" checked={!!custom} onChange={e => setCustom(e.target.checked ? { ...DEFAULT_RETRIEVAL } : null)} /><span>追加自定义流水线<small>与所选方法并排对比，结果标记为“自定义流水线”。</small></span></label>{custom && <div className="panel p-4"><RetrievalConfigEditor value={custom} onChange={setCustom} disabled={debug.isPending} /></div>}<div className="grid grid-cols-2 gap-3"><Field label="top_k"><input name="top_k" type="number" min={1} max={20} defaultValue={5} required /></Field><Field label="candidate_k"><input name="candidate_k" type="number" min={1} max={100} defaultValue={20} required /></Field></div><Field label="参考答案（可选）"><textarea name="reference_answer" rows={2} placeholder="提供用于对照的参考答案" /></Field><label className="checkbox-label"><input type="checkbox" checked={retrievalOnly} onChange={e => setRetrievalOnly(e.target.checked)} /><span>仅检索，不生成回答<small>向量检索和重排仍可能调用外部模型。</small></span></label>{!retrievalOnly && <Notice>将为每种方法生成回答，可能耗时数分钟并产生模型调用费用。</Notice>}<Button type="submit" className="w-full" busy={debug.isPending} disabled={!question.trim() || !methods.length || !kbs.data?.length}><Play size={15} />{debug.isPending ? '正在运行实验…' : '开始对比'}</Button></fieldset></form><section className="min-w-0">{debug.isPending ? <div className="panel"><Loading label="正在依次检索与生成，请勿重复提交…" /><p className="text-xs text-slate-500 pb-8 text-center">实验为同步调用，完成后展示真实结果，不模拟流式输出。</p></div> : debug.isError ? <ErrorState error={debug.error} /> : debug.data ? <><div className="mb-5"><p className="section-label mb-2">本次实验问题</p><h2 className="text-base font-medium break-words">{debug.variables?.question}</h2><p className="mt-2 text-xs text-slate-500">{debug.variables?.retrieval_only ? '仅检索 · 未生成回答' : '检索 + 回答生成'}</p></div><div className="comparison-grid">{debug.data.results.map(result => <article className="panel comparison-result" key={result.method}><div className="comparison-heading"><h3>{methodLabel(result.method)}</h3><span className="text-xs text-slate-500">{result.contexts?.length ?? 0} 条召回</span></div><div className="p-5"><ResultView result={result} retrievalOnly={debug.variables?.retrieval_only} /></div></article>)}</div></> : <div className="panel"><Empty title="看见检索方法之间的差异" description="在左侧选择方法并输入问题。结果会展示召回原文、引用、耗时与生成答案，帮助定位问题发生在哪一步。" /></div>}</section></div></div>
}

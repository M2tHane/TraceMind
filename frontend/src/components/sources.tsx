import { useEffect, useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, ExternalLink, FileText, Quote } from 'lucide-react'
import { methodLabel, type Citation, type RagResult, type Timing, type TraceStage, type Usage } from '../lib/types'
import { formatNumber } from '../lib/api'
import type { PublicModelSnapshot } from '../lib/configuration'
import { Empty, Modal, Notice } from './ui'
import { PdfCanvas } from './PdfCanvas'
import { RecallTrace, retrievalSummary } from './Retrieval'
import type { RetrievalConfig } from '../lib/types'

export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="text-slate-500">[图片：{alt || '文档图片'}]</span> }}>{text}</ReactMarkdown></div>
}
export function PdfViewer({ documentId, page, filename }: { documentId: string; page?: number | null; filename: string }) {
  if (!filename.toLowerCase().endsWith('.pdf')) return <TextSource documentId={documentId} markdown={/\.(md|markdown)$/i.test(filename)} />
  return <PdfCanvas documentId={documentId} page={page} filename={filename} />
}
function TextSource({ documentId, markdown }: { documentId: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setText(null); setFailed(false)
    fetch(`/api/documents/${encodeURIComponent(documentId)}/file`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.text() })
      .then(setText)
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [documentId])
  if (failed) return <Notice>原文加载失败，请稍后重试。</Notice>
  if (text === null) return <p className="text-sm text-slate-500 py-2">正在加载原文…</p>
  return markdown ? <Markdown text={text} /> : <pre className="whitespace-pre-wrap break-words text-sm leading-6">{text}</pre>
}
function CitationExcerpt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const compact = text.replace(/\s+/g, ' ').trim()
  const preview = compact.length > 220 ? `${compact.slice(0, 220)}…` : compact
  return <div className="excerpt"><p id={id} className={expanded ? '' : 'line-clamp-3'}>{expanded ? text : preview || '该来源未返回文本。'}</p>{compact.length > 80 && <button type="button" className="text-link text-sm mt-2" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(current => !current)}>{expanded ? '收起' : '展开全文'}</button>}</div>
}
export function CitationList({ citations, label = '引用来源', defaultOpen = false, compact = false }: { citations: Citation[]; label?: string; defaultOpen?: boolean; compact?: boolean }) {
  const [source, setSource] = useState<Citation | null>(null)
  const distinct = [...new Map(citations.map(c => [`${c.document_id}:${c.id}:${c.page}`, c])).values()]
  return <><details className={`citations ${compact ? 'citations-compact' : ''}`} open={defaultOpen || undefined}><summary aria-label={compact ? `${label}，${distinct.length} 条` : undefined} title={compact ? `${label} · ${distinct.length} 条` : undefined}>{compact ? <><Quote size={16} aria-hidden="true" /><span>{distinct.length}</span></> : <><span className="flex items-center gap-2">{label}<span className="count-badge">{distinct.length}</span></span><ChevronDown size={15} /></>}</summary><div className="citation-list">{distinct.length === 0 ? <p className="text-sm text-slate-500 py-2">没有可验证的引用。</p> : distinct.map((citation, index) => <article key={`${citation.document_id}:${citation.id}:${citation.page}`} className="citation-item"><div className="flex items-start gap-2"><span className="citation-number">{index + 1}</span><button className="citation-source" onClick={() => setSource(citation)}><FileText size={15} className="shrink-0" /><span className="break-all">{citation.filename}</span><span className="whitespace-nowrap inline-flex items-center gap-1">{citation.page ? `第 ${citation.page} 页` : '页码未知'}<ExternalLink size={12} /></span></button></div><CitationExcerpt text={citation.text} /></article>)}</div></details><Modal open={!!source} onOpenChange={open => { if (!open) setSource(null) }} title={source?.filename ?? '来源文档'} drawer>{source && <div className="drawer-body"><blockquote className="source-quote">{source.text}</blockquote><PdfViewer documentId={source.document_id} page={source.page} filename={source.filename} /></div>}</Modal></>
}
export function DebugInfo({ method, timing, usage, contexts = [], modelSnapshot, trace = [], queries, config, memoriesUsed }: { method: string; timing?: Timing | null; usage?: Usage | null; contexts?: Citation[]; modelSnapshot?: PublicModelSnapshot | null; trace?: TraceStage[]; queries?: string[]; config?: RetrievalConfig | null; memoriesUsed?: number }) {
  return <details className="debug-details"><summary>调试信息</summary><div className="result-timing"><span>方法：{methodLabel(method)}</span><span>检索 {formatNumber(timing?.retrieval_ms)} ms</span><span>生成 {formatNumber(timing?.generation_ms)} ms</span><span>{formatNumber(usage?.total_tokens)} tokens</span></div>{config && <div className="result-timing break-words"><span>流水线：{retrievalSummary(config)}</span>{!!memoriesUsed && <span>个性化记忆 {memoriesUsed} 条</span>}</div>}<RecallTrace stages={trace} queries={queries} />{modelSnapshot && <div className="result-timing break-words"><span>本轮模型：{modelSnapshot.name}</span><span>模型 ID：{modelSnapshot.model}</span><span>协议：{modelSnapshot.protocol}</span></div>}{contexts.length > 0 && <><div className="debug-score-list">{contexts.map(context => <div key={`${context.document_id}:${context.id}`}><span>{context.filename} · {context.page ? `第 ${context.page} 页` : '无页码'}</span><span>score {formatNumber(context.score)}</span></div>)}</div><CitationList citations={contexts} label="召回上下文（非引用）" /></>}</details>
}
export function ResultView({ result, retrievalOnly = false }: { result: RagResult; retrievalOnly?: boolean }) {
  return <div className="space-y-4">{result.error && <Notice>{result.error}</Notice>}{result.abstain && <div className="text-sm text-amber-800 bg-amber-50 rounded p-3">证据不足，模型未给出确定回答。</div>}{result.answer ? <Markdown text={result.answer} /> : !retrievalOnly && !result.error ? <Empty title="未返回回答" description="此次调用没有生成回答文本。" /> : null}{retrievalOnly ? <CitationList citations={result.contexts ?? []} label="召回上下文" defaultOpen /> : <CitationList citations={result.citations ?? []} />}<DebugInfo method={result.method} timing={result.timing} usage={result.usage} contexts={result.contexts} trace={result.trace} queries={result.queries} config={result.retrieval_config} /></div>
}

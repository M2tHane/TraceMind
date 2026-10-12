import { isValidElement, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy, FileText } from 'lucide-react'
import { methodLabel, type Citation, type RagResult, type RetrievalConfig, type Timing, type TraceStage, type Usage } from '../lib/types'
import { formatNumber } from '../lib/api'
import type { PublicModelSnapshot } from '../lib/configuration'
import { formatMs } from '../lib/trace'
import { CiteMarker, Drawer, Empty, Notice, Tag } from './ui'
import { PdfCanvas } from './PdfCanvas'
import { RecallTrace, retrievalSummary } from './Retrieval'

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const className = isValidElement<{ className?: string }>(children) ? children.props.className ?? '' : ''
  const language = /language-([\w+-]+)/.exec(className)?.[1] ?? 'text'
  function copy(): void {
    void navigator.clipboard.writeText(ref.current?.textContent ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  }
  return <div className="code-block"><div className="code-block-head"><span>{language}</span><button type="button" onClick={copy} aria-label={copied ? '代码已复制' : '复制代码'}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button></div><pre ref={ref}>{children}</pre></div>
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]} skipHtml components={{ pre: CodeBlock, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="tm-faint">[图片：{alt || '文档图片'}]</span> }}>{text}</ReactMarkdown></div>
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
  if (text === null) return <p className="tm-faint py-2">正在加载原文…</p>
  return markdown ? <Markdown text={text} /> : <pre className="whitespace-pre-wrap break-words leading-6">{text}</pre>
}

/** Plain-text form of a chunk: Markdown markers removed, whitespace collapsed. */
export function plainExcerpt(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/(^|\n)\s*(#{1,6}|>|[-*+]|\d+\.)\s+/g, '$1').replace(/\s+/g, ' ').trim()
}

/** A citation passage, three lines until expanded. */
export function CitationExcerpt({ text, limit = 220 }: { text: string; limit?: number }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const compact = plainExcerpt(text)
  const long = compact.length > limit
  return <div className="excerpt">
    <p id={id} className={expanded ? '' : 'line-clamp-3'}>{expanded || !long ? compact || '该来源未返回文本。' : `${compact.slice(0, limit)}…`}</p>
    {long && <button type="button" className="tm-textlink text-xs mt-1" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(current => !current)}>{expanded ? '收起' : '展开全文'}</button>}
  </div>
}

/** Original document at the cited page, in a drawer over the current page. */
export function SourceDrawer({ source, onClose }: { source: Citation | null; onClose: () => void }) {
  return <Drawer open={!!source} onOpenChange={open => { if (!open) onClose() }} width={640} label={source?.filename}
    leading={<FileText size={15} aria-hidden="true" />} title={<>{source?.filename}{source?.page ? <span className="tm-faint font-normal text-xs ml-2">第 {source.page} 页</span> : null}</>}>
    {source && <><blockquote className="source-quote">{plainExcerpt(source.text)}</blockquote><PdfViewer documentId={source.document_id} page={source.page} filename={source.filename} /></>}
  </Drawer>
}

/** Numbered list of sources (comparison and evaluation results). */
export function CitationList({ citations, label = '引用来源', defaultOpen = false }: { citations: Citation[]; label?: string; defaultOpen?: boolean; compact?: boolean }) {
  const [source, setSource] = useState<Citation | null>(null)
  const distinct = [...new Map(citations.map(c => [`${c.document_id}:${c.id}:${c.page}`, c])).values()]
  return <>
    <details className="citations" open={defaultOpen || undefined}>
      <summary><span>{label}</span><span className="tm-faint tm-num">{distinct.length}</span></summary>
      <div className="citation-list">{distinct.length === 0 ? <p className="tm-faint py-2">没有可验证的引用。</p> : distinct.map((citation, index) => <article key={`${citation.document_id}:${citation.id}:${citation.page}`} className="citation-item">
        <div className="citation-item-head"><CiteMarker n={index + 1} /><button type="button" className="citation-source" onClick={() => setSource(citation)}>{citation.filename}</button>
          <span className="tm-muted">{citation.page ? `第 ${citation.page} 页` : '页码未知'}</span>
          {citation.score != null && <span className="tm-faint tm-num ml-auto text-xs">{citation.score.toFixed(3)}</span>}</div>
        <CitationExcerpt text={citation.text} />
      </article>)}</div>
    </details>
    <SourceDrawer source={source} onClose={() => setSource(null)} />
  </>
}

export function DebugInfo({ method, timing, usage, contexts = [], modelSnapshot, trace = [], queries, config, memoriesUsed }: { method: string; timing?: Timing | null; usage?: Usage | null; contexts?: Citation[]; modelSnapshot?: PublicModelSnapshot | null; trace?: TraceStage[]; queries?: string[]; config?: RetrievalConfig | null; memoriesUsed?: number }) {
  return <details className="debug-details">
    <summary>调试信息</summary>
    <div className="debug-body">
      <p className="result-timing"><span>方法：{methodLabel(method)}</span><span>检索 {formatMs(timing?.retrieval_ms)}</span><span>生成 {formatMs(timing?.generation_ms)}</span><span>{formatNumber(usage?.total_tokens)} tokens</span>{!!memoriesUsed && <span>参考记忆 {memoriesUsed} 条</span>}</p>
      {config && <p className="result-timing break-words"><span>流水线：{retrievalSummary(config)}</span></p>}
      {modelSnapshot && <p className="result-timing break-words"><span>本轮模型：{modelSnapshot.name}</span><span>模型 ID：{modelSnapshot.model}</span><span>协议：{modelSnapshot.protocol}</span></p>}
      <RecallTrace stages={trace} queries={queries} config={config} />
      {contexts.length > 0 && <CitationList citations={contexts} label="召回上下文" />}
    </div>
  </details>
}

export function ResultView({ result, retrievalOnly = false }: { result: RagResult; retrievalOnly?: boolean }) {
  return <div className="space-y-3">
    {result.error && <Notice>{result.error}</Notice>}
    {result.abstain && <Tag tone="warn">依据不足</Tag>}
    {result.answer ? <Markdown text={result.answer} /> : !retrievalOnly && !result.error ? <Empty title="未返回回答" /> : null}
    {retrievalOnly ? <CitationList citations={result.contexts ?? []} label="召回上下文" defaultOpen /> : <CitationList citations={result.citations ?? []} />}
    <DebugInfo method={result.method} timing={result.timing} usage={result.usage} contexts={result.contexts} trace={result.trace} queries={result.queries} config={result.retrieval_config} />
  </div>
}

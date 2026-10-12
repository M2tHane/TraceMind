import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import type { Citation, Message } from '../lib/types'
import { useStoredState } from '../lib/storage'
import { distinctCitations } from './ChatMessage'
import { CitationExcerpt, plainExcerpt, SourceDrawer } from './sources'
import { TraceView } from './TraceView'
import { buttonClass, CiteMarker, CollapsedPanel, PanelToggle, ResizeHandle } from './ui'

export type EvidenceTab = 'cites' | 'trace'

function EvidenceCard({ citation, index, selected, onSelect, kbId, scoreName, onOpenSource }: {
  citation: Citation; index: number; selected: boolean; onSelect: () => void; kbId?: string; scoreName: string; onOpenSource: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  const mounted = useRef(false)
  // Bring a newly selected card into view inside the pane only (never scroll the window).
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    const card = ref.current
    const scroller = card?.closest<HTMLElement>('.evidence-body')
    if (!selected || !card || !scroller || scroller.scrollHeight <= scroller.clientHeight) return
    const top = card.offsetTop - scroller.offsetTop
    if (top < scroller.scrollTop || top + card.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTo({ top: Math.max(0, top - 12), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [selected])
  const page = citation.page ? `第 ${citation.page} 页` : '页码未知'
  function copy(): void {
    void navigator.clipboard.writeText(`${plainExcerpt(citation.text)}\n——${citation.filename}，${page}`).then(() => toast.success('引文已复制'), () => toast.error('复制失败，请手动选择文本'))
  }
  return <article ref={ref} className="citation-item evidence-card" data-selected={selected || undefined} aria-current={selected || undefined}>
    <header onClick={selected ? undefined : onSelect}>
      <CiteMarker n={index + 1} active={selected} label={`选中引用 ${index + 1}`} onClick={onSelect} />
      <button type="button" className="citation-source" onClick={onOpenSource} title="在当前页查看原文">{citation.filename}</button>
      <span className="tm-muted tm-nowrap">{page}</span>
      <span className="flex-1" />
      {citation.score != null && <span className="tm-faint tm-num text-xs tm-nowrap">{scoreName} {citation.score.toFixed(3)}</span>}
    </header>
    {selected ? <>
      <div className="evidence-card-body"><CitationExcerpt text={citation.text} /></div>
      <footer>
        {kbId && <Link className={buttonClass('secondary', 'sm')} to={`/knowledge/${kbId}/documents/${citation.document_id}?${new URLSearchParams({ ...(citation.page ? { page: String(citation.page) } : {}), chunk: citation.id })}`}>
          <ExternalLink size={13} aria-hidden="true" />打开原文{citation.page ? `第 ${citation.page} 页` : ''}</Link>}
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={copy}>复制引文</button>
      </footer>
    </> : <p className="evidence-card-summary" onClick={onSelect}>{plainExcerpt(citation.text)}</p>}
  </article>
}

/** Right-hand pane of the chat: the evidence, recall chain and memories behind one answer. */
export function EvidencePane({ message, answerNumber, question, tab, onTab, citation, onCitation, kbId, canCompare }: {
  message?: Message; answerNumber: number; question?: string; tab: EvidenceTab; onTab: (tab: EvidenceTab) => void
  citation: number; onCitation: (index: number) => void; kbId?: string; canCompare: boolean
}) {
  const [open, setOpen] = useStoredState('tm.chat.pane-open', true)
  const [citeWidth, setCiteWidth] = useStoredState('tm.chat.pane-width', 400)
  const [traceWidth, setTraceWidth] = useStoredState('tm.chat.trace-width', 640)
  const [source, setSource] = useState<Citation | null>(null)
  if (!open) return <CollapsedPanel side="right" name="右侧面板" onToggle={() => setOpen(true)} className="evidence-pane evidence-pane-collapsed" />
  const trace = tab === 'trace'
  const width = trace ? traceWidth : citeWidth
  const citations = distinctCitations(message?.citations ?? [])
  const cited = new Set(citations.map(c => c.id))
  const uncited = (message?.contexts ?? []).filter(context => !cited.has(context.id))
  const scoreName = message?.retrieval_trace?.config?.rerank === false ? '分数' : '重排分'
  const tabs: { value: EvidenceTab; label: string; count?: number }[] = [
    { value: 'cites', label: '引用', count: citations.length }, { value: 'trace', label: '召回链路' },
  ]
  return <aside id="evidence-pane" className="evidence-pane" style={{ flexBasis: width, width }} aria-label="回答依据">
    <ResizeHandle edge="left" value={width} min={320} max={trace ? 680 : 560} onChange={trace ? setTraceWidth : setCiteWidth} label="拖动调整右侧面板宽度" />
    <div className="tm-panel-header evidence-head">
      <div className="tm-tabs evidence-tabs" role="tablist" aria-label="回答依据">
        {tabs.map(item => <button key={item.value} type="button" role="tab" id={`evidence-tab-${item.value}`} aria-selected={tab === item.value} aria-controls="evidence-panel" className="tm-tab" onClick={() => onTab(item.value)}>
          {item.label}{item.count !== undefined && <span className="tm-tab-count">{item.count}</span>}</button>)}
      </div>
      <PanelToggle side="right" expanded onToggle={() => setOpen(false)} name="右侧面板" />
    </div>
    <div id="evidence-panel" role="tabpanel" aria-labelledby={`evidence-tab-${tab}`} className="evidence-body">
      {!message ? <p className="tm-faint">暂无回答</p> : tab === 'cites' ? <>
        <p className="evidence-caption">第 {answerNumber} 个回答的依据</p>
        {citations.length === 0 ? <p className="tm-faint">这个回答没有引用</p>
          : <div className="evidence-cards">{citations.map((item, index) => <EvidenceCard key={`${item.document_id}:${item.id}`} citation={item} index={index} selected={index === citation}
            onSelect={() => onCitation(index)} kbId={kbId} scoreName={scoreName} onOpenSource={() => setSource(item)} />)}</div>}
        {uncited.length > 0 && <section className="evidence-uncited" aria-label="召回但未引用">
          <h3>召回但未引用<span className="tm-faint tm-num">{uncited.length}</span></h3>
          <ul>{uncited.map(item => <li key={`${item.document_id}:${item.id}`}>
            <button type="button" className="evidence-uncited-text" onClick={() => setSource(item)}>{plainExcerpt(item.text) || item.filename}</button>
            <span className="tm-faint tm-num">{item.score != null ? item.score.toFixed(3) : ''}</span>
            <span className="tm-faint">{item.filename}{item.page ? ` 第 ${item.page} 页` : ''}</span>
          </li>)}</ul>
        </section>}
      </> : <TraceView stages={message.retrieval_trace?.stages ?? []} queries={message.retrieval_trace?.queries} config={message.retrieval_trace?.config}
        selectedId={citations[citation]?.id} kbId={kbId} question={question} canCompare={canCompare} />}
    </div>
    <SourceDrawer source={source} onClose={() => setSource(null)} />
  </aside>
}

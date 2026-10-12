import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import type { Citation, Message } from '../lib/types'
import { useStoredState } from '../lib/storage'
import { distinctCitations } from './ChatMessage'
import { CitationExcerpt, plainExcerpt, SourceDrawer } from './sources'
import { TraceView } from './TraceView'
import { buttonClass, CiteMarker, CollapsedPanel, PanelToggle, ResizeHandle } from './ui'

export type EvidenceTab = 'cites' | 'trace'

function EvidenceCard({ citation, index, selected, onSelect, kbId, scoreName, onOpenSource, backTo }: {
  citation: Citation; index: number; selected: boolean; onSelect: () => void; kbId?: string; scoreName: string; onOpenSource: () => void; backTo?: string
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
        {kbId && <Link className={buttonClass('secondary', 'sm')} to={`/knowledge/${kbId}/documents/${citation.document_id}?${new URLSearchParams({ ...(citation.page ? { page: String(citation.page) } : {}), chunk: citation.id, ...(backTo ? { from: backTo } : {}) })}`}>
          <ExternalLink size={13} aria-hidden="true" />打开原文{citation.page ? `第 ${citation.page} 页` : ''}</Link>}
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={copy}>复制引文</button>
      </footer>
    </> : <p className="evidence-card-summary" onClick={onSelect}>{plainExcerpt(citation.text)}</p>}
  </article>
}

/** One answered question the pane can show. */
export interface AnswerChoice { id: string; question: string }

/** Picks which answer the pane explains; the list spans the whole pane header. */
function PaneHeader({ answers, value, onChange, tabs, toggle }: { answers: AnswerChoice[]; value?: string; onChange: (id: string) => void; tabs: ReactNode; toggle: ReactNode }) {
  const [open, setOpen] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const index = Math.max(0, answers.findIndex(answer => answer.id === value))
  const current = answers[index]
  function move(event: KeyboardEvent<HTMLDivElement>): void {
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    const at = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null
    if (next === null) return
    event.preventDefault()
    options[Math.min(options.length - 1, Math.max(0, next))]?.focus()
  }
  if (!current) return <div className="tm-panel-header evidence-head">{tabs}<span className="flex-1" />{toggle}</div>
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Anchor asChild><div className="tm-panel-header evidence-head">{tabs}
    <Popover.Trigger asChild>
      <button type="button" className="evidence-question" aria-label={`选择问题，当前第 ${index + 1} 个：${current.question}`} aria-haspopup="listbox" aria-expanded={open}>
        <span className="evidence-question-no tm-num">问题 {index + 1}</span>
        <span className="evidence-question-text">{current.question}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    {toggle}</div></Popover.Anchor>
    <Popover.Portal>
      <Popover.Content className="tm-pop evidence-question-pop" align="start" sideOffset={0} collisionPadding={0}
        onOpenAutoFocus={event => { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus() }}>
        <div ref={list} role="listbox" aria-label="选择问题" onKeyDown={move}>
          {answers.map((answer, position) => <button key={answer.id} type="button" role="option" aria-selected={answer.id === current.id} className="evidence-question-option"
            onClick={() => { onChange(answer.id); setOpen(false) }}>
            <span className="evidence-question-no tm-num">问题 {position + 1}</span>
            <span className="evidence-question-text">{answer.question}</span>
            {answer.id === current.id && <Check size={14} aria-hidden="true" />}
          </button>)}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

/** Right-hand pane of the chat: the evidence, recall chain and memories behind one answer. */
export function EvidencePane({ message, question, tab, onTab, citation, onCitation, kbId, canCompare, open, onOpenChange, answers, onAnswer, backTo }: {
  message?: Message; question?: string; tab: EvidenceTab; onTab: (tab: EvidenceTab) => void
  citation: number; onCitation: (index: number) => void; kbId?: string; canCompare: boolean
  open: boolean; onOpenChange: (open: boolean) => void; answers: AnswerChoice[]; onAnswer: (id: string) => void; backTo?: string
}) {
  const [citeWidth, setCiteWidth] = useStoredState('tm.chat.pane-width', 400)
  const [traceWidth, setTraceWidth] = useStoredState('tm.chat.trace-width', 640)
  const [source, setSource] = useState<Citation | null>(null)
  if (!open) return <CollapsedPanel side="right" name="右侧面板" onToggle={() => onOpenChange(true)} className="evidence-pane evidence-pane-collapsed" />
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
    <PaneHeader answers={answers} value={message?.id} onChange={onAnswer}
      tabs={<div className="tm-tabs evidence-tabs" role="tablist" aria-label="回答依据">
        {tabs.map(item => <button key={item.value} type="button" role="tab" id={`evidence-tab-${item.value}`} aria-selected={tab === item.value} aria-controls="evidence-panel" className="tm-tab" onClick={() => onTab(item.value)}>
          {item.label}{item.count !== undefined && <span className="tm-tab-count">{item.count}</span>}</button>)}
      </div>}
      toggle={<PanelToggle side="right" expanded onToggle={() => onOpenChange(false)} name="右侧面板" />} />
    <div id="evidence-panel" role="tabpanel" aria-labelledby={`evidence-tab-${tab}`} className="evidence-body">
      {!message ? <p className="tm-faint">暂无回答</p> : tab === 'cites' ? <>
        {citations.length === 0 ? <p className="tm-faint">这个回答没有引用</p>
          : <div className="evidence-cards">{citations.map((item, index) => <EvidenceCard key={`${item.document_id}:${item.id}`} citation={item} index={index} selected={index === citation}
            onSelect={() => onCitation(index)} kbId={kbId} scoreName={scoreName} onOpenSource={() => setSource(item)} backTo={backTo} />)}</div>}
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

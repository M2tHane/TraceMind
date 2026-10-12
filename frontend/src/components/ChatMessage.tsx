import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import type { Citation, Message } from '../lib/types'
import { formatNumber } from '../lib/api'
import { formatMs } from '../lib/trace'
import { markedCitations, stripMarkers } from '../lib/citeMarkers'
import { Markdown } from './sources'
import { CiteMarker, ErrorState } from './ui'

export function distinctCitations(citations: Citation[]): Citation[] {
  return [...new Map(citations.map(c => [`${c.document_id}:${c.id}:${c.page}`, c])).values()]
}

function MessageTime({ value }: { value: string }) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const today = new Date().toDateString() === date.toDateString()
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return <time className="message-time" dateTime={value} title={date.toLocaleString('zh-CN')}>{today ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`}</time>
}

// Message.stage only distinguishes retrieving from generating; the three retrieval steps move together.
const STEPS = ['范围过滤', '召回', '重排', '生成']
const STAGE_TEXT: Record<string, string> = { queued: '排队中', retrieving: '正在检索相关片段', generating: '正在生成回答' }
function Pending({ message }: { message: Message }) {
  const stage = message.status === 'queued' ? 'queued' : message.stage
  const state = (index: number) => stage === 'generating' ? (index < 3 ? 'done' : 'now') : stage === 'retrieving' ? (index < 3 ? 'now' : 'todo') : 'todo'
  return <div className="pending-answer" role="status">
    <ol aria-label="处理进度">{STEPS.map((label, index) => <li key={label} data-step={state(index)}><span aria-hidden="true" />{label}</li>)}</ol>
    <p>{STAGE_TEXT[stage] ?? '正在处理'}</p>
  </div>
}

export interface MessageEvidence { active: boolean; citation: number; onCite: (index: number) => void; onSources: () => void; onTrace: () => void }

export function ChatMessage({ message, evidence }: { message: Message; evidence?: MessageEvidence }) {
  const [copied, setCopied] = useState(false)
  const assistant = message.role === 'assistant'
  const citations = distinctCitations(message.citations ?? [])
  // Citations the model placed after a sentence render inline; the rest stay at the end of the answer.
  const placed = markedCitations(message.content)
  const unplaced = citations.map((citation, index) => ({ citation, index })).filter(({ index }) => !placed.has(index + 1))
  const citeLabel = (index: number) => {
    const citation = citations[index]
    return citation ? `引用 ${index + 1}：${citation.filename}${citation.page ? ` 第 ${citation.page} 页` : ''}` : `引用 ${index + 1}`
  }
  async function copyAnswer(): Promise<void> {
    try {
      await navigator.clipboard.writeText(stripMarkers(message.content))
      setCopied(true)
      toast.success('回答已复制')
    } catch {
      toast.error('复制失败，请选中回答文本后复制')
    }
  }
  if (!assistant) return <article className="message message-user">
    <div className="message-body"><span className="sr-only">你</span><p className="user-content">{message.content}</p><MessageTime value={message.created_at} /></div>
  </article>
  const pending = ['queued', 'processing'].includes(message.status)
  const snapshot = message.model_snapshot
  return <article className="message message-assistant" data-active={evidence?.active || undefined}>
    <div className="message-body">
      <span className="sr-only">回答</span>
      {pending ? <Pending message={message} />
        : message.status === 'failed' ? <ErrorState error={new Error(message.error || '生成失败，请检查服务配置后重新提问。')} />
          : message.content && <div className="assistant-bubble">
            {unplaced.length > 0 && <p className="answer-cites">{unplaced.map(({ citation, index }) =>
              <CiteMarker key={`${citation.document_id}:${citation.id}`} n={index + 1} active={!!evidence?.active && evidence.citation === index}
                label={citeLabel(index)} onClick={evidence ? () => evidence.onCite(index) : undefined} />)}</p>}
            <Markdown text={message.content} cite={{
              active: evidence?.active ? evidence.citation + 1 : undefined, label: n => citeLabel(n - 1),
              onCite: evidence ? n => { if (citations[n - 1]) evidence.onCite(n - 1) } : undefined,
            }} />
          </div>}
      {message.status === 'completed' && <div className="message-support">
        <MessageTime value={message.created_at} />
        <button type="button" className="message-meta-link" aria-label={`引用来源，${citations.length} 条`} onClick={evidence?.onSources}>引用 {citations.length} 处</button>
        {message.timing?.retrieval_ms != null && <span className="tm-num">召回 {formatMs(message.timing.retrieval_ms)}</span>}
        {message.timing?.generation_ms != null && <span className="tm-num">生成 {formatMs(message.timing.generation_ms)}</span>}
        {!!message.retrieval_trace?.stages?.length && <button type="button" className="tm-textlink" onClick={evidence?.onTrace}>召回链路</button>}
        {snapshot && <details className="debug-details message-model">
          <summary>{snapshot.name}</summary>
          <div className="message-model-pop">
            <p>本轮模型：{snapshot.name}</p><p>模型 ID：{snapshot.model}</p><p>协议：{snapshot.protocol}</p>
            {message.usage?.total_tokens != null && <p className="tm-faint">{formatNumber(message.usage.total_tokens)} tokens</p>}
          </div>
        </details>}
        {message.content && <button type="button" className="tm-btn tm-btn-icon message-copy" aria-label={copied ? '再次复制回答' : '复制回答'} title="复制回答" onClick={() => { void copyAnswer() }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>}
      </div>}
    </div>
  </article>
}

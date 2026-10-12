import { useState } from 'react'
import { Check, Copy, MessageSquare, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import type { Message } from '../lib/types'
import { CitationList, DebugInfo, Markdown } from './sources'
import { ErrorState, Status, statusLabel } from './ui'

function MessageTime({ value }: { value: string }) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return <time className="message-time" dateTime={value} title={date.toLocaleString('zh-CN')}>{date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
}

export function ChatMessage({ message }: { message: Message }) {
  const [copied, setCopied] = useState(false)
  const assistant = message.role === 'assistant'
  async function copyAnswer(): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      toast.success('回答已复制')
    } catch {
      toast.error('复制失败，请选中回答文本后复制')
    }
  }
  return <article className={`message message-${message.role}`}>
    <div className="chat-avatar" aria-hidden="true">{assistant ? <MessageSquare size={22} strokeWidth={1.8} /> : <UserRound size={22} strokeWidth={1.8} />}</div>
    <div className="message-body">
      <span className="sr-only">{assistant ? '回答' : '你'}</span>
      {!assistant ? <><p className="user-content">{message.content}</p><MessageTime value={message.created_at} /></> : <>
        {message.content && <div className="assistant-bubble"><Markdown text={message.content} /></div>}
        {['queued', 'processing'].includes(message.status) && <div className="pending-answer"><Status value={message.status} /><span>{statusLabel(message.stage || message.status)}，请稍候。</span></div>}
        {message.status === 'failed' && <ErrorState error={new Error(message.error || '生成失败，请检查服务配置后重新提问。')} />}
        {message.status === 'completed' && <>
          <div className="message-support">
            <CitationList citations={message.citations ?? []} compact />
            {message.content && <button type="button" className="message-copy" aria-label={copied ? '再次复制回答' : '复制回答'} onClick={() => { void copyAnswer() }}>{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? '已复制' : '复制'}</span></button>}
          </div>
          <div className="message-meta"><MessageTime value={message.created_at} /><DebugInfo method={message.method} timing={message.timing} usage={message.usage} contexts={message.contexts} modelSnapshot={message.model_snapshot} trace={message.retrieval_trace?.stages} queries={message.retrieval_trace?.queries} config={message.retrieval_trace?.config} memoriesUsed={message.retrieval_trace?.memories_used} /></div>
        </>}
      </>}
    </div>
  </article>
}

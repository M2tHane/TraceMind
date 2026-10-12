import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowRight, ArrowUp, BookOpen, FileText, MessageSquare, Plus, Search, Settings2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { post, useAction, useApi } from '../lib/api'
import { METHODS, type Conversation, type KnowledgeBase, type Message, type Method } from '../lib/types'
import { Button, Empty, ErrorState, Field, Loading, Notice } from '../components/ui'
import { ChatMessage } from '../components/ChatMessage'
import { Select } from '../components/Select'
import type { ModelProfile } from '../lib/configuration'
import { useIsAdmin } from '../lib/auth'
import { useSidebar } from '../components/SidebarContext'

const starters = [
  { icon: FileText, label: '总结主要内容', prompt: '请概括知识库资料的主要内容，并列出引用来源。' },
  { icon: BookOpen, label: '梳理关键概念', prompt: '资料中有哪些关键概念？请结合原文解释，并列出引用来源。' },
  { icon: Search, label: '查找具体依据', prompt: '请帮我查找资料中关于「」的内容，并提供原文依据。' },
]

function ChatLanding({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <section className="chat-landing" aria-label="开始知识库问答">
    <div className="chat-landing-mark" aria-hidden="true"><MessageSquare size={34} strokeWidth={1.6} /></div>
    <h2>基于知识库的问答助手</h2>
    <p>从你的资料出发，提问、梳理思路、查找依据。<br />回答下方可展开引用，回到原文核对。</p>
    <div className="chat-starters">{starters.map(({ icon: Icon, label, prompt }) => <button key={label} type="button" onClick={() => onPrompt(prompt)}><span className="starter-icon"><Icon size={21} strokeWidth={1.7} /></span><span>{label}</span><ArrowRight size={17} className="starter-arrow" /></button>)}</div>
  </section>
}

interface SendInput { content: string; kbId: string; conversationId?: string; method: Method; top_k: number; candidate_k: number; model_profile_id: string }
export function ChatPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases', { poll: 15000 })
  const conversations = useApi<Conversation[]>('/conversations')
  const profiles = useApi<ModelProfile[]>('/model-profiles')
  const admin = useIsAdmin()
  const [selectedModelId, setSelectedModelId] = useState('')
  const enabledModels = profiles.data?.filter(profile => profile.enabled) ?? []
  const selectedModel = selectedModelId ? enabledModels.find(profile => profile.id === selectedModelId) : enabledModels.find(profile => profile.is_default) ?? enabledModels[0]
  const active = conversations.data?.find(conversation => conversation.id === id)
  const kbId = id ? active?.knowledge_base_id ?? '' : params.get('kb') ?? kbs.data?.[0]?.id ?? ''
  const kb = kbs.data?.find(item => item.id === kbId)
  const messages = useApi<Message[]>(`/conversations/${id}/messages`, { enabled: !!id, poll: 2000 })
  const [text, setText] = useState('')
  const [method, setMethod] = useState<Method>('hybrid_rerank')
  const [topK, setTopK] = useState(5)
  const [candidateK, setCandidateK] = useState(20)
  const [advanced, setAdvanced] = useState(false)
  const { sidebarOpen, toggleSidebar } = useSidebar()
  const bottom = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const pending = messages.data?.some(message => ['queued', 'processing'].includes(message.status)) ?? false
  const send = useAction(async (input: SendInput) => {
    const conversationId = input.conversationId ?? (await post<Conversation>('/conversations', { knowledge_base_id: input.kbId, title: input.content.slice(0, 60) })).id
    try {
      const message = await post<Message>(`/conversations/${conversationId}/messages`, { content: input.content, method: input.method, top_k: input.top_k, candidate_k: input.candidate_k, model_profile_id: input.model_profile_id })
      return { conversationId, message }
    } finally { void client.invalidateQueries({ queryKey: ['/conversations'] }) }
  }, { onSuccess: ({ conversationId }) => { setText(''); void client.invalidateQueries({ queryKey: [`/conversations/${conversationId}/messages`] }); if (conversationId !== id) navigate(`/chat/${conversationId}`) } })
  const last = messages.data?.at(-1)
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'end' }) }, [last?.id, last?.status, id])
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!text.trim() || !kbId || pending || send.isPending || !selectedModel || profiles.isError) return
    send.mutate({ content: text.trim(), kbId, conversationId: id, method, top_k: topK, candidate_k: Math.max(topK, candidateK), model_profile_id: selectedModel.id })
  }
  return <div className="chat-layout">
    <section className="chat-main">
      <header className="chat-header">
        <div className="chat-heading-group"><button className="icon-button chat-header-icon" title={sidebarOpen ? '隐藏对话历史' : '展开对话历史'} aria-label={sidebarOpen ? '隐藏对话历史' : '展开对话历史'} aria-expanded={sidebarOpen} onClick={toggleSidebar}><MessageSquare size={23} strokeWidth={1.8} /></button><h1>知识问答</h1><Select label="选择知识库" className="kb-select" placeholder="选择知识库" value={kbId} disabled={send.isPending || kbs.isPending} options={(kbs.data ?? []).map(item => ({ value: item.id, label: item.name }))} onChange={value => { navigate(`/chat?kb=${value}`); setText('') }} /></div>
      </header>
      <div className="chat-stage">
      <div className="chat-scroll">
        {kbs.isError && <ErrorState error={kbs.error} retry={() => { void kbs.refetch() }} />}
        {!kbs.isPending && !kbs.isError && !kbs.data?.length ? <Empty title="创建知识库后开始问答" description="上传 PDF 并完成解析后，即可提问并查看引用。" action={<Link className="btn btn-primary" to="/knowledge"><Plus size={16} />创建知识库</Link>} /> : id && messages.isPending ? <Loading label="正在读取对话…" /> : id && messages.isError ? <ErrorState error={messages.error} retry={() => { void messages.refetch() }} /> : !messages.data?.length || !id ? <ChatLanding onPrompt={prompt => { setText(prompt); input.current?.focus() }} /> : <div className="messages">{messages.data.map(message => <ChatMessage key={message.id} message={message} />)}</div>}
        <div ref={bottom} />
      </div>
      <div className="composer-area">
        {kb && kb.ready_count === 0 && method !== 'no_context' && <Notice>当前知识库没有已就绪文档。请先上传并完成处理。</Notice>}
        {send.error && <ErrorState error={send.error} />}
        {profiles.isError && <ErrorState error={profiles.error} retry={() => { void profiles.refetch() }} />}
        {!profiles.isPending && !profiles.isError && !selectedModel && <Notice>{enabledModels.length ? '所选模型已不可用，请重新选择。' : <>没有已启用的对话模型。{admin ? <Link className="text-link" to="/settings">前往设置</Link> : '请联系管理员配置。'}</>}</Notice>}
        <form className="composer" onSubmit={handleSubmit}>
          <textarea ref={input} aria-label="输入问题" value={text} onChange={e => setText(e.target.value)} placeholder={kb ? '输入问题…' : '先选择知识库'} rows={2} disabled={!kbId || send.isPending || pending} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} />
          <div className="composer-footer"><div className="composer-tools"><Select label="选择对话模型" className="model-select" contentClassName="model-select-content" value={selectedModel?.id ?? ''} placeholder={profiles.isPending ? '加载模型…' : '选择模型'} disabled={profiles.isPending || profiles.isError || !enabledModels.length || send.isPending} options={enabledModels.map(profile => ({ value: profile.id, label: profile.name }))} onChange={setSelectedModelId} /><button className="retrieval-settings-button" type="button" aria-expanded={advanced} onClick={() => setAdvanced(open => !open)}><Settings2 size={15} />检索设置</button></div><Button type="submit" aria-label="发送问题" busy={send.isPending} disabled={!text.trim() || !kbId || pending || !selectedModel || profiles.isError || !!(kb && kb.ready_count === 0 && method !== 'no_context')} className="send-button">{!send.isPending && <ArrowUp size={19} />}</Button></div>
          {advanced && <div className="composer-settings"><Field label="检索方法"><Select label="检索方法" value={method} onChange={value => setMethod(value as Method)} options={METHODS.map(item => ({ value: item.value, label: item.label }))} /></Field><Field label="引用数量 top_k"><input type="number" min={1} max={20} value={topK} onChange={e => setTopK(Number(e.target.value))} required /></Field><Field label="候选数量"><input type="number" min={topK} max={100} value={candidateK} onChange={e => setCandidateK(Number(e.target.value))} required /></Field></div>}
        </form>
      </div>
      </div>
    </section>
  </div>
}

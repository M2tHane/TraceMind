import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowUp, BookOpen, FileText, Search, SlidersHorizontal } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { useQueryClient } from '@tanstack/react-query'
import { post, useAction, useApi } from '../lib/api'
import { DEFAULT_RETRIEVAL, METHODS, methodLabel, type Conversation, type Document, type KnowledgeBase, type Message, type Method, type RetrievalConfig } from '../lib/types'
import type { ModelProfile } from '../lib/configuration'
import { configForMethod } from '../lib/trace'
import { useAuth } from '../lib/auth'
import { useStoredState } from '../lib/storage'
import { Button, buttonClass, Empty, ErrorState, Field, Loading, Notice, ScopeTag, SearchableSelect } from '../components/ui'
import { ChatMessage } from '../components/ChatMessage'
import { ChatSidebar } from '../components/ChatSidebar'
import { EvidencePane, type EvidenceTab } from '../components/EvidencePane'
import { Select } from '../components/Select'

const starters = [
  { icon: FileText, label: '总结主要内容', prompt: '请概括知识库资料的主要内容，并列出引用来源。' },
  { icon: BookOpen, label: '梳理关键概念', prompt: '资料中有哪些关键概念？请结合原文解释，并列出引用来源。' },
  { icon: Search, label: '查找具体依据', prompt: '请帮我查找资料中关于「」的内容，并提供原文依据。' },
]

function ChatLanding({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <section className="chat-landing" aria-label="开始知识库问答">
    <h2>基于知识库的问答助手</h2>
    <div className="chat-starters">{starters.map(({ icon: Icon, label, prompt }) => <button key={label} type="button" onClick={() => onPrompt(prompt)}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>)}</div>
  </section>
}

function KnowledgePicker({ kbs, value, disabled, onChange }: { kbs: KnowledgeBase[]; value?: KnowledgeBase; disabled: boolean; onChange: (id: string) => void }) {
  return <SearchableSelect combobox label="选择知识库" disabled={disabled} width={320} value={value?.id ?? ''} onChange={onChange} triggerClassName="kb-picker"
    trigger={value ? <><BookOpen size={15} aria-hidden="true" /><span className="font-semibold truncate">{value.name}</span><ScopeTag scope={value.scope} /></> : <span className="tm-faint">选择知识库</span>}
    options={kbs.map(kb => ({ value: kb.id, label: kb.name, group: kb.scope === 'platform' ? '平台' : '我的', hint: `${kb.ready_count} 份` }))} />
}

interface SendInput { content: string; kbId: string; conversationId?: string; method: Method; top_k: number; candidate_k: number; model_profile_id: string; retrieval?: RetrievalConfig }
export function ChatPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { user } = useAuth()
  const admin = user?.role === 'admin'
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases', { poll: 15000 })
  const conversations = useApi<Conversation[]>('/conversations')
  const profiles = useApi<ModelProfile[]>('/model-profiles')
  const [selectedModelId, setSelectedModelId] = useState('')
  const enabledModels = profiles.data?.filter(profile => profile.enabled) ?? []
  const selectedModel = selectedModelId ? enabledModels.find(profile => profile.id === selectedModelId) : enabledModels.find(profile => profile.is_default) ?? enabledModels[0]
  const active = conversations.data?.find(conversation => conversation.id === id)
  const kbId = id ? active?.knowledge_base_id ?? '' : params.get('kb') ?? kbs.data?.[0]?.id ?? ''
  const kb = kbs.data?.find(item => item.id === kbId)
  // Poll only while an answer is queued or being generated.
  const messages = useApi<Message[]>(`/conversations/${id}/messages`, { enabled: !!id, poll: data => data?.some(message => ['queued', 'processing'].includes(message.status)) ? 2000 : false })
  const [text, setText] = useState('')
  const [method, setMethod] = useState<Method>('hybrid_rerank')
  const [topK, setTopK] = useState(5)
  const [candidateK, setCandidateK] = useState(20)
  const [documentIds, setDocumentIds] = useState<string[]>([])
  const [docsWanted, setDocsWanted] = useState(false)
  const documents = useApi<Document[]>(`/knowledge-bases/${kbId}/documents`, { enabled: !!kbId && docsWanted })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<EvidenceTab>('cites')
  const [citation, setCitation] = useState(0)
  const [paneOpen, setPaneOpen] = useStoredState('tm.chat.pane-open', true)
  const bottom = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const pending = messages.data?.some(message => ['queued', 'processing'].includes(message.status)) ?? false
  useEffect(() => { setDocumentIds([]) }, [kbId])
  useEffect(() => { setActiveId(null); setCitation(0) }, [id])

  const send = useAction(async (input: SendInput) => {
    const conversationId = input.conversationId ?? (await post<Conversation>('/conversations', { knowledge_base_id: input.kbId, title: input.content.slice(0, 60) })).id
    try {
      const message = await post<Message>(`/conversations/${conversationId}/messages`, { content: input.content, method: input.method, top_k: input.top_k, candidate_k: input.candidate_k, model_profile_id: input.model_profile_id, ...(input.retrieval ? { retrieval: input.retrieval } : {}) })
      return { conversationId, message }
    } finally { void client.invalidateQueries({ queryKey: ['/conversations'] }) }
  }, { onSuccess: ({ conversationId }) => { setText(''); setActiveId(null); void client.invalidateQueries({ queryKey: [`/conversations/${conversationId}/messages`] }); if (conversationId !== id) navigate(`/chat/${conversationId}`) } })
  const last = messages.data?.at(-1)
  // Scroll the conversation only; scrollIntoView would also move the window when panes stack.
  useEffect(() => {
    const scroller = bottom.current?.parentElement
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [last?.id, last?.status, id])

  // Answered questions the pane can explain; it shows the first until the user picks another.
  const answered = useMemo(() => (messages.data ?? []).flatMap((message, index, all) => message.role === 'assistant' && message.status === 'completed'
    ? [{ message, question: all[index - 1]?.role === 'user' ? all[index - 1].content : '' }] : []), [messages.data])
  const shownEntry = (id && answered.find(entry => entry.message.id === activeId)) || answered[0]
  const shown = shownEntry?.message
  const question = shownEntry?.question || undefined
  function focusPane(message: Message, nextTab: EvidenceTab, index = 0): void {
    setActiveId(message.id); setTab(nextTab); setCitation(index); setPaneOpen(true)
    if (window.matchMedia('(max-width: 1099px)').matches) requestAnimationFrame(() => document.getElementById('evidence-pane')?.scrollIntoView({ block: 'start' }))
  }

  const restrictable = method !== 'no_context'
  function retrievalFor(): RetrievalConfig | undefined {
    if (!restrictable || !documentIds.length) return undefined
    const base = method === 'hybrid_rerank' && kb?.retrieval_config ? { ...DEFAULT_RETRIEVAL, ...kb.retrieval_config, top_k: topK } : configForMethod(method, topK, Math.max(topK, candidateK))
    return { ...base, document_ids: documentIds }
  }
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!text.trim() || !kbId || pending || send.isPending || !selectedModel || profiles.isError) return
    send.mutate({ content: text.trim(), kbId, conversationId: id, method, top_k: topK, candidate_k: Math.max(topK, candidateK), model_profile_id: selectedModel.id, retrieval: retrievalFor() })
  }
  const readyDocs = (documents.data ?? []).filter(doc => doc.status === 'ready')
  const hasMessages = !!id && !!messages.data?.length
  const initial = (user?.display_name || user?.username || '我').slice(0, 1)

  return <>
    <ChatSidebar kbId={kbId} />
    <main id="main-content" className="tm-main chat-layout">
      <header className="tm-top chat-header">
        <div className="chat-heading-group">{kbs.data?.length ? <KnowledgePicker kbs={kbs.data} value={kb} disabled={send.isPending} onChange={value => { navigate(`/chat?kb=${value}`); setText('') }} /> : null}</div>
      </header>
      <div className="chat-scroll">
        {kbs.isError && <ErrorState error={kbs.error} retry={() => { void kbs.refetch() }} />}
        {!kbs.isPending && !kbs.isError && !kbs.data?.length ? <Empty title="创建知识库后开始问答" action={<Link className={buttonClass('primary')} to="/knowledge">创建知识库</Link>} />
          : id && messages.isPending ? <Loading label="正在读取对话…" />
            : id && messages.isError ? <ErrorState error={messages.error} retry={() => { void messages.refetch() }} />
              : !hasMessages ? <ChatLanding onPrompt={prompt => { setText(prompt); input.current?.focus() }} />
                : <div className="messages">{messages.data!.map(message => <ChatMessage key={message.id} message={message} initial={initial}
                  evidence={message.role === 'assistant' ? {
                    active: message.id === shown?.id, citation,
                    onCite: index => focusPane(message, 'cites', index), onSources: () => focusPane(message, 'cites', message.id === shown?.id ? citation : 0), onTrace: () => focusPane(message, 'trace'),
                  } : undefined} />)}</div>}
        <div ref={bottom} />
      </div>
      <div className="composer-area">
        {kb && kb.ready_count === 0 && method !== 'no_context' && <Notice>当前知识库没有已就绪文档，请先上传并完成处理。</Notice>}
        {send.error && <ErrorState error={send.error} />}
        {profiles.isError && <ErrorState error={profiles.error} retry={() => { void profiles.refetch() }} />}
        {!profiles.isPending && !profiles.isError && !selectedModel && <Notice>{enabledModels.length ? '所选模型已不可用，请重新选择。' : <>没有已启用的对话模型。{admin ? <Link className="tm-textlink" to="/settings/models">前往设置</Link> : '请联系管理员配置。'}</>}</Notice>}
        <form className="composer" onSubmit={handleSubmit} aria-label="提问">
          <textarea ref={input} aria-label="输入问题" value={text} onChange={e => setText(e.target.value)} placeholder={!kb ? '先选择知识库' : hasMessages ? '继续追问，或换个问题' : '输入问题'} rows={2} disabled={!kbId || send.isPending || pending}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} />
          <div className="composer-footer">
            <div className="composer-tools">
              <Select label="选择对话模型" className="model-select" contentClassName="model-select-content" value={selectedModel?.id ?? ''} placeholder={profiles.isPending ? '加载模型…' : '选择模型'} disabled={profiles.isPending || profiles.isError || !enabledModels.length || send.isPending} options={enabledModels.map(profile => ({ value: profile.id, label: profile.name }))} onChange={setSelectedModelId} />
              <Popover.Root>
                <Popover.Trigger asChild><button type="button" className={buttonClass('secondary', 'sm')} aria-label="检索设置" title="检索设置"><SlidersHorizontal size={13} aria-hidden="true" />{methodLabel(method)}{method !== 'no_context' && `，引用 ${topK} 条`}</button></Popover.Trigger>
                <Popover.Portal><Popover.Content className="tm-pop composer-settings" side="top" align="start" sideOffset={6} collisionPadding={12} aria-label="检索设置">
                  <Field label="检索方法"><Select label="检索方法" value={method} onChange={value => setMethod(value as Method)} options={METHODS.map(item => ({ value: item.value, label: item.label }))} /></Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="引用数量 top_k"><input type="number" min={1} max={20} value={topK} onChange={e => setTopK(Number(e.target.value))} required /></Field>
                    <Field label="候选数量"><input type="number" min={topK} max={100} value={candidateK} onChange={e => setCandidateK(Number(e.target.value))} required /></Field>
                  </div>
                </Popover.Content></Popover.Portal>
              </Popover.Root>
              {restrictable && kbId && <SearchableSelect multiple label="限定文档" size="sm" width={320} value={documentIds} onChange={setDocumentIds} onOpenChange={open => { if (open) setDocsWanted(true) }}
                trigger={<><FileText size={13} aria-hidden="true" />{documentIds.length ? `${documentIds.length} 份文档` : '全部文档'}</>}
                options={readyDocs.map(doc => ({ value: doc.id, label: doc.filename }))} />}
            </div>
            <Button type="submit" aria-label="发送问题" busy={send.isPending} disabled={!text.trim() || !kbId || pending || !selectedModel || profiles.isError || !!(kb && kb.ready_count === 0 && method !== 'no_context')} className="send-button">{!send.isPending && <ArrowUp size={16} />}</Button>
          </div>
        </form>
      </div>
    </main>
    <EvidencePane message={shown} question={question} tab={tab} onTab={setTab} citation={citation} onCitation={setCitation} kbId={kbId || undefined} canCompare={admin}
      open={paneOpen} onOpenChange={setPaneOpen} answers={answered.map(entry => ({ id: entry.message.id, question: entry.question || '（无问题文本）' }))}
      onAnswer={answerId => { setActiveId(answerId); setCitation(0) }} backTo={id ? `/chat/${id}` : undefined} />
  </>
}


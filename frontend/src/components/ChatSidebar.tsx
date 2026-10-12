import { useMemo, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { useApi } from '../lib/api'
import type { Conversation, KnowledgeBase } from '../lib/types'
import { useStoredState } from '../lib/storage'
import { Button, CollapsedPanel, PanelHeader, ResizeHandle } from './ui'

function dayGroup(value: string, now = new Date()): '今天' | '昨天' | '更早' {
  const date = new Date(value)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (date.getTime() >= start) return '今天'
  if (date.getTime() >= start - 86400000) return '昨天'
  return '更早'
}

/** Conversation list of the chat module: collapsible, 200–360px wide, state kept in localStorage. */
export function ChatSidebar({ kbId }: { kbId?: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useStoredState('tm.chat.history-open', typeof window === 'undefined' || window.innerWidth >= 1440)
  const [width, setWidth] = useStoredState('tm.chat.history-width', 248)
  const [query, setQuery] = useState('')
  const history = useApi<Conversation[]>('/conversations', { poll: 15000 })
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases')
  const groups = useMemo(() => {
    const names = new Map((kbs.data ?? []).map(kb => [kb.id, kb.name]))
    const text = query.trim().toLowerCase()
    const items = (history.data ?? []).filter(item => !text || item.title.toLowerCase().includes(text))
    const out: { name: string; items: (Conversation & { kb: string })[] }[] = [{ name: '今天', items: [] }, { name: '昨天', items: [] }, { name: '更早', items: [] }]
    for (const item of items) out.find(group => group.name === dayGroup(item.created_at))!.items.push({ ...item, kb: names.get(item.knowledge_base_id) ?? '' })
    return out.filter(group => group.items.length)
  }, [history.data, kbs.data, query])
  if (!open) return <CollapsedPanel side="left" name="对话列表" onToggle={() => setOpen(true)} className="tm-chat-list tm-chat-list-collapsed" />
  return <aside className="tm-chat-list" style={{ flexBasis: width, width }} aria-label="对话列表">
    <PanelHeader toggle={{ side: 'left', expanded: true, onToggle: () => setOpen(false), name: '对话列表' }}><h2>对话</h2></PanelHeader>
    <div className="tm-chat-list-tools">
      <Button className="w-full" onClick={() => navigate(kbId ? `/chat?kb=${kbId}` : '/chat')}><Plus size={14} />新对话</Button>
      <label className="tm-search"><Search size={14} aria-hidden="true" /><input type="search" placeholder="搜索对话" aria-label="搜索对话" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    <section className="tm-chat-list-items" aria-label="对话历史">
      {history.isPending ? <p className="tm-faint px-2" role="status">正在读取…</p>
        : history.isError ? <button type="button" className="tm-textlink px-2" onClick={() => { void history.refetch() }}>读取失败，重试</button>
          : !groups.length ? <p className="tm-faint px-2">{query ? '没有匹配的对话' : '暂无对话'}</p>
            : groups.map(group => <div key={group.name}>
              <div className="tm-chat-group">{group.name}</div>
              {group.items.map(item => <NavLink key={item.id} to={`/chat/${item.id}`} title={item.title} className="tm-chat-item">
                <b>{item.title}</b>{item.kb && <span>{item.kb}</span>}
              </NavLink>)}
            </div>)}
    </section>
    <ResizeHandle edge="right" value={width} min={200} max={360} onChange={setWidth} label="拖动调整对话列表宽度" />
  </aside>
}

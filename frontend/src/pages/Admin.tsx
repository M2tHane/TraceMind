import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Check, Copy, KeyRound, Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, formatNumber, patch, post, useAction, useApi } from '../lib/api'
import { useAuth } from '../lib/auth'
import { memoryCategoryLabel } from '../lib/types'
import type { McpCallLog, Page, QueryLog, Reviews, Role, UserAccount } from '../lib/types'
import { Button, Empty, ErrorState, Field, JsonDetails, Loading, Modal, Notice, PageHeader, Status } from '../components/ui'
import { Select } from '../components/Select'

type Section = 'users' | 'reviews' | 'query-logs' | 'mcp-logs'

function AdminNav({ current }: { current: Section }) {
  const count = useApi<{ total: number }>('/admin/reviews/count', { poll: 30000 })
  const tabs: { value: Section; label: string }[] = [
    { value: 'reviews', label: `待审批${count.data?.total ? ` ${count.data.total}` : ''}` },
    { value: 'users', label: '员工账号' }, { value: 'query-logs', label: '查询日志' }, { value: 'mcp-logs', label: 'MCP 调用日志' },
  ]
  return <nav className="tabs mb-6" aria-label="管理工作区">{tabs.map(tab =>
    <Link key={tab.value} className={`tab ${current === tab.value ? 'tab-active' : ''}`} aria-current={current === tab.value ? 'page' : undefined} to={`/admin/${tab.value}`}>{tab.label}</Link>
  )}</nav>
}

function TemporaryPassword({ account, onClose }: { account: UserAccount | null; onClose: () => void }) {
  return <Modal open={account !== null} onOpenChange={value => { if (!value) onClose() }} title="临时密码" description={`账号 ${account?.username ?? ''} 首次登录后必须修改密码。`}><div className="dialog-body space-y-4"><Notice>临时密码只显示这一次，请通过安全渠道交给员工。</Notice><code className="secret-box" data-testid="temporary-password">{account?.temporary_password}</code><div className="dialog-actions"><Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(account?.temporary_password ?? '').then(() => toast.success('已复制')) }}><Copy size={15} />复制</Button><Button onClick={onClose}>完成</Button></div></div></Modal>
}

export function UsersPage() {
  const { user: me } = useAuth()
  const users = useApi<UserAccount[]>('/admin/users')
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<Role>('employee')
  const [issued, setIssued] = useState<UserAccount | null>(null)
  const create = useAction((body: { username: string; display_name: string; role: Role }) => post<UserAccount>('/admin/users', body), { invalidate: ['/admin/users'], onSuccess: account => { setOpen(false); setIssued(account) } })
  const update = useAction(({ id, ...body }: { id: string; role?: Role; status?: 'active' | 'disabled' }) => patch<UserAccount>(`/admin/users/${id}`, body), { invalidate: ['/admin/users'], success: '账号已更新' })
  const reset = useAction((id: string) => post<UserAccount>(`/admin/users/${id}/reset-password`), { invalidate: ['/admin/users'], onSuccess: account => setIssued(account) })
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    create.mutate({ username: String(form.get('username')).trim(), display_name: String(form.get('display_name')).trim(), role })
  }
  return <div className="page"><PageHeader title="管理" description="员工账号、内容审批与审计日志。" actions={<Button onClick={() => setOpen(true)}><Plus size={16} />新建账号</Button>} /><AdminNav current="users" />
    {users.isPending ? <Loading /> : users.isError ? <ErrorState error={users.error} retry={() => { void users.refetch() }} /> : <div className="table-wrap"><table><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>最近登录</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{users.data.map(account => {
      const self = account.id === me?.id
      return <tr key={account.id}><td><span className="font-medium">{account.display_name || account.username}</span><span className="ml-2 text-xs text-slate-500">{account.username}{self ? '（我）' : ''}</span>{account.must_change_password && <p className="text-xs text-amber-700 mt-1">等待首次修改密码</p>}</td>
        <td>{account.role === 'admin' ? '管理员' : '员工'}</td><td><Status value={account.status} /></td><td className="whitespace-nowrap">{formatDate(account.last_login_at ?? undefined)}</td>
        <td><span className="inline-flex flex-wrap gap-3">{!self && <>
          <button type="button" className="text-link" disabled={update.isPending} onClick={() => update.mutate({ id: account.id, role: account.role === 'admin' ? 'employee' : 'admin' })}>{account.role === 'admin' ? '设为员工' : '设为管理员'}</button>
          <button type="button" className="text-link" disabled={update.isPending} onClick={() => { if (account.status === 'active' && !window.confirm(`停用 ${account.username}？该账号将立即退出登录，令牌失效。`)) return; update.mutate({ id: account.id, status: account.status === 'active' ? 'disabled' : 'active' }) }}>{account.status === 'active' ? '停用' : '启用'}</button>
          <button type="button" className="text-link inline-flex items-center gap-1" disabled={reset.isPending} onClick={() => { if (window.confirm(`为 ${account.username} 生成新的临时密码？`)) reset.mutate(account.id) }}><KeyRound size={13} />重置密码</button>
        </>}</span></td></tr>
    })}</tbody></table></div>}
    <Modal open={open} onOpenChange={value => { if (!create.isPending) setOpen(value) }} title="新建账号" description="系统生成临时密码，员工首次登录时设置自己的密码。"><form className="dialog-body space-y-5" onSubmit={submit}><Field label="用户名" hint="3-64 位小写字母、数字或 _ . -"><input name="username" required minLength={3} maxLength={64} autoFocus /></Field><Field label="显示名"><input name="display_name" maxLength={100} /></Field><Field label="角色"><Select label="角色" value={role} onChange={value => setRole(value as Role)} options={[{ value: 'employee', label: '员工' }, { value: 'admin', label: '管理员' }]} /></Field>{create.error && <ErrorState error={create.error} />}<div className="dialog-actions"><Button variant="secondary" onClick={() => setOpen(false)} disabled={create.isPending}>取消</Button><Button type="submit" busy={create.isPending}>创建账号</Button></div></form></Modal>
    <TemporaryPassword account={issued} onClose={() => setIssued(null)} />
  </div>
}

export function ReviewsPage() {
  const reviews = useApi<Reviews>('/admin/reviews', { poll: 15000 })
  const invalidate = ['/admin/reviews', '/admin/reviews/count']
  const decideDocument = useAction(({ id, approve }: { id: string; approve: boolean }) => post(`/admin/reviews/documents/${id}`, { approve, note: approve ? '' : window.prompt('驳回原因（可选）') ?? '' }), { invalidate, success: '已处理' })
  const decideMemory = useAction(({ id, approve }: { id: string; approve: boolean }) => post(`/admin/reviews/memories/${id}`, { approve }), { invalidate, success: '已处理' })
  const actions = (busy: boolean, decide: (approve: boolean) => void, label: string) => <span className="inline-flex gap-2"><Button variant="secondary" disabled={busy} aria-label={`通过 ${label}`} onClick={() => decide(true)}><Check size={14} />通过</Button><Button variant="ghost" disabled={busy} aria-label={`驳回 ${label}`} onClick={() => decide(false)}><X size={14} />驳回</Button></span>
  return <div className="page"><PageHeader title="管理" description="员工账号、内容审批与审计日志。" /><AdminNav current="reviews" />
    {reviews.isPending ? <Loading /> : reviews.isError ? <ErrorState error={reviews.error} retry={() => { void reviews.refetch() }} /> : <>
      <div className="section-heading"><h2>平台知识库文档<span className="ml-2 text-slate-400 font-normal">{reviews.data.documents.length}</span></h2></div>
      {!reviews.data.documents.length ? <Empty title="没有待审批文档" description="员工向平台知识库上传的文档会出现在这里，通过后才会解析入库。" /> : <div className="table-wrap"><table><thead><tr><th>文档</th><th>知识库</th><th>上传者</th><th>上传时间</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{reviews.data.documents.map(doc => <tr key={doc.id}><td><Link className="text-link" to={`/knowledge/${doc.knowledge_base_id}/documents/${doc.id}`}>{doc.filename}</Link><span className="ml-2 text-xs text-slate-500">{doc.page_count ? `${doc.page_count} 页` : doc.source_type}</span></td><td>{doc.knowledge_base_name}</td><td>{doc.uploader.display_name || doc.uploader.username || '—'}</td><td className="whitespace-nowrap">{formatDate(doc.created_at)}</td><td>{actions(decideDocument.isPending, approve => decideDocument.mutate({ id: doc.id, approve }), doc.filename)}</td></tr>)}</tbody></table></div>}
      <div className="section-heading mt-8"><h2>平台记忆提议<span className="ml-2 text-slate-400 font-normal">{reviews.data.memories.length}</span></h2></div>
      {!reviews.data.memories.length ? <Empty title="没有待审批记忆" description="员工提交的平台记忆通过后对所有人生效，并用于个性化回答。" /> : <div className="table-wrap"><table><thead><tr><th>内容</th><th>类别</th><th>提议人</th><th>时间</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{reviews.data.memories.map(memory => <tr key={memory.id}><td className="max-w-xl break-words">{memory.content}</td><td>{memoryCategoryLabel(memory.category)}</td><td>{memory.author || '—'}</td><td className="whitespace-nowrap">{formatDate(memory.created_at)}</td><td>{actions(decideMemory.isPending, approve => decideMemory.mutate({ id: memory.id, approve }), memory.content.slice(0, 20))}</td></tr>)}</tbody></table></div>}
    </>}
  </div>
}

const PAGE = 50
function Pager({ total, offset, onChange }: { total: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= PAGE) return null
  return <div className="flex items-center justify-end gap-3 mt-4 text-sm text-slate-500"><span>{offset + 1}-{Math.min(offset + PAGE, total)} / {total}</span><Button variant="secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE))}>上一页</Button><Button variant="secondary" disabled={offset + PAGE >= total} onClick={() => onChange(offset + PAGE)}>下一页</Button></div>
}
const SOURCE: Record<string, string> = { chat: '问答', debug: '检索对比', mcp: 'MCP' }

export function QueryLogsPage() {
  const [scope, setScope] = useState('all')
  const [source, setSource] = useState('all')
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
  if (scope !== 'all') params.set('kb_scope', scope); if (source !== 'all') params.set('source', source); if (q) params.set('q', q)
  const logs = useApi<Page<QueryLog>>(`/admin/query-logs?${params.toString()}`, { poll: 15000 })
  return <div className="page page-wide"><PageHeader title="管理" description="员工账号、内容审批与审计日志。" /><AdminNav current="query-logs" />
    <Notice>平台知识库的查询记录完整问题；个人知识库只记录元数据（谁、何时、哪个库、字数、耗时），不记录问题内容。</Notice>
    <form className="toolbar mt-4" onSubmit={event => { event.preventDefault(); setOffset(0); setQ(text.trim()) }}><div className="search-field"><Search size={16} /><input aria-label="搜索问题" value={text} onChange={event => setText(event.target.value)} placeholder="搜索平台问题文本…" /></div><Select className="filter-select" label="知识库范围" value={scope} onChange={value => { setScope(value); setOffset(0) }} options={[{ value: 'all', label: '全部范围' }, { value: 'platform', label: '平台知识库' }, { value: 'personal', label: '个人知识库' }]} /><Select className="filter-select" label="来源" value={source} onChange={value => { setSource(value); setOffset(0) }} options={[{ value: 'all', label: '全部来源' }, { value: 'chat', label: '问答' }, { value: 'mcp', label: 'MCP' }, { value: 'debug', label: '检索对比' }]} /></form>
    {logs.isPending ? <Loading /> : logs.isError ? <ErrorState error={logs.error} retry={() => { void logs.refetch() }} /> : !logs.data.items.length ? <Empty title="暂无查询记录" description="问答、检索对比和 MCP 检索都会记录在这里。" /> : <><div className="table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>来源</th><th>知识库</th><th>问题</th><th>结果</th><th>耗时</th></tr></thead><tbody>{logs.data.items.map(row => <tr key={row.id}><td className="whitespace-nowrap">{formatDate(row.created_at)}</td><td>{row.username || '—'}</td><td>{SOURCE[row.source] ?? row.source}</td><td>{row.knowledge_base_name || row.knowledge_base_id}<span className="ml-1 text-xs text-slate-500">{row.kb_scope === 'personal' ? '个人' : '平台'}</span></td><td className="max-w-md break-words">{row.query ?? <span className="text-slate-400">（个人库，未记录内容 · {row.query_chars} 字）</span>}{row.error && <p className="text-xs text-red-700 mt-1">{row.error}</p>}</td><td className="tabular-nums">{row.status === 'error' ? <Status value="error" /> : formatNumber(row.result_count)}</td><td className="tabular-nums whitespace-nowrap">{formatNumber(row.latency_ms)} ms</td></tr>)}</tbody></table></div><Pager total={logs.data.total} offset={offset} onChange={setOffset} /></>}
  </div>
}

export function McpLogsPage() {
  const [tool, setTool] = useState('all')
  const [status, setStatus] = useState('all')
  const [offset, setOffset] = useState(0)
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
  if (tool !== 'all') params.set('tool', tool); if (status !== 'all') params.set('status', status)
  const logs = useApi<Page<McpCallLog> & { tools: string[] }>(`/admin/mcp-logs?${params.toString()}`, { poll: 15000 })
  return <div className="page page-wide"><PageHeader title="管理" description="员工账号、内容审批与审计日志。" /><AdminNav current="mcp-logs" />
    <Notice>参数只记录编号、数值和长度，不记录文档内容、记忆文本或问题原文。</Notice>
    <div className="toolbar mt-4"><Select className="filter-select" label="工具" value={tool} onChange={value => { setTool(value); setOffset(0) }} options={[{ value: 'all', label: '全部工具' }, ...(logs.data?.tools ?? []).map(name => ({ value: name, label: name }))]} /><Select className="filter-select" label="状态" value={status} onChange={value => { setStatus(value); setOffset(0) }} options={[{ value: 'all', label: '全部状态' }, { value: 'ok', label: '成功' }, { value: 'error', label: '失败' }]} /></div>
    {logs.isPending ? <Loading /> : logs.isError ? <ErrorState error={logs.error} retry={() => { void logs.refetch() }} /> : !logs.data.items.length ? <Empty title="暂无 MCP 调用" description="Agent 使用个人访问令牌调用 MCP 工具后会记录在这里。" /> : <><div className="table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>工具</th><th>传输</th><th>状态</th><th>耗时</th><th>参数</th></tr></thead><tbody>{logs.data.items.map(row => <tr key={row.id}><td className="whitespace-nowrap">{formatDate(row.created_at)}</td><td>{row.username || '—'}</td><td><code>{row.tool}</code></td><td>{row.transport}</td><td><Status value={row.status} />{row.error && <p className="text-xs text-red-700 mt-1 max-w-xs break-words">{row.error}</p>}</td><td className="tabular-nums whitespace-nowrap">{formatNumber(row.latency_ms)} ms</td><td><JsonDetails value={row.arguments} label="参数摘要" /></td></tr>)}</tbody></table></div><Pager total={logs.data.total} offset={offset} onChange={setOffset} /></>}
  </div>
}

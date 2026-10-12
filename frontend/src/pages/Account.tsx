import { useState } from 'react'
import type { FormEvent } from 'react'
import { Copy, KeyRound, LogOut, Plus, Trash2 } from 'lucide-react'

const mcpConfig = (endpoint: string, token: string): string => JSON.stringify({ mcpServers: { tracemind: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
const copy = (text: string, message = '已复制'): void => { void navigator.clipboard.writeText(text).then(() => toast.success(message), () => toast.error('复制失败，请手动选择文本')) }
import { toast } from 'sonner'
import { errorText, formatDate, post, remove, useAction, useApi } from '../lib/api'
import { useAuth } from '../lib/auth'
import type { ApiToken } from '../lib/types'
import { BrandMark, Button, Empty, ErrorState, Field, Loading, Modal, Notice, PageHeader, Status } from '../components/ui'

export function LoginPage() {
  const { signIn } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try { await signIn(String(form.get('username')).trim(), String(form.get('password'))) } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <main className="auth-split">
    <section className="auth-story" aria-label="产品简介">
      <div className="brand"><BrandMark size={32} /><span className="brand-name">TraceMind</span></div>
      <div>
        <h2>每个回答，都能追溯到原文。</h2>
        <p>企业知识库问答工作台：混合检索、重排与引用溯源，配合个人记忆和 MCP，让团队和 Agent 用同一套知识。</p>
        <ol className="auth-thread">
          <li><span /><div><strong>上传文档</strong><small>PDF 与 Markdown 自动解析、分块、建立索引</small></div></li>
          <li><span /><div><strong>混合召回与重排</strong><small>向量 + BM25 融合，每一步耗时与候选都可查看</small></div></li>
          <li><span /><div><strong>带引用的回答</strong><small>点击引用即可跳到原文段落</small></div></li>
        </ol>
      </div>
      <small>账号由管理员分配。</small>
    </section>
    <div className="auth-form-side"><form className="auth-card" onSubmit={event => { void submit(event) }} aria-label="登录">
    <div><h1>登录</h1><p>使用管理员分配的账号登录 TraceMind。</p></div>
    <Field label="用户名"><input name="username" autoComplete="username" required maxLength={64} autoFocus /></Field>
    <Field label="密码"><input name="password" type="password" autoComplete="current-password" required maxLength={128} /></Field>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <Button type="submit" busy={busy}>登录</Button>
    <p className="auth-footnote">没有账号或忘记密码？请联系管理员。</p>
  </form></div></main>
}

function PasswordForm({ onDone, submitLabel = '修改密码' }: { onDone?: () => void; submitLabel?: string }) {
  const { refresh } = useAuth()
  const change = useAction((body: { current_password: string; new_password: string }) => post('/auth/password', body), { success: '密码已更新，其他设备已退出登录', onSuccess: () => { void refresh(); onDone?.() } })
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const next = String(form.get('new_password')); if (next !== String(form.get('confirm'))) { toast.error('两次输入的新密码不一致'); return }
    change.mutate({ current_password: String(form.get('current_password')), new_password: next })
  }
  return <form className="space-y-4" onSubmit={submit}>
    <Field label="当前密码"><input name="current_password" type="password" autoComplete="current-password" required maxLength={128} /></Field>
    <Field label="新密码" hint="10-128 位，不能包含用户名，至少 5 种不同字符"><input name="new_password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} /></Field>
    <Field label="确认新密码"><input name="confirm" type="password" autoComplete="new-password" required minLength={10} maxLength={128} /></Field>
    {change.error && <ErrorState error={change.error} />}
    <Button type="submit" busy={change.isPending}><KeyRound size={15} />{submitLabel}</Button>
  </form>
}

export function ForcePasswordPage() {
  const { user, signOut } = useAuth()
  return <main className="auth-screen"><div className="auth-card">
    <div><h1>设置新密码</h1><p>{user?.display_name || user?.username}，首次登录或密码被重置后，需要先设置自己的密码。</p></div>
    <PasswordForm submitLabel="保存并进入工作台" />
    <button type="button" className="text-link" onClick={() => { void signOut() }}>退出登录</button>
  </div></main>
}

export function AccountPage() {
  const { user, signOut } = useAuth()
  const tokens = useApi<ApiToken[]>('/auth/tokens')
  const [created, setCreated] = useState<ApiToken | null>(null)
  const [open, setOpen] = useState(false)
  const create = useAction((body: { name: string; expires_days: number | null }) => post<ApiToken>('/auth/tokens', body), { invalidate: ['/auth/tokens'], onSuccess: token => { setOpen(false); setCreated(token) } })
  const revoke = useAction((id: string) => remove<ApiToken>(`/auth/tokens/${id}`), { invalidate: ['/auth/tokens'], success: '令牌已吊销' })
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); const form = new FormData(event.currentTarget); const days = Number(form.get('expires_days'))
    create.mutate({ name: String(form.get('name')).trim(), expires_days: days > 0 ? days : null })
  }
  const endpoint = `${window.location.protocol}//${window.location.hostname}:8010/mcp`
  return <div className="page"><PageHeader title="我的账户" description="修改密码，管理供 AI Agent 通过 MCP 访问工作台的个人访问令牌。" actions={<Button variant="secondary" onClick={() => { void signOut() }}><LogOut size={15} />退出登录</Button>} />
    <div className="metadata-strip"><span>用户名 {user?.username}</span><span>显示名 {user?.display_name}</span><span>角色 {user?.role === 'admin' ? '管理员' : '员工'}</span></div>
    <div className="account-grid">
      <section className="panel"><div className="panel-heading"><h2>修改密码</h2></div><PasswordForm /></section>
      <section className="panel"><div className="panel-heading"><h2>MCP 访问令牌</h2><Button className="ml-auto" variant="secondary" onClick={() => setOpen(true)}><Plus size={15} />新建令牌</Button></div>
        <p className="text-sm text-slate-500 leading-6 mb-4">Agent 以你的身份调用 MCP，权限与你在网页中相同，所有调用都会记录在管理员的 MCP 日志中。端点：<code>{endpoint}</code>，请求头 <code>Authorization: Bearer &lt;令牌&gt;</code>。</p>
        {tokens.isPending ? <Loading /> : tokens.isError ? <ErrorState error={tokens.error} retry={() => { void tokens.refetch() }} /> : !tokens.data.length ? <Empty icon={KeyRound} title="还没有令牌" description="新建一个令牌，再把下面的配置粘贴到 Agent 的 MCP 客户端。" action={<Button variant="secondary" onClick={() => setOpen(true)}><Plus size={15} />新建令牌</Button>} /> : <div className="table-wrap"><table><thead><tr><th>名称</th><th>状态</th><th>最近使用</th><th>到期</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{tokens.data.map(token => <tr key={token.id}><td><span className="font-medium">{token.name}</span>{token.prefix && <code className="ml-2 text-xs text-slate-500">{token.prefix}…</code>}</td><td><Status value={token.revoked_at ? 'disabled' : 'active'} /></td><td className="whitespace-nowrap">{formatDate(token.last_used_at ?? undefined)}</td><td className="whitespace-nowrap">{token.expires_at ? formatDate(token.expires_at) : '永不过期'}</td><td>{!token.revoked_at && <button type="button" className="text-slate-400 hover:text-red-700" aria-label={`吊销 ${token.name}`} title="吊销令牌" disabled={revoke.isPending} onClick={() => { if (window.confirm(`吊销「${token.name}」？使用它的 Agent 将立即失去访问权限。`)) revoke.mutate(token.id) }}><Trash2 size={15} /></button>}</td></tr>)}</tbody></table></div>}
        <div className="mcp-config"><div className="mcp-config-head"><span>MCP 客户端配置（Claude Desktop、Cursor 等）</span><Button variant="secondary" onClick={() => copy(mcpConfig(endpoint, '<令牌>'))}><Copy size={13} />复制</Button></div><pre>{mcpConfig(endpoint, '<令牌>')}</pre></div>
      </section>
    </div>
    <Modal open={open} onOpenChange={value => { if (!create.isPending) setOpen(value) }} title="新建 MCP 令牌"><form className="dialog-body space-y-5" onSubmit={submit}><Field label="名称"><input name="name" required maxLength={100} placeholder="例如：Claude Desktop" autoFocus /></Field><Field label="有效期（天）" hint="留空表示永不过期"><input name="expires_days" type="number" min={1} max={3650} placeholder="90" /></Field>{create.error && <ErrorState error={create.error} />}<div className="dialog-actions"><Button variant="secondary" onClick={() => setOpen(false)} disabled={create.isPending}>取消</Button><Button type="submit" busy={create.isPending}>创建</Button></div></form></Modal>
    <Modal open={created !== null} onOpenChange={value => { if (!value) setCreated(null) }} title="令牌已创建" description="令牌只显示这一次，关闭后无法再次查看。"><div className="dialog-body space-y-4"><Notice>请立即复制并妥善保存，不要提交到代码仓库。</Notice><code className="secret-box" data-testid="new-token">{created?.token}</code><div className="dialog-actions"><Button variant="secondary" onClick={() => copy(mcpConfig(endpoint, created?.token ?? ''), '已复制含令牌的 MCP 配置')}><Copy size={15} />复制 MCP 配置</Button><Button variant="secondary" onClick={() => copy(created?.token ?? '')}><Copy size={15} />复制令牌</Button><Button onClick={() => setCreated(null)}>我已保存</Button></div></div></Modal>
  </div>
}

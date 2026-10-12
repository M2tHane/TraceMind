import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { errorText, post, remove, useAction, useApi } from '../lib/api'
import { useAuth } from '../lib/auth'
import type { ApiToken } from '../lib/types'
import { BrandMark, Button, CiteMarker, DataTable, ErrorState, FactStrip, Highlight, Loading, Modal, StatusTag, Tabs, type Column } from '../components/ui'
import { FormField } from '../components/ConfigurationControls'
import { AccountSide } from '../components/shell/ModuleNav'
import { Page } from '../components/shell/Shell'
import { formatDay, formatStamp, roleLabel } from './adminShared'

const copy = (text: string, message = '已复制'): void => { void navigator.clipboard.writeText(text).then(() => toast.success(message), () => toast.error('复制失败，请手动选择文本')) }

// ------------------------------------------------------------------ sign-in

/** Split screen shared by sign-in and the forced password change: the product idea on the left, the form on the right. */
function AuthScreen({ label, children }: { label: string; children: ReactNode }) {
  return <main className="lg">
    <section className="lg-story" aria-label="产品说明">
      <div className="lg-brand"><BrandMark size={36} /><span>TraceMind</span></div>
      <div className="lg-pitch">
        <h1>在你有权看到的资料里找答案，每一句结论都能回到原文那一页。</h1>
        <figure aria-label="示例：回答里的结论与原文出处" className="lg-trace">
          <div className="lg-answer">
            <p className="lg-kicker">回答</p>
            <p>今年没休完的年假，<Highlight>最晚可以顺延到次年 3 月 31 日，逾期作废</Highlight><CiteMarker n={1} active />。</p>
          </div>
          <div className="lg-thread" aria-hidden="true" />
          <div className="lg-source tm-ev-card">
            <p className="lg-kicker"><strong>leave-policy.md</strong><span>第 1 页，一、年假</span></p>
            <p>4. <Highlight>当年年假因工作原因未休完的，可顺延至次年 3 月 31 日，逾期作废。</Highlight></p>
          </div>
        </figure>
      </div>
    </section>
    <section className="lg-form-side" aria-label={label}>{children}</section>
  </main>
}

export function LoginPage() {
  const { signIn } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try { await signIn(String(form.get('username')).trim(), String(form.get('password'))) } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <AuthScreen label="登录">
    <form className="lg-form" onSubmit={event => { void submit(event) }} aria-label="登录表单">
      <h2>登录</h2>
      <FormField label="用户名" className="lg-field"><input className="tm-input" name="username" autoComplete="username" required maxLength={64} autoFocus /></FormField>
      <FormField label="密码" className="lg-field"><input className="tm-input" name="password" type="password" autoComplete="current-password" required maxLength={128} placeholder="输入密码" /></FormField>
      {error && <p className="lg-error" role="alert">{error}</p>}
      <Button type="submit" busy={busy} className="lg-submit">登录</Button>
    </form>
  </AuthScreen>
}

// ------------------------------------------------------------------ password

function PasswordForm({ onDone, submitLabel = '修改密码', large = false }: { onDone?: () => void; submitLabel?: string; large?: boolean }) {
  const { refresh } = useAuth()
  const change = useAction((body: { current_password: string; new_password: string }) => post('/auth/password', body), { success: '密码已更新，其他设备已退出登录', onSuccess: () => { void refresh(); onDone?.() } })
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const next = String(form.get('new_password')); if (next !== String(form.get('confirm'))) { toast.error('两次输入的新密码不一致'); return }
    change.mutate({ current_password: String(form.get('current_password')), new_password: next })
  }
  const field = large ? 'lg-field' : undefined
  return <form className="ac-form" onSubmit={submit}>
    <FormField label="当前密码" className={field}><input className="tm-input" name="current_password" type="password" autoComplete="current-password" required maxLength={128} /></FormField>
    <FormField label="新密码" className={field} caption="10-128 位，不能包含用户名，至少 5 种不同字符"><input className="tm-input" name="new_password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} /></FormField>
    <FormField label="确认新密码" className={field}><input className="tm-input" name="confirm" type="password" autoComplete="new-password" required minLength={10} maxLength={128} /></FormField>
    {change.error && <ErrorState error={change.error} />}
    <Button type="submit" busy={change.isPending} className={large ? 'lg-submit' : 'self-start'}>{submitLabel}</Button>
  </form>
}

export function ForcePasswordPage() {
  const { user, signOut } = useAuth()
  return <AuthScreen label="设置新密码">
    <div className="lg-form">
      <h2>设置新密码</h2>
      <p className="tm-muted m-0">{user?.display_name || user?.username}，首次登录或密码被重置后，需要先设置自己的密码。</p>
      <PasswordForm submitLabel="保存并进入工作台" large />
      <button type="button" className="tm-textlink self-start" onClick={() => { void signOut() }}>退出登录</button>
    </div>
  </AuthScreen>
}

// ------------------------------------------------------------------ account pages

export function ProfilePage() {
  const { user } = useAuth()
  return <Page side={<AccountSide />} title="个人资料">
    <FactStrip items={[{ label: '显示名', value: user?.display_name || '—' }, { label: '用户名', value: user?.username ?? '—' }, { label: '角色', value: roleLabel(user?.role) }]} />
  </Page>
}

export function PasswordPage() {
  return <Page side={<AccountSide />} title="修改密码"><section className="tm-panel ac-narrow" aria-label="修改密码"><PasswordForm /></section></Page>
}

// ------------------------------------------------------------------ MCP tokens

const TOOL_GROUPS = ['知识库与召回', '文档', '记忆']
const ADMIN_TOOL_GROUPS = ['审批', '评测调优']
type Client = 'claude-code' | 'cursor' | 'claude-desktop' | 'stdio'
const CLIENTS: { value: Client; label: string }[] = [{ value: 'claude-code', label: 'Claude Code' }, { value: 'cursor', label: 'Cursor' }, { value: 'claude-desktop', label: 'Claude Desktop' }, { value: 'stdio', label: 'stdio' }]

function clientCommand(client: Client, endpoint: string, token: string): string {
  switch (client) {
    case 'claude-code': return `claude mcp add --transport http tracemind ${endpoint} \\\n  --header "Authorization: Bearer ${token}"`
    case 'cursor': return JSON.stringify({ mcpServers: { tracemind: { url: endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
    case 'claude-desktop': return JSON.stringify({ mcpServers: { tracemind: { command: '/绝对路径/TraceMind/backend/.venv/bin/python', args: ['-m', 'app.mcp_server'], cwd: '/绝对路径/TraceMind/backend', env: { RAG_MCP_TOKEN: token } } } }, null, 2)
    case 'stdio': return `cd backend && RAG_MCP_TOKEN=${token} .venv/bin/python -m app.mcp_server`
  }
}

export function TokensPage() {
  const admin = useAuth().user?.role === 'admin'
  const tokens = useApi<ApiToken[]>('/auth/tokens')
  const [created, setCreated] = useState<ApiToken | null>(null)
  const [open, setOpen] = useState(false)
  const [client, setClient] = useState<Client>('claude-code')
  const create = useAction((body: { name: string; expires_days: number | null }) => post<ApiToken>('/auth/tokens', body), { invalidate: ['/auth/tokens'], onSuccess: token => { setOpen(false); setCreated(token) } })
  const revoke = useAction((id: string) => remove<ApiToken>(`/auth/tokens/${id}`), { invalidate: ['/auth/tokens'], success: '令牌已吊销' })
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); const form = new FormData(event.currentTarget); const days = Number(form.get('expires_days'))
    create.mutate({ name: String(form.get('name')).trim(), expires_days: days > 0 ? days : null })
  }
  const endpoint = `${window.location.protocol}//${window.location.hostname}:8010/mcp`
  const command = clientCommand(client, endpoint, created?.token ?? '<令牌>')
  const rows = tokens.data ?? []

  const columns: Column<ApiToken>[] = [
    { key: 'name', header: '名称', cell: token => <span className="font-medium">{token.name}</span> },
    { key: 'prefix', header: '前缀', cell: token => token.prefix ? <span className="tm-mono tm-muted">{token.prefix}…</span> : '—', nowrap: true },
    { key: 'used', header: '最近使用', cell: token => <span className="tm-muted tm-num">{token.last_used_at ? formatStamp(token.last_used_at) : '还没用过'}</span>, nowrap: true },
    { key: 'expires', header: '到期', cell: token => <span className="tm-muted tm-num">{token.expires_at ? formatDay(token.expires_at) : '永不过期'}</span>, nowrap: true },
    { key: 'created', header: '创建', cell: token => <span className="tm-muted tm-num">{formatStamp(token.created_at)}</span>, nowrap: true },
    { key: 'status', header: '状态', cell: token => <StatusTag value={token.revoked_at ? 'revoked' : 'active'} label={token.revoked_at ? '已吊销' : '有效'} />, nowrap: true },
    { key: 'revoke', header: <span className="sr-only">操作</span>, align: 'right', nowrap: true, cell: token => token.revoked_at ? null
      : <Button variant="danger" size="sm" aria-label={`吊销 ${token.name}`} disabled={revoke.isPending} onClick={() => { if (window.confirm(`吊销「${token.name}」？使用它的 Agent 将立即失去访问权限。`)) revoke.mutate(token.id) }}>吊销</Button> },
  ]

  return <Page side={<AccountSide />} title="MCP 访问令牌" bodyClassName="ac-tokens" actions={<Button onClick={() => setOpen(true)}><Plus size={14} />新建令牌</Button>}>
    {created?.token && <section className="ac-banner" aria-label="新令牌">
      <div className="ac-banner-main">
        <p className="ac-banner-title">“{created.name}”的令牌已创建，只显示这一次</p>
        <div className="ac-banner-token">
          <code data-testid="new-token">{created.token}</code>
          <button type="button" className="ac-copy" onClick={() => copy(created.token ?? '')}>复制令牌</button>
        </div>
      </div>
      <label className="ac-banner-saved"><input type="checkbox" checked={false} onChange={() => setCreated(null)} />我已保存好</label>
    </section>}

    <section className="tm-panel" aria-label="接入你的 Agent">
      <div className="ac-panel-head"><h2>接入你的 Agent</h2></div>
      <div className="ac-panel-tabs"><Tabs label="客户端" value={client} onChange={value => setClient(value as Client)} items={CLIENTS} /></div>
      <div className="ac-panel-body">
        <div className="ac-code">
          <pre className="tm-mono">{command}</pre>
          <Button variant="secondary" size="sm" className="ac-code-copy" onClick={() => copy(command, '已复制命令')}><Copy size={13} />复制命令</Button>
        </div>
        <div className="ac-tools">
          <span className="tm-muted">可用工具</span>
          {[...TOOL_GROUPS, ...(admin ? ADMIN_TOOL_GROUPS : [])].map(name => <span key={name} className="tm-tag ac-tool">{name}</span>)}
          {admin && <Link className="ac-tools-link" to="/admin/mcp-logs">查看我的调用记录</Link>}
        </div>
      </div>
    </section>

    <section className="tm-panel ad-panel" aria-label="我的令牌">
      <div className="ac-panel-head ac-panel-head-line"><h2>我的令牌</h2><span className="tm-faint tm-num">{rows.length}</span></div>
      {tokens.isPending ? <Loading /> : tokens.isError ? <ErrorState error={tokens.error} retry={() => { void tokens.refetch() }} />
        : <DataTable label="我的令牌" columns={columns} rows={rows} rowKey={token => token.id} minWidth={760} rowProps={token => ({ dim: !!token.revoked_at })} empty="还没有令牌" />}
    </section>

    <Modal open={open} onOpenChange={value => { if (!create.isPending) setOpen(value) }} title="新建 MCP 令牌">
      <form className="dialog-body ac-form" onSubmit={submit}>
        <FormField label="名称"><input className="tm-input" name="name" required maxLength={100} placeholder="例如：Claude Desktop" autoFocus /></FormField>
        <FormField label="有效期（天）" caption="留空表示永不过期"><input className="tm-input" name="expires_days" type="number" min={1} max={3650} placeholder="90" /></FormField>
        {create.error && <ErrorState error={create.error} />}
        <div className="dialog-actions"><Button variant="secondary" onClick={() => setOpen(false)} disabled={create.isPending}>取消</Button><Button type="submit" busy={create.isPending}>创建</Button></div>
      </form>
    </Modal>
  </Page>
}

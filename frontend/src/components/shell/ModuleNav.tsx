import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useApi } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { isFailed, useLibraryDocuments } from '../../lib/knowledge'
import type { Dataset, KnowledgeBase, Run, TuningRun, UserAccount } from '../../lib/types'
import type { ModelProfile } from '../../lib/configuration'
import { statusLabel, statusTone } from '../ui'
import { SideNav, useReviewCount, type SideEntry } from './Shell'

const RECENT_KEY = 'tm.recent-knowledge'

/** Remember an opened knowledge base for the “最近打开” group (most recent first, five kept). */
export function rememberKnowledgeBase(id: string): void {
  try {
    const list = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as string[]
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...list.filter(item => item !== id)].slice(0, 5)))
  } catch { /* not persisted */ }
}
function recentKnowledgeBases(): string[] {
  try { return JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as string[] } catch { return [] }
}

export type KnowledgeFilter = 'all' | 'platform' | 'personal'

export function KnowledgeSide({ filter, failedView = false }: { filter: KnowledgeFilter; failedView?: boolean }) {
  const admin = useAuth().user?.role === 'admin'
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases')
  const pending = useReviewCount(admin)
  const failed = useLibraryDocuments(kbs.data).docs.filter(isFailed).length
  const list = kbs.data ?? []
  const count = (scope?: string) => kbs.data ? list.filter(kb => !scope || kb.scope === scope).length : undefined
  const recent = recentKnowledgeBases().map(id => list.find(kb => kb.id === id)).filter((kb): kb is KnowledgeBase => !!kb)
  return <SideNav title="知识库" label="知识库导航" groups={[
    { items: [
      { to: '/knowledge', label: '全部', count: count(), current: !failedView && filter === 'all' },
      { to: '/knowledge?scope=platform', label: '平台知识库', count: count('platform'), current: !failedView && filter === 'platform' },
      { to: '/knowledge?scope=personal', label: '我的知识库', count: count('personal'), current: !failedView && filter === 'personal' },
    ] },
    { label: '需要处理', items: [
      ...(admin ? [{ to: '/admin/reviews', label: '待我审批的上传', count: pending || undefined }] : []),
      { to: '/knowledge?docs=failed', label: '处理失败的文档', count: failed ? <span style={{ color: 'var(--tm-danger)' }}>{failed}</span> : undefined, current: failedView },
    ] },
    { label: '最近打开', items: recent.map(kb => ({ to: `/knowledge/${kb.id}`, label: kb.name, title: kb.name })) },
  ]} />
}

/** Detail pages: every library grouped by scope, with document counts. */
export function KnowledgeListSide() {
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases')
  const entry = (kb: KnowledgeBase): SideEntry => ({ to: `/knowledge/${kb.id}`, label: kb.name, count: kb.document_count, title: kb.name })
  return <SideNav label="知识库列表" header={<SideLinkBack to="/knowledge" label="全部知识库" />} groups={[
    { label: '平台', items: (kbs.data ?? []).filter(kb => kb.scope === 'platform').map(entry) },
    { label: '我的', items: (kbs.data ?? []).filter(kb => kb.scope === 'personal').map(entry) },
  ]} />
}

function SideLinkBack({ to, label }: { to: string; label: string }) {
  return <Link to={to} className="tm-si" style={{ color: 'var(--tm-muted)', marginBottom: 6 }}><ArrowLeft size={14} aria-hidden="true" />{label}</Link>
}

export function MemorySide() {
  const admin = useAuth().user?.role === 'admin'
  const active = useApi<{ total: number }>('/memories?status=active&limit=1')
  return <SideNav title="记忆" label="记忆导航" groups={[{ items: [
    { to: '/memory', label: '我的记忆', count: active.data?.total, end: true },
    ...(admin ? [{ to: '/memory/consolidation', label: '自动整理', end: true }] : []),
  ] }]} />
}

const TONE_COLOR: Record<string, string> = { ok: 'var(--tm-pine-hover)', run: 'var(--tm-tag-run)', err: 'var(--tm-danger)' }
function progress(status: string, done: number, total: number, percent = false) {
  const value = percent && status === 'running' && total ? `${Math.round(done / total * 100)}%` : `${done} / ${total}`
  return <span style={{ color: TONE_COLOR[statusTone(status)] ?? 'var(--tm-faint)' }}>{statusLabel(status)}，{value}</span>
}

export type EvalSection = 'runs' | 'tuning' | 'retrieval' | 'datasets'

export function EvaluationSide({ section }: { section: EvalSection }) {
  const runs = useApi<Run[]>('/runs')
  const tuning = useApi<TuningRun[]>('/tuning-runs')
  const datasets = useApi<Dataset[]>('/datasets')
  const group = section === 'runs'
    ? { label: '评测运行', items: (runs.data ?? []).slice(0, 12).map(run => ({ to: `/evaluation/runs/${run.id}`, label: run.name, title: run.name, sub: progress(run.status, run.completed, run.total) })) }
    : section === 'tuning'
      ? { label: '调优任务', items: (tuning.data ?? []).slice(0, 12).map(task => ({ to: `/evaluation/tuning/${task.id}`, label: task.name, title: task.name, sub: progress(task.status, task.completed, task.total, true) })) }
      : { items: [] }
  return <SideNav title="评测" label="评测工作区" groups={[
    { items: [
      { to: '/evaluation', label: '批量评测', count: runs.data?.length, current: section === 'runs' },
      { to: '/evaluation/tuning', label: '检索调优', count: tuning.data?.length, current: section === 'tuning' },
      { to: '/evaluation/retrieval', label: '检索对比', current: section === 'retrieval' },
      { to: '/evaluation/datasets', label: '评测题集', count: datasets.data?.length, current: section === 'datasets' },
    ] },
    group,
  ]} />
}

export function AdminSide() {
  const pending = useReviewCount()
  const users = useApi<UserAccount[]>('/admin/users')
  const decided = useApi<{ total: number }>('/admin/reviews/history?limit=1')
  return <SideNav title="管理" label="管理导航" groups={[
    { label: '审批', items: [
      { to: '/admin/reviews', label: '待审批', badge: pending, end: true },
      { to: '/admin/reviews/history', label: '已审批', count: decided.data?.total },
    ] },
    { label: '账号', items: [{ to: '/admin/users', label: '员工账号', count: users.data?.length }] },
    { label: '审计', items: [{ to: '/admin/query-logs', label: '查询日志' }, { to: '/admin/mcp-logs', label: 'MCP 调用日志' }] },
  ]} />
}

export function SettingsSide() {
  const profiles = useApi<ModelProfile[]>('/model-profiles')
  return <SideNav title="设置" label="设置导航" groups={[{ items: [
    { to: '/settings/models', label: '对话模型', count: profiles.data?.length },
    { to: '/settings/services', label: 'Embedding 与重排' },
    { to: '/settings/storage', label: '文档解析与向量库' },
    { to: '/settings/health', label: '环境检查' },
  ] }]} />
}

export function AccountSide() {
  const { user, signOut } = useAuth()
  const name = user?.display_name || user?.username || ''
  return <SideNav label="账户导航"
    header={<div className="flex items-center gap-2.5 mx-2 mb-4">
      <span className="w-9 h-9 rounded-full bg-ink text-white flex items-center justify-center font-semibold shrink-0" aria-hidden="true">{name.slice(0, 1)}</span>
      <span className="flex flex-col min-w-0"><span className="font-semibold truncate">{name}</span><span className="tm-faint text-xs truncate">{user?.username}，{user?.role === 'admin' ? '管理员' : '员工'}</span></span>
    </div>}
    groups={[{ items: [
      { to: '/account/profile', label: '个人资料' },
      { to: '/account/password', label: '修改密码' },
      { to: '/account/tokens', label: 'MCP 访问令牌' },
    ] }]}
    footer={<button type="button" className="tm-si" style={{ color: 'var(--tm-muted)' }} onClick={() => { void signOut() }}>退出登录</button>} />
}

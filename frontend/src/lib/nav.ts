import { BookOpen, FlaskConical, Lightbulb, MessageSquare, ScrollText, ShieldCheck, SlidersHorizontal, UserRound, Users, type LucideIcon } from 'lucide-react'

/** A sub-page of a module, shown as an underline tab under the page header. */
export interface ModuleTab { to: string; label: string; match?: string[]; admin?: boolean; count?: 'reviews-pending' | 'reviews-decided' }

export interface Module {
  key: string
  label: string
  to: string
  icon: LucideIcon
  /** Path prefixes that belong to this module. */
  match: string[]
  /** top: the work itself; bottom: governance and system pages, flat and pinned to the bottom of the sidebar. */
  placement: 'top' | 'bottom' | 'account'
  group?: string
  admin?: boolean
  tabs?: ModuleTab[]
}

export const MODULES: Module[] = [
  { key: 'chat', label: '问答', to: '/chat', icon: MessageSquare, match: ['/chat'], placement: 'top', group: '问答' },
  { key: 'knowledge', label: '知识库', to: '/knowledge', icon: BookOpen, match: ['/knowledge'], placement: 'top', group: '资料' },
  {
    key: 'memory', label: '记忆', to: '/memory', icon: Lightbulb, match: ['/memory'], placement: 'top', group: '资料',
    tabs: [{ to: '/memory', label: '我的记忆' }, { to: '/memory/consolidation', label: '自动整理', admin: true }],
  },
  {
    key: 'evaluation', label: '评测', to: '/evaluation', icon: FlaskConical, match: ['/evaluation', '/debug'], placement: 'bottom', admin: true,
    tabs: [
      { to: '/evaluation', label: '批量评测' },
      { to: '/evaluation/tuning', label: '检索调优' },
      { to: '/evaluation/retrieval', label: '检索对比' },
      { to: '/evaluation/datasets', label: '评测题集' },
    ],
  },
  {
    key: 'reviews', label: '审批', to: '/admin/reviews', icon: ShieldCheck, match: ['/admin/reviews'], placement: 'bottom', admin: true,
    tabs: [{ to: '/admin/reviews', label: '待审批', count: 'reviews-pending' }, { to: '/admin/reviews/history', label: '已审批', count: 'reviews-decided' }],
  },
  { key: 'users', label: '员工账号', to: '/admin/users', icon: Users, match: ['/admin/users'], placement: 'bottom', admin: true },
  {
    key: 'logs', label: '审计日志', to: '/admin/query-logs', icon: ScrollText, match: ['/admin/query-logs', '/admin/mcp-logs'], placement: 'bottom', admin: true,
    tabs: [{ to: '/admin/query-logs', label: '查询日志' }, { to: '/admin/mcp-logs', label: 'MCP 调用日志' }],
  },
  {
    key: 'settings', label: '设置', to: '/settings/models', icon: SlidersHorizontal, match: ['/settings'], placement: 'bottom', admin: true,
    tabs: [
      { to: '/settings/models', label: '对话模型' },
      { to: '/settings/services', label: 'Embedding 与重排' },
      { to: '/settings/storage', label: '文档解析与向量库' },
      { to: '/settings/health', label: '环境检查' },
    ],
  },
  {
    key: 'account', label: '我的账户', to: '/account/profile', icon: UserRound, match: ['/account'], placement: 'account',
    tabs: [{ to: '/account/profile', label: '个人资料' }, { to: '/account/password', label: '修改密码' }, { to: '/account/tokens', label: 'MCP 访问令牌' }],
  },
]

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** The module a path belongs to; the longest matching prefix wins. */
export function moduleFor(pathname: string): Module | undefined {
  let best: { module: Module; length: number } | undefined
  for (const module of MODULES) for (const prefix of module.match) {
    if (within(pathname, prefix) && (!best || prefix.length > best.length)) best = { module, length: prefix.length }
  }
  return best?.module
}

/** The module's tab for exactly this path, or undefined on detail pages (they show breadcrumbs instead). */
export function tabFor(module: Module | undefined, pathname: string): ModuleTab | undefined {
  return module?.tabs?.find(tab => pathname === tab.to || tab.match?.includes(pathname))
}

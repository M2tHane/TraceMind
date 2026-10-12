import { lazy, Suspense, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { BookOpen, Brain, FlaskConical, MessageSquare, Settings, ShieldCheck, UserRound } from 'lucide-react'
import { BrandMark, Empty, ErrorBoundary, Loading } from './components/ui'
import { SidebarContext } from './components/SidebarContext'
import { useApi } from './lib/api'
import { useAuth } from './lib/auth'
import type { Conversation } from './lib/types'

const ChatPage = lazy(() => import('./pages/Chat').then(module => ({ default: module.ChatPage })))
const KnowledgePage = lazy(() => import('./pages/Knowledge').then(module => ({ default: module.KnowledgePage })))
const KnowledgeDetail = lazy(() => import('./pages/Knowledge').then(module => ({ default: module.KnowledgeDetail })))
const DocumentDetail = lazy(() => import('./pages/Knowledge').then(module => ({ default: module.DocumentDetail })))
const DebugPage = lazy(() => import('./pages/Debug').then(module => ({ default: module.DebugPage })))
const DatasetsPage = lazy(() => import('./pages/Datasets').then(module => ({ default: module.DatasetsPage })))
const DatasetDetail = lazy(() => import('./pages/Datasets').then(module => ({ default: module.DatasetDetail })))
const RunsPage = lazy(() => import('./pages/Evaluation').then(module => ({ default: module.RunsPage })))
const RunDetail = lazy(() => import('./pages/Evaluation').then(module => ({ default: module.RunDetail })))
const TuningPage = lazy(() => import('./pages/Tuning').then(module => ({ default: module.TuningPage })))
const TuningDetail = lazy(() => import('./pages/Tuning').then(module => ({ default: module.TuningDetail })))
const MemoryPage = lazy(() => import('./pages/Memory').then(module => ({ default: module.MemoryPage })))
const SettingsPage = lazy(() => import('./pages/Settings').then(module => ({ default: module.SettingsPage })))
const AccountPage = lazy(() => import('./pages/Account').then(module => ({ default: module.AccountPage })))
const LoginPage = lazy(() => import('./pages/Account').then(module => ({ default: module.LoginPage })))
const ForcePasswordPage = lazy(() => import('./pages/Account').then(module => ({ default: module.ForcePasswordPage })))
const UsersPage = lazy(() => import('./pages/Admin').then(module => ({ default: module.UsersPage })))
const ReviewsPage = lazy(() => import('./pages/Admin').then(module => ({ default: module.ReviewsPage })))
const QueryLogsPage = lazy(() => import('./pages/Admin').then(module => ({ default: module.QueryLogsPage })))
const McpLogsPage = lazy(() => import('./pages/Admin').then(module => ({ default: module.McpLogsPage })))
const navItems = [
  { path: '/chat', label: '知识问答', icon: MessageSquare }, { path: '/knowledge', label: '知识库', icon: BookOpen }, { path: '/memory', label: '记忆', icon: Brain },
  { path: '/evaluation', label: '评测实验', icon: FlaskConical, admin: true }, { path: '/admin', label: '管理', icon: ShieldCheck, admin: true },
  { path: '/settings', label: '环境设置', icon: Settings, admin: true }, { path: '/account', label: '我的账户', icon: UserRound, mobileOnly: true },
]

function LegacyDebugRedirect() {
  const { search } = useLocation()
  return <Navigate to={`/evaluation/retrieval${search}`} replace />
}

export default function App() {
  const { user, loading, error } = useAuth()
  if (loading) return <Loading label="正在验证登录状态…" />
  if (error) return <Empty title="无法连接后端服务" description={error.message} />
  return <Suspense fallback={<Loading label="正在打开工作区…" />}>{!user ? <LoginPage /> : user.must_change_password ? <ForcePasswordPage /> : <Workspace />}</Suspense>
}

function Workspace() {
  const { user } = useAuth()
  const admin = user?.role === 'admin'
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 1024px)').matches)
  const history = useApi<Conversation[]>('/conversations', { poll: 15000 })
  const closeSidebar = () => setSidebarOpen(false)
  const closeOnMobile = () => { if (window.innerWidth < 1024) closeSidebar() }
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const change = () => setSidebarOpen(media.matches)
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !media.matches) setSidebarOpen(false)
    }
    media.addEventListener('change', change)
    document.addEventListener('keydown', escape)
    return () => { media.removeEventListener('change', change); document.removeEventListener('keydown', escape) }
  }, [])
  const items = navItems.filter(item => admin || !item.admin)
  const reviews = useApi<{ total: number }>('/admin/reviews/count', { enabled: admin, poll: 30000 })
  const badge = (path: string) => path === '/admin' && reviews.data?.total ? <span className="rail-badge" aria-label={`${reviews.data.total} 项待审批`}>{reviews.data.total}</span> : null
  const link = (item: typeof navItems[number]) => <NavLink key={item.path} to={item.path} title={item.label} onClick={closeOnMobile}
    className={({ isActive }) => `rail-link ${isActive ? 'rail-active' : ''}`}>
    <item.icon size={19} strokeWidth={1.7} /><span>{item.label}</span>{badge(item.path)}
  </NavLink>
  const navigation = items.filter(item => !item.mobileOnly).map(link)
  return <SidebarContext.Provider value={{ sidebarOpen, toggleSidebar: () => setSidebarOpen(open => !open), closeSidebar }}>
    <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <a className="skip-link" href="#main-content">跳转到主要内容</a>
      {sidebarOpen && <button type="button" className="sidebar-backdrop" aria-label="关闭侧栏" onClick={closeSidebar} />}
      <aside className="app-rail" aria-label="工作区侧栏">
        <NavLink to="/chat" className="brand" aria-label="TraceMind 首页" onClick={closeOnMobile}><BrandMark /><span className="brand-name">TraceMind</span></NavLink>
        <nav className="primary-nav" aria-label="主要导航">{navigation}</nav>
        <section className="rail-history" aria-label="对话历史">
          <h2>对话历史</h2>
          {history.isPending ? <p role="status">正在读取…</p> : history.isError ? <button className="text-link" onClick={() => { void history.refetch() }}>读取失败，重试</button>
            : !history.data?.length ? <p>暂无对话</p> : <div className="rail-history-list">{history.data.map(conversation =>
              <NavLink key={conversation.id} title={conversation.title} to={`/chat/${conversation.id}`} onClick={closeOnMobile}
                className={({ isActive }) => `rail-history-link ${isActive ? 'rail-history-active' : ''}`}>
                <span>{conversation.title}</span>
              </NavLink>)}</div>}
        </section>
        <div className="rail-account"><NavLink to="/account" onClick={closeOnMobile} title="我的账户"><span className="rail-avatar" aria-hidden="true">{(user?.display_name || user?.username || '?').slice(0, 1)}</span><span className="rail-account-text"><span>{user?.display_name || user?.username}</span><small>{admin ? '管理员' : '员工'} · 账户与令牌</small></span></NavLink></div>
      </aside>
      <nav className="mobile-nav" aria-label="移动导航">{items.map(link)}</nav>
      <main id="main-content" className="main-content"><ErrorBoundary><Suspense fallback={<Loading label="正在打开工作区…" />}><Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} /><Route path="/chat/:id" element={<ChatPage />} />
        {admin && <><Route path="/debug" element={<LegacyDebugRedirect />} /><Route path="/evaluation/retrieval" element={<DebugPage />} /></>}
        <Route path="/knowledge" element={<KnowledgePage />} /><Route path="/knowledge/:id" element={<KnowledgeDetail />} />
        <Route path="/knowledge/:id/documents/:documentId" element={<DocumentDetail />} />
        <Route path="/memory" element={<MemoryPage />} /><Route path="/memory/:scope" element={<MemoryPage />} />
        <Route path="/account" element={<AccountPage />} />
        {admin && <>
          <Route path="/evaluation" element={<RunsPage />} /><Route path="/evaluation/runs/:id" element={<RunDetail />} />
          <Route path="/evaluation/datasets" element={<DatasetsPage />} /><Route path="/evaluation/datasets/:id" element={<DatasetDetail />} />
          <Route path="/evaluation/tuning" element={<TuningPage />} /><Route path="/evaluation/tuning/:id" element={<TuningDetail />} />
          <Route path="/admin" element={<Navigate to="/admin/reviews" replace />} /><Route path="/admin/reviews" element={<ReviewsPage />} />
          <Route path="/admin/users" element={<UsersPage />} /><Route path="/admin/query-logs" element={<QueryLogsPage />} /><Route path="/admin/mcp-logs" element={<McpLogsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </>}
        <Route path="*" element={<Empty title="页面不存在" description="请选择左侧导航，返回工作区。" />} />
      </Routes></Suspense></ErrorBoundary></main>
    </div>
  </SidebarContext.Provider>
}

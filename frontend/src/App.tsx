import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Empty, ErrorBoundary, Loading } from './components/ui'
import { Page, Sidebar } from './components/shell/Shell'
import { UnsavedChangesDialog } from './components/shell/unsaved'
import { useAuth } from './lib/auth'

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
const MemoryConsolidationPage = lazy(() => import('./pages/Memory').then(module => ({ default: module.MemoryConsolidationPage })))
const ModelSettingsPage = lazy(() => import('./pages/Settings').then(module => ({ default: module.ModelSettingsPage })))
const ServiceSettingsPage = lazy(() => import('./pages/Settings').then(module => ({ default: module.ServiceSettingsPage })))
const StorageSettingsPage = lazy(() => import('./pages/Settings').then(module => ({ default: module.StorageSettingsPage })))
const HealthPage = lazy(() => import('./pages/Settings').then(module => ({ default: module.HealthPage })))
const ProfilePage = lazy(() => import('./pages/Account').then(module => ({ default: module.ProfilePage })))
const PasswordPage = lazy(() => import('./pages/Account').then(module => ({ default: module.PasswordPage })))
const TokensPage = lazy(() => import('./pages/Account').then(module => ({ default: module.TokensPage })))
const LoginPage = lazy(() => import('./pages/Account').then(module => ({ default: module.LoginPage })))
const ForcePasswordPage = lazy(() => import('./pages/Account').then(module => ({ default: module.ForcePasswordPage })))
const UsersPage = lazy(() => import('./pages/Admin').then(module => ({ default: module.UsersPage })))
const ReviewsPage = lazy(() => import('./pages/Admin').then(module => ({ default: module.ReviewsPage })))
const ReviewHistoryPage = lazy(() => import('./pages/Admin').then(module => ({ default: module.ReviewHistoryPage })))
const QueryLogsPage = lazy(() => import('./pages/AdminLogs').then(module => ({ default: module.QueryLogsPage })))
const McpLogsPage = lazy(() => import('./pages/AdminLogs').then(module => ({ default: module.McpLogsPage })))
const UiGallery = import.meta.env.DEV ? lazy(() => import('./dev/UiGallery').then(module => ({ default: module.UiGallery }))) : null

function LegacyDebugRedirect() {
  const { search } = useLocation()
  return <Navigate to={`/evaluation/retrieval${search}`} replace />
}

export default function App() {
  const { user, loading, error } = useAuth()
  const { pathname } = useLocation()
  if (UiGallery && pathname === '/__ui') return <Suspense fallback={null}><UiGallery /></Suspense>
  if (loading) return <Loading label="正在验证登录状态…" />
  if (error) return <Empty title="无法连接后端服务" description={error.message} />
  return <Suspense fallback={<Loading label="正在打开工作区…" />}>{!user ? <LoginPage /> : user.must_change_password ? <ForcePasswordPage /> : <Workspace />}</Suspense>
}

function Workspace() {
  const admin = useAuth().user?.role === 'admin'
  return <div className="tm-app">
    <a className="tm-skip" href="#main-content">跳转到主要内容</a>
    <Sidebar />
    <UnsavedChangesDialog />
    <ErrorBoundary><Suspense fallback={<main className="tm-main"><Loading label="正在打开工作区…" /></main>}><Routes>
      <Route path="/" element={<Navigate to="/chat" replace />} />
      <Route path="/chat" element={<ChatPage />} /><Route path="/chat/:id" element={<ChatPage />} />
      <Route path="/knowledge" element={<KnowledgePage />} />
      <Route path="/knowledge/:id" element={<KnowledgeDetail />} />
      <Route path="/knowledge/:id/documents/:documentId" element={<DocumentDetail />} />
      <Route path="/memory" element={<MemoryPage />} />
      {admin && <Route path="/memory/consolidation" element={<MemoryConsolidationPage />} />}
      <Route path="/memory/*" element={<Navigate to="/memory" replace />} />
      <Route path="/account" element={<Navigate to="/account/profile" replace />} />
      <Route path="/account/profile" element={<ProfilePage />} />
      <Route path="/account/password" element={<PasswordPage />} />
      <Route path="/account/tokens" element={<TokensPage />} />
      {admin && <>
        <Route path="/debug" element={<LegacyDebugRedirect />} />
        <Route path="/evaluation" element={<RunsPage />} />
        <Route path="/evaluation/runs/:id" element={<RunDetail />} />
        <Route path="/evaluation/retrieval" element={<DebugPage />} />
        <Route path="/evaluation/datasets" element={<DatasetsPage />} />
        <Route path="/evaluation/datasets/:id" element={<DatasetDetail />} />
        <Route path="/evaluation/tuning" element={<TuningPage />} />
        <Route path="/evaluation/tuning/:id" element={<TuningDetail />} />
        <Route path="/admin" element={<Navigate to="/admin/reviews" replace />} />
        <Route path="/admin/reviews" element={<ReviewsPage />} />
        <Route path="/admin/reviews/history" element={<ReviewHistoryPage />} />
        <Route path="/admin/users" element={<UsersPage />} />
        <Route path="/admin/query-logs" element={<QueryLogsPage />} />
        <Route path="/admin/mcp-logs" element={<McpLogsPage />} />
        <Route path="/settings" element={<Navigate to="/settings/models" replace />} />
        <Route path="/settings/models" element={<ModelSettingsPage />} />
        <Route path="/settings/services" element={<ServiceSettingsPage />} />
        <Route path="/settings/storage" element={<StorageSettingsPage />} />
        <Route path="/settings/health" element={<HealthPage />} />
      </>}
      <Route path="*" element={<Page title="未找到"><Empty title="页面不存在" /></Page>} />
    </Routes></Suspense></ErrorBoundary>
  </div>
}

// Shared helpers for the knowledge pages and their sidebar: cross-library document list, labels and time formats.
import { useQueries } from '@tanstack/react-query'
import { api, useApi } from './api'
import { useAuth } from './auth'
import type { Document, KnowledgeBase, RetrievalConfig, UserAccount } from './types'

/** Columns the API returns for a library beyond the typed `KnowledgeBase`. */
export type LibraryInfo = KnowledgeBase & { embedding_dimensions?: number }
export interface LibraryDocument extends Document { knowledge_base_name: string }

const ACTIVE_STATUSES = ['queued', 'processing']
export const isProcessing = (doc: Document): boolean => ACTIVE_STATUSES.includes(doc.status) && (doc.review_status ?? 'approved') === 'approved'
export const isFailed = (doc: Document): boolean => doc.status === 'failed'
export const documentsPath = (knowledgeBaseId: string): string => `/knowledge-bases/${knowledgeBaseId}/documents`

/**
 * Documents of every library, composed from the per-library list (there is no cross-library endpoint).
 * Shares cache keys with the library detail page.
 */
export function useLibraryDocuments(libraries: KnowledgeBase[] | undefined): { docs: LibraryDocument[]; byLibrary: Map<string, Document[]>; loaded: boolean } {
  const results = useQueries({
    queries: (libraries ?? []).map(kb => ({
      queryKey: [documentsPath(kb.id)],
      queryFn: ({ signal }: { signal: AbortSignal }) => api<Document[]>(documentsPath(kb.id), { signal }),
      refetchInterval: (query: { state: { data: Document[] | undefined } }) => query.state.data?.some(isProcessing) ? 4000 : 20000,
    })),
  })
  const byLibrary = new Map<string, Document[]>()
  const docs: LibraryDocument[] = []
  libraries?.forEach((kb, index) => {
    const data = results[index]?.data
    if (!data) return
    byLibrary.set(kb.id, data)
    for (const doc of data) docs.push({ ...doc, knowledge_base_name: kb.name })
  })
  return { docs, byLibrary, loaded: !!libraries && results.every(result => !result.isPending) }
}

/** Account names by id: the caller always, everyone for administrators (the only role that can list accounts). */
export function useAccountNames(): (id: string | null | undefined) => string | null {
  const { user } = useAuth()
  const admin = user?.role === 'admin'
  const users = useApi<UserAccount[]>('/admin/users', { enabled: admin })
  const names = new Map<string, string>()
  users.data?.forEach(account => names.set(account.id, account.display_name || account.username))
  if (user) names.set(user.id, user.display_name || user.username)
  return id => (id ? names.get(id) ?? null : null)
}

export function retrievalLabel(config: Partial<RetrievalConfig> | null | undefined): string {
  if (!config?.routes) return '混合 + 重排'
  const routes = config.routes
  const base = routes.length > 1 ? '混合' : routes[0] === 'bm25' ? '仅 BM25' : '仅向量'
  const rerank = config.rerank ?? true
  return rerank ? `${base} + 重排` : base
}

const pad = (value: number): string => String(value).padStart(2, '0')
/** “今天 09:12” for today, otherwise “10/11 18:30”. */
export function formatWhen(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const now = new Date()
  const today = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  return today ? `今天 ${clock}` : `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${clock}`
}
export function latest(values: (string | null | undefined)[]): string | undefined {
  let best: string | undefined
  for (const value of values) if (value && (!best || new Date(value).getTime() > new Date(best).getTime())) best = value
  return best
}
/** “4 分 12 秒” / “6 秒”. */
export function formatElapsed(from: string, to: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((to - new Date(from).getTime()) / 1000))
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
export function sourceLabel(sourceType: Document['source_type'] | undefined): string {
  return sourceType === 'markdown' ? 'Markdown 直接解析' : sourceType === 'text' ? '纯文本直接解析' : 'MinerU 解析'
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
}

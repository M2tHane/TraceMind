import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'ApiError' }
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试。' }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, { ...options, headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers } })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('无法连接后端服务，请检查服务是否在 8010 端口运行。', 0)
  }
  if (!response.ok) {
    // Session expired or revoked: the auth provider returns to the sign-in screen.
    if (response.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new Event('auth:unauthorized'))
    let detail: unknown
    try { const body: unknown = await response.json(); detail = typeof body === 'object' && body !== null && 'detail' in body ? body.detail : undefined } catch { detail = undefined }
    throw new ApiError(typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `请求失败（HTTP ${response.status}）`, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
export const remove = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' })
export const patch = <T>(path: string, body: unknown): Promise<T> => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
export const put = <T>(path: string, body: unknown): Promise<T> => api<T>(path, { method: 'PUT', body: JSON.stringify(body) })
export const post = <T>(path: string, body?: unknown): Promise<T> => api<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) })
export function useApi<T>(path: string, options: { enabled?: boolean; poll?: number | false } = {}) {
  return useQuery<T, Error>({ queryKey: [path], queryFn: ({ signal }) => api<T>(path, { signal }), enabled: options.enabled ?? true, refetchInterval: options.poll ?? false })
}
export function useAction<T, V>(action: (variables: V) => Promise<T>, options: { invalidate?: string[]; success?: string; onSuccess?: (result: T, variables: V) => void } = {}) {
  const client = useQueryClient()
  return useMutation<T, Error, V>({ mutationFn: action, onError: error => toast.error(error.message), onSuccess: (result, variables) => {
    for (const path of options.invalidate ?? []) void client.invalidateQueries({ queryKey: [path] })
    if (options.success) toast.success(options.success)
    options.onSuccess?.(result, variables)
  } })
}
export async function downloadExport(runId: string): Promise<void> {
  const payload = await api<unknown>(`/runs/${runId}/export`)
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `rag-run-${runId}.json`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function formatDate(value?: string): string { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date) }
export function formatNumber(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }
export function ratio(value: number | null | undefined): string { return value == null ? '未评分' : `${(value * 100).toFixed(1)}%` }

import { useMemo } from 'react'
import { useApi } from '../lib/api'
import type { Role, UserAccount } from '../lib/types'
import type { SelectChoice } from '../components/ui'

export const roleLabel = (role: Role | undefined): string => role === 'admin' ? '管理员' : '员工'

export interface PersonRef { username: string; display_name: string }
/** Display name when set, otherwise the username. */
export const personName = (person: PersonRef | null | undefined): string => person ? person.display_name || person.username || '—' : '—'

export type TimeRange = 'all' | 'today' | '7d' | '30d'
export const TIME_RANGE_OPTIONS: SelectChoice[] = [
  { value: 'all', label: '全部' }, { value: 'today', label: '今天' }, { value: '7d', label: '近 7 天' }, { value: '30d', label: '近 30 天' },
]
const RANGE_DAYS: Record<TimeRange, number> = { all: 0, today: 0, '7d': 6, '30d': 29 }

/** Local midnight, optionally some days back, as an ISO instant. */
export function localMidnight(daysBack = 0): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - daysBack)
  return date.toISOString()
}
/** Start of a time range at day granularity, so the request key stays stable while the page polls. */
export function useRangeStart(range: TimeRange): string | undefined {
  return useMemo(() => range === 'all' ? undefined : localMidnight(RANGE_DAYS[range]), [range])
}

const pad = (value: number): string => String(value).padStart(2, '0')
/** 10/12 04:16 */
export function formatStamp(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
/** Time only for today, date and time otherwise: 09:45:12 / 10/11 09:45. */
export function formatClock(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  return sameDay ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : formatStamp(value)
}
/** 2027/01/10 */
export function formatDay(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s` : `${Math.round(ms)} ms`
}

/** Accounts as filter options; the “全部” entry clears the filter. */
export function useUserChoices(): { users: UserAccount[]; choices: SelectChoice[] } {
  const accounts = useApi<UserAccount[]>('/admin/users')
  const users = accounts.data ?? []
  const choices = useMemo<SelectChoice[]>(() => [
    { value: '', label: '全部' },
    ...(accounts.data ?? []).map(user => ({ value: user.id, label: user.display_name || user.username, hint: user.display_name ? user.username : undefined })),
  ], [accounts.data])
  return { users, choices }
}

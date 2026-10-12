import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { Scope } from '../../lib/types'

export type TagTone = 'neutral' | 'ok' | 'run' | 'wait' | 'err' | 'warn' | 'platform' | 'personal' | 'ink'

export function Tag({ tone = 'neutral', children, className, title }: { tone?: TagTone; children: ReactNode; className?: string; title?: string }) {
  return <span className={clsx('tm-tag', tone !== 'neutral' && `tm-tag-${tone}`, className)} title={title}>{children}</span>
}

export function ScopeTag({ scope }: { scope: Scope }) {
  return <Tag tone={scope === 'platform' ? 'platform' : 'personal'}>{scope === 'platform' ? '平台' : '个人'}</Tag>
}

/** Monospace file-type label: PDF, MD, TXT. */
export function FileTypeTag({ filename }: { filename: string }) {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ''
  const label = ext === 'markdown' ? 'md' : ext || 'file'
  return <Tag className="tm-tag-file">{label}</Tag>
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中', processing: '处理中', ready: '已就绪', completed: '已完成', failed: '失败', running: '运行中', paused: '已暂停',
  parsing: '解析中', chunking: '分块中', embedding: '向量化中', indexing: '建索引中', generating: '生成回答', retrieving: '检索中',
  pending: '待审批', reviewed: '已审核', pending_review: '待管理员审批', rejected: '已驳回', approved: '已通过', active: '有效', disabled: '已停用',
  merged: '已合并', deleted: '已删除', deleting: '删除中', ok: '成功', configured: '已配置', error: '失败', not_configured: '未配置',
  skipped: '未检查', revoked: '已吊销', expired: '已过期',
}
const STATUS_TONES: Record<string, TagTone> = {
  ready: 'ok', completed: 'ok', reviewed: 'ok', ok: 'ok', configured: 'ok', approved: 'ok', active: 'ok',
  failed: 'err', error: 'err', not_configured: 'err', rejected: 'err', revoked: 'err', expired: 'err',
  queued: 'run', processing: 'run', running: 'run', parsing: 'run', chunking: 'run', embedding: 'run', indexing: 'run', generating: 'run', retrieving: 'run', deleting: 'run',
  pending: 'wait', pending_review: 'wait',
}
export function statusLabel(value: string): string { return STATUS_LABELS[value] ?? value }
export function statusTone(value: string): TagTone { return STATUS_TONES[value] ?? 'neutral' }

export function StatusTag({ value, label }: { value: string; label?: string }) {
  return <Tag tone={statusTone(value)}><span data-status={value} className="contents">{label ?? statusLabel(value)}</span></Tag>
}

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { post, useAction } from '../lib/api'
import type { ConnectionTest } from '../lib/configuration'
import { Button, ErrorState, Modal, StatusTag } from './ui'

/** Label above a single control, optional grey caption below (for example “原为 2048”). */
export function FormField({ label, caption, changed = false, children, className }: {
  label: string; caption?: ReactNode; changed?: boolean; children: ReactNode; className?: string
}) {
  return <label className={clsx('tm-field', className)} data-changed={changed || undefined}>
    <span className="tm-field-label">{label}</span>
    {children}
    {caption && <small className="tm-field-caption">{caption}</small>}
  </label>
}

interface SecretFieldProps {
  configured: boolean
  value: string
  clear: boolean
  onChange: (value: string) => void
  onClear: (clear: boolean) => void
}
export function SecretField({ configured, value, clear, onChange, onClear }: SecretFieldProps) {
  const id = useId()
  return <div className="tm-field">
    <label className="tm-field-label" htmlFor={id}>API Key</label>
    <input id={id} className="tm-input" aria-describedby={`${id}-hint`} type="password" autoComplete="new-password" spellCheck={false} value={value} disabled={clear}
      placeholder={configured ? '已保存，留空则保留原密钥' : '未配置'} onChange={event => onChange(event.target.value)} />
    <span id={`${id}-hint`} className="sr-only">{clear ? '保存后将清除密钥。' : '只写字段，不会回显；留空保留已保存的密钥。'}</span>
    <label className="tm-check-line"><input type="checkbox" className="tm-check" checked={clear} onChange={event => { onClear(event.target.checked); if (event.target.checked) onChange('') }} />清除已保存的密钥</label>
  </div>
}

interface TestConnectionProps {
  endpoint: string
  name: string
  paid?: boolean
  disabled?: boolean
}
/**
 * Test button with its result. Inside a flex row it lays out as `display: contents`: the button sits
 * with its siblings and the result wraps onto its own line.
 */
export function TestConnection({ endpoint, name, paid = false, disabled = false }: TestConnectionProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const probe = useAction(() => post<ConnectionTest>(endpoint, { confirm: paid }), { onSuccess: () => setConfirmOpen(false) })
  return <div className="tm-probe">
    <Button variant="secondary" disabled={disabled} busy={probe.isPending} onClick={() => { probe.reset(); if (paid) setConfirmOpen(true); else probe.mutate() }}>{paid ? '测试模型' : '测试连接'}</Button>
    {!disabled && probe.data && <div role="status" className="tm-probe-result"><StatusTag value={probe.data.success ? 'ok' : 'error'} /><span className="min-w-0">{probe.data.detail}</span><span className="tm-faint tm-num text-xs whitespace-nowrap">{Math.round(probe.data.latency_ms)} ms{probe.data.usage ? `，${probe.data.usage.total_tokens} tokens` : ''}</span></div>}
    {!disabled && probe.error && !confirmOpen && <div className="tm-probe-result"><ErrorState error={probe.error} /></div>}
    <Modal open={confirmOpen} onOpenChange={setConfirmOpen} title="确认模型测试" description="此操作可能产生模型调用费用。" preventClose={probe.isPending}>
      <div className="dialog-body space-y-5">
        <p className="text-sm leading-7">使用已保存的「{name}」配置发送一次短请求，可能产生模型调用费用。测试不发送知识库文档或对话内容，不会重发已发送的请求。</p>
        {probe.error && <ErrorState error={probe.error} />}
        <div className="dialog-actions"><Button variant="secondary" disabled={probe.isPending} onClick={() => setConfirmOpen(false)}>取消</Button><Button busy={probe.isPending} onClick={() => probe.mutate()}>确认并测试（可能计费）</Button></div>
      </div>
    </Modal>
  </div>
}

import { useId, useState } from 'react'
import { post, useAction } from '../lib/api'
import type { ConnectionTest } from '../lib/configuration'
import { Button, ErrorState, Modal, Status } from './ui'

interface SecretFieldProps {
  configured: boolean
  value: string
  clear: boolean
  onChange: (value: string) => void
  onClear: (clear: boolean) => void
}
export function SecretField({ configured, value, clear, onChange, onClear }: SecretFieldProps) {
  const id = useId()
  return <div className="space-y-3">
    <div className="field">
      <label className="field-label" htmlFor={id}>API Key</label>
      <input id={id} aria-describedby={`${id}-hint`} type="password" autoComplete="new-password" spellCheck={false} value={value} disabled={clear} placeholder={configured ? '••••••••（已保存）' : '未配置'} onChange={event => onChange(event.target.value)} />
      <span id={`${id}-hint`} className="text-xs text-slate-500 leading-relaxed">{clear ? '保存后将清除密钥。' : '只写字段，不会回显；留空保留已保存的密钥。'}</span>
    </div>
    <label className="checkbox-label"><input type="checkbox" checked={clear} onChange={event => { onClear(event.target.checked); if (event.target.checked) onChange('') }} />清除已保存的密钥</label>
  </div>
}

interface TestConnectionProps {
  endpoint: string
  name: string
  paid?: boolean
  disabled?: boolean
}
export function TestConnection({ endpoint, name, paid = false, disabled = false }: TestConnectionProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const probe = useAction(() => post<ConnectionTest>(endpoint, { confirm: paid }), { onSuccess: () => setConfirmOpen(false) })
  return <div className="config-probe">
    <Button variant="secondary" disabled={disabled} busy={probe.isPending} onClick={() => { probe.reset(); if (paid) setConfirmOpen(true); else probe.mutate() }}>{paid ? '测试模型' : '测试连接'}</Button>
    {disabled && <span className="text-xs text-slate-500">请先保存更改，再测试。</span>}
    {!disabled && probe.data && <div role="status" className="config-test-result"><Status value={probe.data.success ? 'ok' : 'error'} /><span>{probe.data.detail}</span><span className="text-xs text-slate-500">{Math.round(probe.data.latency_ms)} ms{probe.data.usage ? ` · ${probe.data.usage.total_tokens} tokens` : ''}</span></div>}
    {!disabled && probe.error && !confirmOpen && <ErrorState error={probe.error} />}
    <Modal open={confirmOpen} onOpenChange={setConfirmOpen} title="确认模型测试" description="此操作可能产生模型调用费用。" preventClose={probe.isPending}>
      <div className="dialog-body space-y-5">
        <p className="text-sm leading-7">使用已保存的「{name}」配置发送一次短请求，可能产生模型调用费用。测试不发送知识库文档或对话内容，不会重发已发送的请求。</p>
        {probe.error && <ErrorState error={probe.error} />}
        <div className="dialog-actions"><Button variant="secondary" disabled={probe.isPending} onClick={() => setConfirmOpen(false)}>取消</Button><Button busy={probe.isPending} onClick={() => probe.mutate()}>确认并测试（可能计费）</Button></div>
      </div>
    </Modal>
  </div>
}

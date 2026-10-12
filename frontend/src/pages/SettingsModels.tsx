import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api, useAction, useApi } from '../lib/api'
import { secretPatch, type ModelProfile, type ModelProfileInput, type ModelProtocol } from '../lib/configuration'
import { FormField, SecretField, TestConnection } from '../components/ConfigurationControls'
import { SettingsSide } from '../components/shell/ModuleNav'
import { Page } from '../components/shell/Shell'
import { Button, DataTable, Empty, ErrorState, Loading, Modal, Segmented, Tag, type Column } from '../components/ui'

const invalidate = ['/model-profiles', '/settings']
const PROTOCOLS: { value: ModelProtocol; label: string; long: string }[] = [
  { value: 'openai_chat', label: 'Chat Completions', long: 'Chat Completions' },
  { value: 'openai_responses', label: 'Responses', long: 'Responses' },
  { value: 'anthropic', label: 'Anthropic', long: 'Anthropic Messages' },
]
const protocolName = (value: ModelProtocol): string => PROTOCOLS.find(item => item.value === value)?.long ?? value

function toForm(profile?: ModelProfile): ModelProfileInput {
  return {
    name: profile?.name ?? '', model: profile?.model ?? '', protocol: profile?.protocol ?? 'openai_chat',
    base_url: profile?.base_url ?? '', max_tokens: profile?.max_tokens ?? 4096,
    timeout_seconds: profile?.timeout_seconds ?? 120, json_mode: profile?.json_mode ?? true,
    enabled: profile?.enabled ?? true, is_default: profile?.is_default ?? false,
  }
}

export function SettingsModels() {
  const profiles = useApi<ModelProfile[]>('/model-profiles')
  const [choice, setChoice] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null | undefined>(undefined)
  const dirty = useRef(false)
  const list = profiles.data ?? []
  const selectedId = choice === 'new' ? null : choice ?? list.find(profile => profile.is_default)?.id ?? list[0]?.id ?? null
  const profile = list.find(item => item.id === selectedId)
  const creating = choice === 'new' || (profiles.isSuccess && list.length === 0)

  const markDirty = useCallback((value: boolean) => { dirty.current = value }, [])
  function go(next: string | null): void {
    if (dirty.current) { setPending(next); return }
    setChoice(next)
  }
  function discardAndGo(): void {
    dirty.current = false
    setChoice(pending ?? null)
    setPending(undefined)
  }

  const columns: Column<ModelProfile>[] = [
    { key: 'name', header: '名称', nowrap: true, cell: item => <span className="inline-flex items-center gap-1.5 max-w-full">
      <button type="button" className="tm-linkbtn st-clip" title={item.name} onClick={() => go(item.id)}>{item.name}</button>
      {item.is_default && <Tag tone="ink">默认</Tag>}{!item.enabled && <Tag>已停用</Tag>}
    </span> },
    { key: 'protocol', header: '协议', cell: item => <span className="tm-muted">{protocolName(item.protocol)}</span>, nowrap: true },
    { key: 'model', header: '模型 ID', nowrap: true, cell: item => <span className="tm-mono st-clip" title={item.model}>{item.model}</span> },
    { key: 'url', header: '服务地址', nowrap: true, cell: item => <span className="tm-mono tm-muted st-clip" title={item.base_url}>{item.base_url}</span> },
    { key: 'key', header: '密钥', cell: item => item.api_key_set ? <Tag tone="ok">已保存</Tag> : <Tag tone="warn">未配置</Tag>, nowrap: true },
  ]

  return <Page side={<SettingsSide />} title="对话模型" bare actions={<Button variant="secondary" onClick={() => go('new')}><Plus size={14} />添加模型</Button>}>
    <div className="st-split">
      <section className="st-list" aria-label="对话模型列表">
        {profiles.isPending ? <Loading /> : profiles.isError ? <ErrorState error={profiles.error} retry={() => { void profiles.refetch() }} />
          : <div className="tm-panel ad-panel"><DataTable label="对话模型" columns={columns} rows={list} rowKey={item => item.id} selectedKey={creating ? null : selectedId} onRowClick={item => go(item.id)} minWidth={560}
            empty={<Empty title="尚未配置对话模型" description="添加服务地址与模型 ID 后，即可在问答中选择。" />} /></div>}
      </section>
      {(creating || profile) && <ModelPanel key={creating ? 'new' : `${profile!.id}-${profile!.updated_at}`} profile={creating ? undefined : profile}
        onDirty={markDirty} onSaved={saved => { dirty.current = false; setChoice(saved.id) }}
        onRemoved={() => { dirty.current = false; setChoice(null) }} onCancelNew={() => { dirty.current = false; setChoice(null) }} />}
    </div>
    <Modal open={pending !== undefined} onOpenChange={open => { if (!open) setPending(undefined) }} title="放弃更改">
      <div className="dialog-body space-y-5">
        <p className="text-sm leading-7">有尚未保存的更改，是否放弃？</p>
        <div className="dialog-actions"><Button variant="secondary" onClick={() => setPending(undefined)}>继续编辑</Button><Button variant="danger" onClick={discardAndGo}>放弃更改</Button></div>
      </div>
    </Modal>
  </Page>
}

function ModelPanel({ profile, onDirty, onSaved, onRemoved, onCancelNew }: {
  profile?: ModelProfile; onDirty: (dirty: boolean) => void; onSaved: (profile: ModelProfile) => void; onRemoved: () => void; onCancelNew: () => void
}) {
  const [initial] = useState(() => toForm(profile))
  const [form, setForm] = useState<ModelProfileInput>(initial)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [removing, setRemoving] = useState(false)
  const changed = {
    name: form.name !== initial.name, protocol: form.protocol !== initial.protocol, base_url: form.base_url !== initial.base_url, model: form.model !== initial.model,
    max_tokens: form.max_tokens !== initial.max_tokens, timeout_seconds: form.timeout_seconds !== initial.timeout_seconds, json_mode: form.json_mode !== initial.json_mode,
  }
  const dirty = JSON.stringify(initial) !== JSON.stringify(form) || !!key || clearKey
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
  const save = useAction((input: ModelProfileInput) => api<ModelProfile>(profile ? `/model-profiles/${profile.id}` : '/model-profiles', { method: profile ? 'PATCH' : 'POST', body: JSON.stringify(input) }),
    { invalidate, success: '模型配置已保存', onSuccess: saved => { setKey(''); onSaved(saved) } })
  const makeDefault = useAction((id: string) => api<ModelProfile>(`/model-profiles/${id}`, { method: 'PATCH', body: JSON.stringify({ is_default: true }) }), { invalidate, success: '默认模型已更新' })
  const remove = useAction((id: string) => api<void>(`/model-profiles/${id}`, { method: 'DELETE' }),
    { invalidate, success: '模型配置已删除，历史消息保持不变', onSuccess: () => { setRemoving(false); onRemoved() } })

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    save.mutate({ ...form, name: form.name.trim(), model: form.model.trim(), base_url: form.base_url.trim(), ...secretPatch(key, clearKey) })
  }
  function discard(): void {
    if (!profile) { onCancelNew(); return }
    setForm(initial); setKey(''); setClearKey(false)
  }
  const was = (text: string | number, mono = false) => <>原为 {mono ? <span className="tm-mono">{text}</span> : text}</>

  return <aside className="st-panel" aria-label={profile ? '编辑模型' : '添加模型'}>
    <div className="st-panel-head">
      <h2>{profile ? profile.name : '添加模型'}</h2>
      {profile?.is_default && <Tag tone="ink">默认</Tag>}
      <span className="flex-1" />
      {dirty && <Tag tone="warn">有未保存的更改</Tag>}
      {profile && <Button variant="icon" aria-label={`删除 ${profile.name}`} title={profile.is_default ? '请先设置其他默认模型' : '删除模型配置'} disabled={profile.is_default || remove.isPending}
        onClick={() => { remove.reset(); setRemoving(true) }}><Trash2 size={15} /></Button>}
    </div>
    <form id="model-form" className="st-form" aria-label="模型配置" onSubmit={handleSubmit}>
      <fieldset disabled={save.isPending} className="st-fields">
        <FormField label="名称" changed={changed.name} caption={profile && changed.name ? was(initial.name) : undefined}>
          <input className="tm-input" required maxLength={200} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
        </FormField>
        <div className="tm-field" data-changed={changed.protocol || undefined}>
          <span className="tm-field-label">协议</span>
          <Segmented block label="协议" value={form.protocol} onChange={value => setForm({ ...form, protocol: value })} items={PROTOCOLS.map(item => ({ value: item.value, label: item.label }))} />
          {profile && changed.protocol && <small className="tm-field-caption">{was(protocolName(initial.protocol))}</small>}
        </div>
        <FormField label="服务地址" changed={changed.base_url} caption={profile && changed.base_url ? was(initial.base_url, true) : undefined}>
          <input className="tm-input tm-mono" required type="url" value={form.base_url} onChange={event => setForm({ ...form, base_url: event.target.value })} />
        </FormField>
        <FormField label="模型 ID" changed={changed.model} caption={profile && changed.model ? was(initial.model, true) : undefined}>
          <input className="tm-input tm-mono" required value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} />
        </FormField>
        <SecretField configured={profile?.api_key_set ?? false} value={key} clear={clearKey} onChange={setKey} onClear={setClearKey} />
        <div className="st-pair">
          <FormField label="最大输出 tokens" changed={changed.max_tokens} caption={profile && changed.max_tokens ? was(initial.max_tokens) : undefined}>
            <input className="tm-input tm-num" required type="number" min={16} max={65536} step={1} value={form.max_tokens} onChange={event => setForm({ ...form, max_tokens: Number(event.target.value) })} />
          </FormField>
          <FormField label="超时（秒）" changed={changed.timeout_seconds} caption={profile && changed.timeout_seconds ? was(initial.timeout_seconds) : undefined}>
            <input className="tm-input tm-num" required type="number" min={5} max={600} step={1} value={form.timeout_seconds} onChange={event => setForm({ ...form, timeout_seconds: Number(event.target.value) })} />
          </FormField>
        </div>
        {form.protocol === 'anthropic'
          ? <p className="tm-muted st-note">当前 Anthropic 适配不使用原生 JSON 模式参数，通过提示词要求 JSON 输出并在本地校验。</p>
          : <label className="tm-switch-line"><span className="tm-switch"><input type="checkbox" checked={form.json_mode} onChange={event => setForm({ ...form, json_mode: event.target.checked })} /><span /></span>使用 JSON 输出模式</label>}
        <label className="tm-switch-line" title={form.is_default && profile ? '停用默认模型前，请先将其他模型设为默认。' : undefined}>
          <span className="tm-switch"><input type="checkbox" disabled={form.is_default} checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /><span /></span>启用模型
        </label>
        {!profile && <label className="tm-switch-line"><span className="tm-switch"><input type="checkbox" checked={form.is_default} onChange={event => setForm({ ...form, is_default: event.target.checked, enabled: event.target.checked || form.enabled })} /><span /></span>设为默认模型</label>}
      </fieldset>
      {save.error && <ErrorState error={save.error} />}
    </form>
    <div className="st-panel-foot">
      {profile && <TestConnection key={`${profile.id}-${profile.updated_at}`} endpoint={`/model-profiles/${profile.id}/test`} name={profile.name} paid />}
      {profile && !profile.is_default && <Button variant="secondary" disabled={!profile.enabled || makeDefault.isPending || dirty} onClick={() => makeDefault.mutate(profile.id)}>设为默认</Button>}
      <span className="flex-1" />
      <Button variant="ghost" disabled={save.isPending} onClick={discard}>{profile ? '放弃更改' : '取消'}</Button>
      <Button type="submit" form="model-form" busy={save.isPending} disabled={!!profile && !dirty}>保存模型</Button>
    </div>
    <Modal open={removing} onOpenChange={setRemoving} title="删除模型配置" preventClose={remove.isPending}>
      <div className="dialog-body space-y-5">
        <p className="text-sm leading-7">删除「{profile?.name}」后，新消息将无法选择它。已有消息保留原始模型记录。</p>
        {remove.error && <ErrorState error={remove.error} />}
        <div className="dialog-actions"><Button variant="secondary" disabled={remove.isPending} onClick={() => setRemoving(false)}>取消</Button><Button variant="danger" busy={remove.isPending} onClick={() => { if (profile) remove.mutate(profile.id) }}>确认删除</Button></div>
      </div>
    </Modal>
  </aside>
}

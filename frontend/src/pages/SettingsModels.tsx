import { useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, Server, Trash2 } from 'lucide-react'
import { api, useAction, useApi } from '../lib/api'
import { MODEL_PROTOCOLS, secretPatch, type ModelProfile, type ModelProfileInput, type ModelProtocol } from '../lib/configuration'
import { SecretField, TestConnection } from '../components/ConfigurationControls'
import { Select } from '../components/Select'
import { Button, Empty, ErrorState, Field, Loading, Modal } from '../components/ui'

const invalidate = ['/model-profiles', '/settings']

export function SettingsModels() {
  const profiles = useApi<ModelProfile[]>('/model-profiles')
  const [editing, setEditing] = useState<ModelProfile | 'new' | null>(null)
  const [removing, setRemoving] = useState<ModelProfile | null>(null)
  const makeDefault = useAction((id: string) => api<ModelProfile>(`/model-profiles/${id}`, { method: 'PATCH', body: JSON.stringify({ is_default: true }) }), { invalidate, success: '默认模型已更新' })
  const remove = useAction((id: string) => api<void>(`/model-profiles/${id}`, { method: 'DELETE' }), { invalidate, success: '模型配置已删除，历史消息保持不变', onSuccess: () => setRemoving(null) })
  return <section className="panel" aria-label="对话模型配置">
    <div className="panel-heading"><Server size={18} /><h2>对话模型</h2><Button className="ml-auto" variant="secondary" onClick={() => setEditing('new')}><Plus size={16} />添加模型</Button></div>
    <p className="text-sm text-slate-500 leading-6 py-3">可在每轮问答前切换已启用模型。默认配置用于未指定模型的请求；历史消息不会随配置更改。</p>
    {profiles.isPending ? <Loading /> : profiles.isError ? <ErrorState error={profiles.error} retry={() => { void profiles.refetch() }} /> : !profiles.data?.length ? <Empty title="尚未配置对话模型" description="添加服务地址与模型 ID 后，即可在问答中选择。" /> : <div className="divide-y">{profiles.data.map(profile => <article className="model-profile-row" key={profile.id} aria-label={profile.name}>
      <div className="model-profile-info"><h3 className="font-medium">{profile.name}{profile.is_default && <span className="model-default">默认</span>}</h3><p className="text-sm text-slate-500 break-words mt-1">{profile.model} · {MODEL_PROTOCOLS.find(item => item.value === profile.protocol)?.label ?? profile.protocol}</p><p className="text-xs text-slate-500 mt-2">{profile.enabled ? '已启用' : '已停用'} · {profile.api_key_set ? '密钥已保存' : '未配置密钥'}</p></div>
      <div className="model-profile-actions"><Button variant="secondary" onClick={() => setEditing(profile)}>编辑</Button>{!profile.is_default && <Button variant="ghost" disabled={!profile.enabled || makeDefault.isPending} onClick={() => makeDefault.mutate(profile.id)}>设为默认</Button>}<Button variant="ghost" aria-label={`删除 ${profile.name}`} disabled={profile.is_default || remove.isPending} title={profile.is_default ? '请先设置其他默认模型' : '删除模型配置'} onClick={() => { remove.reset(); setRemoving(profile) }}><Trash2 size={16} /></Button></div>
      <TestConnection key={`${profile.id}-${profile.updated_at}`} endpoint={`/model-profiles/${profile.id}/test`} name={profile.name} paid />
    </article>)}</div>}
    {makeDefault.error && <ErrorState error={makeDefault.error} />}
    {editing !== null && <ModelEditor profile={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    <Modal open={!!removing} onOpenChange={open => { if (!open) setRemoving(null) }} title="删除模型配置" preventClose={remove.isPending}>
      <div className="dialog-body space-y-5"><p className="text-sm leading-7">删除「{removing?.name}」后，新消息将无法选择它。已有消息保留原始模型记录。</p>{remove.error && <ErrorState error={remove.error} />}<div className="dialog-actions"><Button variant="secondary" disabled={remove.isPending} onClick={() => setRemoving(null)}>取消</Button><Button variant="danger" busy={remove.isPending} onClick={() => { if (removing) remove.mutate(removing.id) }}>确认删除</Button></div></div>
    </Modal>
  </section>
}

function ModelEditor({ profile, onClose }: { profile?: ModelProfile; onClose: () => void }) {
  const [form, setForm] = useState<ModelProfileInput>(() => ({
    name: profile?.name ?? '', model: profile?.model ?? '', protocol: profile?.protocol ?? 'openai_chat',
    base_url: profile?.base_url ?? '', max_tokens: profile?.max_tokens ?? 4096,
    timeout_seconds: profile?.timeout_seconds ?? 120, json_mode: profile?.json_mode ?? true,
    enabled: profile?.enabled ?? true, is_default: profile?.is_default ?? false,
  }))
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [initial] = useState(form)
  const dirty = JSON.stringify(initial) !== JSON.stringify(form) || !!key || clearKey
  const save = useAction((input: ModelProfileInput) => api<ModelProfile>(profile ? `/model-profiles/${profile.id}` : '/model-profiles', { method: profile ? 'PATCH' : 'POST', body: JSON.stringify(input) }), { invalidate, success: '模型配置已保存', onSuccess: () => { setKey(''); onClose() } })
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    save.mutate({ ...form, name: form.name.trim(), model: form.model.trim(), base_url: form.base_url.trim(), ...secretPatch(key, clearKey) })
  }
  function handleClose(): void { if (dirty) setDiscard(true); else onClose() }
  return <Modal open onOpenChange={open => { if (!open) handleClose() }} title={profile ? '编辑模型' : '添加模型'} preventClose={save.isPending}>
    <form className="dialog-body space-y-5" onSubmit={handleSubmit}>
      <fieldset disabled={save.isPending} className="space-y-4">
        <Field label="显示名称"><input required maxLength={200} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="API 协议"><Select label="API 协议" value={form.protocol} onChange={value => setForm({ ...form, protocol: value as ModelProtocol })} options={MODEL_PROTOCOLS} /></Field>
        <Field label="服务地址" hint="填写服务的 API 基础地址，不含具体请求路径。"><input required type="url" value={form.base_url} onChange={event => setForm({ ...form, base_url: event.target.value })} /></Field>
        <Field label="模型 ID"><input required value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} /></Field>
        <SecretField configured={profile?.api_key_set ?? false} value={key} clear={clearKey} onChange={setKey} onClear={setClearKey} />
        <div className="config-field-grid"><Field label="最大输出 tokens"><input required type="number" min={16} max={65536} step={1} value={form.max_tokens} onChange={event => setForm({ ...form, max_tokens: Number(event.target.value) })} /></Field><Field label="超时（秒）"><input required type="number" min={5} max={600} step={1} value={form.timeout_seconds} onChange={event => setForm({ ...form, timeout_seconds: Number(event.target.value) })} /></Field></div>
        {form.protocol === 'anthropic' ? <p className="text-sm text-slate-500 leading-6">当前 Anthropic 适配不使用原生 JSON 模式参数，通过提示词要求 JSON 输出并在本地校验。</p> : <label className="checkbox-label"><input type="checkbox" checked={form.json_mode} onChange={event => setForm({ ...form, json_mode: event.target.checked })} />使用 JSON 输出模式</label>}
        <label className="checkbox-label"><input type="checkbox" disabled={form.is_default} checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /><span>启用模型{form.is_default && <small>停用默认模型前，请先将其他模型设为默认。</small>}</span></label>
        <label className="checkbox-label"><input type="checkbox" disabled={profile?.is_default} checked={form.is_default} onChange={event => setForm({ ...form, is_default: event.target.checked, enabled: event.target.checked || form.enabled })} />设为默认模型</label>
      </fieldset>
      {save.error && <ErrorState error={save.error} />}
      {discard && <div role="alert" className="space-y-3"><p className="text-sm">有尚未保存的更改，是否放弃？</p><div className="flex gap-2"><Button variant="secondary" onClick={() => setDiscard(false)}>继续编辑</Button><Button variant="danger" onClick={onClose}>放弃更改</Button></div></div>}
      <div className="dialog-actions"><Button variant="secondary" disabled={save.isPending} onClick={handleClose}>取消</Button><Button type="submit" busy={save.isPending} disabled={!!profile && !dirty}>保存模型</Button></div>
    </form>
  </Modal>
}

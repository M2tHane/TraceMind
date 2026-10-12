import { useState } from 'react'
import type { FormEvent } from 'react'
import { CheckCircle2, Database, ExternalLink, LockKeyhole, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { api, post, useAction, useApi } from '../lib/api'
import type { ServiceCheck, Settings } from '../lib/types'
import { secretPatch, type RerankProtocol, type ServiceSettingsPatch } from '../lib/configuration'
import { SecretField, TestConnection } from '../components/ConfigurationControls'
import { Select } from '../components/Select'
import { Button, ErrorState, Field, Loading, Notice, PageHeader, Status } from '../components/ui'
import { SettingsModels } from './SettingsModels'

type Service = 'embedding' | 'rerank' | 'mineru' | 'milvus'
const SERVICES: { id: Service; name: string; description: string }[] = [
  { id: 'embedding', name: 'Embedding', description: '文档索引与语义检索' },
  { id: 'rerank', name: 'Rerank', description: '候选上下文相关性排序' },
  { id: 'mineru', name: 'MinerU', description: 'PDF 文档解析' },
  { id: 'milvus', name: 'Milvus', description: '向量存储与检索' },
]

export function SettingsPage() {
  const settings = useApi<Settings>('/settings')
  const check = useAction(() => post<{ checks: ServiceCheck[] }>('/settings/check'), { success: '环境检查已完成' })
  const data = settings.data
  return <div className="page model-settings-page">
    <PageHeader title="环境与设置" description="管理模型与服务。密钥仅写入后端，不会回显。" actions={<Button variant="secondary" busy={check.isPending} onClick={() => check.mutate()}><RefreshCw size={15} />环境检查（不计费）</Button>} />
    <div className="settings-layout">
      <div className="space-y-8">
        <SettingsModels />
        {settings.isPending ? <Loading /> : settings.isError ? <ErrorState error={settings.error} retry={() => { void settings.refetch() }} /> : data && <section className="panel" aria-label="服务配置">
          <div className="panel-heading"><Database size={18} /><h2>解析、检索与存储</h2></div>
          <p className="text-sm text-slate-500 py-3 leading-6">先保存，再测试。更改对新的操作生效，不会自动重建索引。</p>
          {!data.editable && <Notice>当前后端尚未启用在线配置，请更新后端后刷新。</Notice>}
          <div className="divide-y">{SERVICES.map(service => <details key={service.id} className="service-editor"><summary><span><strong>{service.name}</strong><span className="text-sm text-slate-500">{service.description}</span></span></summary><ServiceEditor service={service.id} name={service.name} settings={data} /></details>)}</div>
        </section>}
        {check.error && <ErrorState error={check.error} />}
        {check.data && <section className="panel"><div className="panel-heading"><CheckCircle2 size={18} /><h2>环境检查结果</h2></div><div className="divide-y">{check.data.checks.map((item, index) => <div className="py-4 flex items-start gap-4" key={`${item.name}-${index}`}><div className="flex-1 min-w-0"><p className="font-medium text-sm">{item.name}</p><p className="text-sm text-slate-500 mt-2 break-words leading-6">{item.detail}</p></div><Status value={item.status} /></div>)}</div></section>}
      </div>
      <aside className="space-y-7">
        <section className="panel"><div className="panel-heading"><Database size={18} /><h2>PostgreSQL</h2></div><p className="text-sm text-slate-500 leading-7 py-3">数据库连接仅在后端启动时配置，不支持在浏览器中热切换。修改启动配置后需重启后端。</p><TestConnection endpoint="/settings/test/postgres" name="PostgreSQL" /></section>
        <section className="panel"><div className="flex gap-2 items-center font-medium text-sm"><LockKeyhole size={16} />凭据与调用</div><p className="text-sm text-slate-500 leading-7 mt-3">密钥只用于写入后端，页面仅显示是否已保存。留空保留原密钥，勾选清除后保存才会删除。</p><p className="text-sm text-slate-500 leading-7 mt-3">模型测试需单独确认，可能计费。MinerU、Milvus 和 PostgreSQL 仅检查连接；环境检查不调用付费模型。</p><p className="text-sm text-slate-500 leading-7 mt-3">若使用远程模型，问答中的问题与相关文档片段会发送到对应服务，请确认其数据政策。</p><a className="text-link text-sm mt-4" href="/api/health" target="_blank" rel="noopener noreferrer">查看健康检查 JSON<ExternalLink size={12} /></a></section>
      </aside>
    </div>
  </div>
}

interface ServiceForm {
  model: string
  base_url: string
  dimensions: number
  protocol: RerankProtocol
  uri: string
  collection: string
}
function readService(service: Service, settings: Settings): ServiceForm {
  const config = settings[service]
  return {
    model: config && 'model' in config ? config.model : '',
    base_url: config && 'base_url' in config ? config.base_url : '',
    dimensions: settings.embedding.dimensions,
    protocol: settings.rerank.protocol,
    uri: settings.milvus?.uri ?? '', collection: settings.milvus?.collection ?? '',
  }
}
function ServiceEditor({ service, name, settings }: { service: Service; name: string; settings: Settings }) {
  const client = useQueryClient()
  const [form, setForm] = useState(() => readService(service, settings))
  const [saved, setSaved] = useState(form)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [revision, setRevision] = useState(0)
  const isModel = service === 'embedding' || service === 'rerank'
  const dirty = JSON.stringify(form) !== JSON.stringify(saved) || !!key || clearKey
  const save = useAction((patch: ServiceSettingsPatch) => api<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }), {
    success: `${name} 配置已保存`,
    onSuccess: result => {
      const next = readService(service, result)
      setForm(next); setSaved(next); setKey(''); setClearKey(false); setRevision(value => value + 1)
      client.setQueryData(['/settings'], result)
    },
  })
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const credentials = secretPatch(key, clearKey)
    const base_url = form.base_url.trim()
    const model = form.model.trim()
    const patch: ServiceSettingsPatch = service === 'embedding' ? { embedding: { base_url, model, dimensions: form.dimensions, ...credentials } }
      : service === 'rerank' ? { rerank: { base_url, model, protocol: form.protocol, ...credentials } }
        : service === 'mineru' ? { mineru: { base_url } }
          : { milvus: { uri: form.uri.trim(), collection: form.collection.trim() } }
    save.mutate(patch)
  }
  return <form className="space-y-4 pb-5" aria-label={`${name} 配置`} onSubmit={handleSubmit}>
    {service === 'embedding' && <Notice>更改模型、维度或地址可能使已有知识库索引不兼容。请确认兼容性，或重新建立索引；保存不会自动重建。</Notice>}
    <fieldset className="space-y-4" disabled={save.isPending || !settings.editable}>
      {service !== 'milvus' && <Field label="服务地址"><input type="url" required value={form.base_url} onChange={event => setForm({ ...form, base_url: event.target.value })} /></Field>}
      {isModel && <><Field label="模型 ID"><input required value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} /></Field><SecretField configured={service === 'embedding' ? settings.embedding.configured : settings.rerank.configured} value={key} clear={clearKey} onChange={setKey} onClear={setClearKey} /></>}
      {service === 'embedding' && <Field label="向量维度"><input required type="number" min={1} step={1} value={form.dimensions} onChange={event => setForm({ ...form, dimensions: Number(event.target.value) })} /></Field>}
      {service === 'rerank' && <Field label="重排序协议"><Select label="重排序协议" value={form.protocol} options={[{ value: 'dashscope', label: 'DashScope' }, { value: 'standard', label: 'Standard' }]} onChange={value => setForm({ ...form, protocol: value as RerankProtocol })} /></Field>}
      {service === 'milvus' && <><Field label="连接 URI"><input required value={form.uri} onChange={event => setForm({ ...form, uri: event.target.value })} /></Field><Field label="Collection" hint="必须以 rag_workbench_ 开头；已有数据不会自动迁移。"><input required pattern="rag_workbench_.+" value={form.collection} onChange={event => setForm({ ...form, collection: event.target.value })} /></Field></>}
      <div className="flex flex-wrap gap-3 items-center"><Button type="submit" busy={save.isPending} disabled={!dirty}>保存配置</Button>{dirty && <span className="text-xs text-slate-500">有未保存的更改</span>}</div>
    </fieldset>
    {save.error && <ErrorState error={save.error} />}
    <TestConnection key={revision} endpoint={`/settings/test/${service}`} name={name} paid={isModel} disabled={dirty || save.isPending} />
  </form>
}

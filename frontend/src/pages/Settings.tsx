import { useState } from 'react'
import type { FormEvent } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { api, post, useAction, useApi } from '../lib/api'
import type { ServiceCheck, Settings } from '../lib/types'
import { secretPatch, type RerankProtocol, type ServiceSettingsPatch } from '../lib/configuration'
import { FormField, SecretField, TestConnection } from '../components/ConfigurationControls'
import { SettingsSide } from '../components/shell/ModuleNav'
import { Page } from '../components/shell/Shell'
import { Button, DataTable, Empty, ErrorState, Loading, Notice, Segmented, StatusTag, Tag, buttonClass } from '../components/ui'
import { SettingsModels } from './SettingsModels'

type Service = 'embedding' | 'rerank' | 'mineru' | 'milvus'
const SERVICES: Record<Service, { name: string; description: string }> = {
  embedding: { name: 'Embedding', description: '文档索引与语义检索' },
  rerank: { name: 'Rerank', description: '候选上下文相关性排序' },
  mineru: { name: 'MinerU', description: 'PDF 文档解析' },
  milvus: { name: 'Milvus', description: '向量存储与检索' },
}

export function ModelSettingsPage() {
  return <SettingsModels />
}

function ServiceGroup({ services }: { services: Service[] }) {
  const settings = useApi<Settings>('/settings')
  const data = settings.data
  if (settings.isPending) return <Loading />
  if (settings.isError) return <ErrorState error={settings.error} retry={() => { void settings.refetch() }} />
  return <>
    {!data!.editable && <Notice>当前后端尚未启用在线配置，请更新后端后刷新。</Notice>}
    <div className="st-services">{services.map(id => <ServiceEditor key={id} service={id} name={SERVICES[id].name} settings={data!} />)}</div>
  </>
}

export function ServiceSettingsPage() {
  return <Page side={<SettingsSide />} title="Embedding 与重排"><ServiceGroup services={['embedding', 'rerank']} /></Page>
}

export function StorageSettingsPage() {
  return <Page side={<SettingsSide />} title="文档解析与向量库">
    <ServiceGroup services={['mineru', 'milvus']} />
    <section className="tm-panel st-service" aria-label="PostgreSQL 配置">
      <div className="tm-panel-title"><h2>PostgreSQL</h2></div>
      <div className="st-service-body">
        <p className="tm-muted m-0">数据库连接仅在后端启动时配置，不支持在浏览器中热切换。修改启动配置后需重启后端。</p>
        <div className="st-service-foot"><TestConnection endpoint="/settings/test/postgres" name="PostgreSQL" /></div>
      </div>
    </section>
  </Page>
}

const CHECK_COLUMNS = [
  { key: 'name', header: '检查项', cell: (item: ServiceCheck) => <span className="font-medium">{item.name}</span>, nowrap: true, width: 220 },
  { key: 'status', header: '结果', cell: (item: ServiceCheck) => <StatusTag value={item.status} />, nowrap: true, width: 120 },
  { key: 'detail', header: '详情', cell: (item: ServiceCheck) => <span className="tm-muted break-words">{item.detail}</span> },
]

export function HealthPage() {
  const check = useAction(() => post<{ checks: ServiceCheck[] }>('/settings/check'), { success: '环境检查已完成' })
  return <Page side={<SettingsSide />} title="环境检查" actions={<>
    <a className={buttonClass('secondary')} href="/api/health" target="_blank" rel="noopener noreferrer">健康检查 JSON<ExternalLink size={13} /></a>
    <Button busy={check.isPending} onClick={() => check.mutate()}><RefreshCw size={14} />环境检查（不计费）</Button>
  </>}>
    {check.error && <ErrorState error={check.error} />}
    {check.data
      ? <section className="tm-panel ad-panel" aria-label="环境检查结果"><DataTable columns={CHECK_COLUMNS} rows={check.data.checks} rowKey={item => item.name} label="环境检查结果" /></section>
      : !check.error && <section className="tm-panel"><Empty title="尚未运行环境检查" /></section>}
  </Page>
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
  const configured = service === 'embedding' ? settings.embedding.configured : service === 'rerank' ? settings.rerank.configured : undefined
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
  return <section className="tm-panel st-service">
    <div className="tm-panel-title">
      <h2>{name}</h2><span className="tm-muted">{SERVICES[service].description}</span>
      <span className="flex-1" />
      {dirty && <Tag tone="warn">有未保存的更改</Tag>}
      {configured !== undefined && <Tag tone={configured ? 'ok' : 'warn'}>{configured ? '密钥已保存' : '未配置密钥'}</Tag>}
    </div>
    <form className="st-service-body" aria-label={`${name} 配置`} onSubmit={handleSubmit}>
      {service === 'embedding' && <p className="tm-note m-0">更改模型、维度或地址可能使已有知识库索引不兼容。请确认兼容性，或重新建立索引；保存不会自动重建。</p>}
      <fieldset className="st-fields" disabled={save.isPending || !settings.editable}>
        {service !== 'milvus' && <FormField label="服务地址"><input className="tm-input tm-mono" type="url" required value={form.base_url} onChange={event => setForm({ ...form, base_url: event.target.value })} /></FormField>}
        {isModel && <>
          <FormField label="模型 ID"><input className="tm-input tm-mono" required value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} /></FormField>
          <SecretField configured={configured ?? false} value={key} clear={clearKey} onChange={setKey} onClear={setClearKey} />
        </>}
        {service === 'embedding' && <FormField label="向量维度"><input className="tm-input tm-num" required type="number" min={1} step={1} value={form.dimensions} onChange={event => setForm({ ...form, dimensions: Number(event.target.value) })} /></FormField>}
        {service === 'rerank' && <div className="tm-field"><span className="tm-field-label">重排序协议</span>
          <Segmented label="重排序协议" value={form.protocol} onChange={value => setForm({ ...form, protocol: value })} items={[{ value: 'dashscope', label: 'DashScope' }, { value: 'standard', label: 'Standard' }]} /></div>}
        {service === 'milvus' && <>
          <FormField label="连接 URI"><input className="tm-input tm-mono" required value={form.uri} onChange={event => setForm({ ...form, uri: event.target.value })} /></FormField>
          <FormField label="Collection" caption="必须以 rag_workbench_ 开头；已有数据不会自动迁移。"><input className="tm-input tm-mono" required pattern="rag_workbench_.+" value={form.collection} onChange={event => setForm({ ...form, collection: event.target.value })} /></FormField>
        </>}
      </fieldset>
      {save.error && <ErrorState error={save.error} />}
      <div className="st-service-foot">
        <Button type="submit" busy={save.isPending} disabled={!dirty || !settings.editable}>保存配置</Button>
        <TestConnection key={revision} endpoint={`/settings/test/${service}`} name={name} paid={isModel} disabled={dirty || save.isPending} />
      </div>
    </form>
  </section>
}

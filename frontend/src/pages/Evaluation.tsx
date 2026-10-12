import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { downloadExport, formatDate, formatNumber, post, useAction, useApi } from '../lib/api'
import { methodLabel, type EvalItem, type Method, type Run, type SummaryMethod } from '../lib/types'
import {
  Button, DataTable, Drawer, Empty, ErrorState, FactStrip, JsonDetails, Loading, Pager, SearchableSelect, Segmented, StatusTag, Tag,
  type Column,
} from '../components/ui'
import { Markdown, ResultView } from '../components/sources'
import { Page } from '../components/shell/Shell'
import { FieldSelect, FormField, MethodChecks, datasetOptions, formatCount, formatMs, kbOptions, methodColor, pct, useNames } from './evalShared'

interface RunInput { name: string; knowledge_base_id: string; dataset_id: string; methods: Method[]; limit: number; judge_enabled: boolean }

function CreateRun({ onCreated, onClose }: { onCreated: (run: Run) => void; onClose: () => void }) {
  const { kbs, datasets } = useNames()
  const [name, setName] = useState('')
  const [kbId, setKbId] = useState('')
  const [datasetId, setDatasetId] = useState('')
  const [limit, setLimit] = useState(10)
  const [methods, setMethods] = useState<Method[]>(['bm25', 'hybrid_rerank'])
  const [judge, setJudge] = useState(false)
  const create = useAction((body: RunInput) => post<Run>('/runs', body), { invalidate: ['/runs'], success: '评测已创建，后台开始执行', onSuccess: onCreated })
  const dataset = datasets.data?.find(item => item.id === datasetId)
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); if (create.isPending) return
    create.mutate({ name: name.trim(), knowledge_base_id: kbId, dataset_id: datasetId, methods, limit, judge_enabled: judge })
  }
  return <Drawer open onOpenChange={open => { if (!open && !create.isPending) onClose() }} title="新建评测" width={480}
    footer={<div className="ev-actions">
      <Button variant="secondary" disabled={create.isPending} onClick={onClose}>取消</Button>
      <Button type="submit" form="run-form" busy={create.isPending} disabled={!name.trim() || !kbId || !datasetId || !methods.length || !dataset?.question_count}>创建并运行</Button>
    </div>}>
    <form id="run-form" className="ev-form ev-form-flush" onSubmit={handleSubmit}>
      <fieldset disabled={create.isPending} className="ev-fieldset ev-form-fields">
        <FormField label="评测名称"><input className="tm-input" required maxLength={200} placeholder="例如：混合检索与重排对比" value={name} onChange={event => setName(event.target.value)} autoFocus /></FormField>
        <FormField label="知识库"><FieldSelect label="知识库" placeholder="选择知识库" options={kbOptions(kbs.data, true)} value={kbId} onChange={setKbId} /></FormField>
        <FormField label="题集"><FieldSelect label="题集" placeholder="选择题集" options={datasetOptions(datasets.data)} value={datasetId} onChange={setDatasetId} /></FormField>
        {kbs.isError && <ErrorState error={kbs.error} retry={() => { void kbs.refetch() }} />}
        {datasets.isError && <ErrorState error={datasets.error} retry={() => { void datasets.refetch() }} />}
        <MethodChecks selected={methods} onChange={setMethods} />
        <FormField label="本次题数上限" hint={`每题调用 ${methods.length} 种方法`}><input className="tm-input" type="number" min={1} max={1000} required value={limit} onChange={event => setLimit(Number(event.target.value))} /></FormField>
        <label className="ev-check"><input type="checkbox" className="tm-check" checked={judge} onChange={event => setJudge(event.target.checked)} /><span>启用模型裁判<small className="tm-faint">额外调用模型</small></span></label>
      </fieldset>
      {create.error && <ErrorState error={create.error} />}
    </form>
  </Drawer>
}

type RunFilter = 'all' | 'active' | 'completed' | 'paused' | 'failed'
const RUN_FILTERS: Record<Exclude<RunFilter, 'all'>, string[]> = { active: ['queued', 'running'], completed: ['completed'], paused: ['paused'], failed: ['failed'] }

export function RunsPage() {
  const runs = useApi<Run[]>('/runs', { poll: 5000 })
  const { kbName, datasetName } = useNames()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<RunFilter>('all')
  const [kbId, setKbId] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const navigate = useNavigate()
  const all = runs.data ?? []
  const counts = (filter: RunFilter): number => filter === 'all' ? all.length : all.filter(run => RUN_FILTERS[filter].includes(run.status)).length
  const visible = all.filter(run => (status === 'all' || RUN_FILTERS[status].includes(run.status)) && (!kbId || run.knowledge_base_id === kbId) && run.name.toLowerCase().includes(search.trim().toLowerCase()))
  const pages = Math.max(1, Math.ceil(visible.length / pageSize))
  const current = Math.min(page, pages)
  const kbChoices = useMemo(() => [{ value: '', label: '全部' }, ...[...new Set(all.map(run => run.knowledge_base_id))].map(id => ({ value: id, label: kbName(id) }))], [all, kbName])
  const columns: Column<Run>[] = [
    { key: 'name', header: '评测名称', cell: run => <Link to={`/evaluation/runs/${run.id}`} className="tm-linkbtn">{run.name}</Link> },
    { key: 'status', header: '状态', nowrap: true, cell: run => <StatusTag value={run.status} /> },
    { key: 'progress', header: '进度', nowrap: true, cell: run => <><span className="tm-num">{run.completed} / {run.total}</span>{run.failed > 0 && <span className="tm-table-sub ev-fail">失败 {run.failed}</span>}</> },
    { key: 'methods', header: '对比方法', cell: run => <span className="ev-tags">{run.methods.map(method => <Tag key={method}>{methodLabel(method)}</Tag>)}</span> },
    { key: 'kb', header: '知识库', cell: run => kbName(run.knowledge_base_id) },
    { key: 'dataset', header: '题集', cell: run => datasetName(run.dataset_id) },
    { key: 'judge', header: '模型裁判', nowrap: true, cell: run => run.judge_enabled ? '开启' : <span className="tm-faint">关闭</span> },
    { key: 'created', header: '创建时间', nowrap: true, cell: run => <span className="tm-faint tm-num">{formatDate(run.created_at)}</span> },
  ]
  const newRun = <Button onClick={() => setOpen(true)}><Plus size={15} />新建评测</Button>
  return <Page title="批量评测" actions={newRun}>
    {runs.isPending ? <Loading /> : runs.isError ? <ErrorState error={runs.error} retry={() => { void runs.refetch() }} /> : !all.length
      ? <div className="tm-panel"><Empty title="还没有评测" description="选择知识库和题集，用同一批问题比较不同检索方法。" action={newRun} /></div>
      : <>
        <div className="ev-filter">
          <label className="tm-search ev-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索评测名称" placeholder="搜索评测名称" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
          <Segmented label="状态筛选" value={status} onChange={value => { setStatus(value); setPage(1) }} items={[
            { value: 'all', label: '全部', count: counts('all') }, { value: 'active', label: '运行中', count: counts('active') },
            { value: 'completed', label: '已完成', count: counts('completed') }, { value: 'paused', label: '已暂停', count: counts('paused') }, { value: 'failed', label: '失败', count: counts('failed') },
          ]} />
          <SearchableSelect label="知识库" options={kbChoices} value={kbId} onChange={value => { setKbId(value); setPage(1) }} allLabel="全部" />
        </div>
        <div className="tm-panel tm-listcard">
          <DataTable label="评测运行" columns={columns} rows={visible.slice((current - 1) * pageSize, current * pageSize)} rowKey={run => run.id} minWidth={920}
            onRowClick={run => navigate(`/evaluation/runs/${run.id}`)} empty="没有符合条件的评测" />
          <Pager total={visible.length} page={current} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} unit="个" />
        </div>
      </>}
    {open && <CreateRun onClose={() => setOpen(false)} onCreated={run => { setOpen(false); navigate(`/evaluation/runs/${run.id}`) }} />}
  </Page>
}

// ---- Run detail -------------------------------------------------------------------------------------

const METRICS: { key: keyof SummaryMethod; label: string }[] = [
  { key: 'hit_at_5', label: 'Hit@5' }, { key: 'evidence_recall_at_5', label: '证据召回@5' }, { key: 'mrr_at_10', label: 'MRR@10' }, { key: 'token_f1', label: 'Token F1' },
]
const ITEM_METRIC_LABELS: Record<string, string> = { answer_metric_label: '答案指标类型', retrieval_metric_label: '检索指标类型', token_f1: 'Token F1', exact_match: 'Exact Match', hit_at_5: 'Hit@5', evidence_recall_at_5: '证据召回@5', mrr_at_10: 'MRR@10', evidence_count: '标注证据数', evidence_matched_at_5: '前 5 命中证据数', evidence_matched_at_10: '前 10 命中证据数' }

function MetricChart({ methods, by }: { methods: string[]; by: Record<string, SummaryMethod> }) {
  return <div className="ev-metrics">
    {METRICS.map(metric => {
      const values = methods.map(method => by[method]?.[metric.key] as number | null | undefined)
      const best = Math.max(...values.map(value => value ?? -1))
      return <div key={metric.key} className="ev-metric" role="group" aria-label={metric.label}>
        <span className="ev-metric-name" style={{ gridRow: `span ${methods.length}` }}>{metric.label}</span>
        {methods.map((method, index) => {
          const value = values[index]
          return <div key={method} className="ev-metric-row">
            <span className="ev-bar-track">{value != null && <span className="ev-bar" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: methodColor(method) }} />}</span>
            <span className={value != null && value === best && methods.length > 1 ? 'ev-metric-val ev-best' : 'ev-metric-val'}>{value == null ? '未评分' : pct(value)}</span>
          </div>
        })}
      </div>
    })}
  </div>
}

function UsageTable({ methods, by }: { methods: string[]; by: Record<string, SummaryMethod> }) {
  const rows: { key: string; label: string; value: (summary: SummaryMethod) => string }[] = [
    { key: 'retrieval', label: '检索 P95', value: summary => formatMs(summary.retrieval_p95_ms) },
    { key: 'generation', label: '生成 P95', value: summary => formatMs(summary.generation_p95_ms) },
    { key: 'tokens', label: 'Tokens', value: summary => formatCount(summary.total_tokens) },
    { key: 'failed', label: '失败', value: summary => String(summary.failed) },
  ]
  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'label', header: '', cell: row => row.label },
    ...methods.map(method => ({ key: method, header: methodLabel(method), nowrap: true, cell: (row: (typeof rows)[number]) => <span className="tm-num">{by[method] ? row.value(by[method]) : '—'}</span> })),
  ]
  return <DataTable className="ev-mini" label="耗时与用量" columns={columns} rows={rows} rowKey={row => row.key} />
}

interface QuestionRow { id: string; question: string; byMethod: Map<string, EvalItem>; judgeFailed: boolean }
const hitOf = (item: EvalItem | undefined): boolean | null => item && item.status === 'completed' && typeof item.metrics?.hit_at_5 === 'number' ? item.metrics.hit_at_5 > 0 : null
const f1Of = (item: EvalItem | undefined): number | null => item && typeof item.metrics?.token_f1 === 'number' ? item.metrics.token_f1 : null
type ItemFilter = 'all' | 'differ' | 'none'

function hitCell(item: EvalItem | undefined) {
  if (item?.status === 'failed') return <span className="ev-no">失败</span>
  const hit = hitOf(item)
  return hit == null ? <span className="tm-faint">—</span> : <span className={hit ? 'ev-yes' : 'ev-no'}>{hit ? '是' : '否'}</span>
}

function Inspection({ rows }: { rows: EvalItem[] }) {
  const first = rows[0]
  if (!first) return null
  return <>
    <p className="ev-question">{first.question}</p>
    <section className="ev-ref"><h3>参考答案</h3>{first.reference_answer ? <Markdown text={first.reference_answer} /> : <p className="tm-faint">未标注参考答案</p>}</section>
    {rows.map(item => <section className="tm-panel ev-method-card" key={item.id}>
      <header className="tm-panel-title"><span className="ev-swatch" style={{ background: methodColor(item.method) }} aria-hidden="true" /><h3>{methodLabel(item.method)}</h3><span className="flex-1" /><StatusTag value={item.status} /></header>
      <div className="ev-method-body">
        {item.error && <ErrorState error={new Error(item.error)} />}
        {item.result ? <ResultView result={item.result} /> : <p className="tm-faint">{item.status === 'failed' ? '本项生成失败' : '结果尚未生成'}</p>}
        {Object.keys(item.metrics ?? {}).length > 0 && <dl className="ev-item-metrics">{Object.entries(item.metrics).map(([name, value]) => <div key={name}><dt>{ITEM_METRIC_LABELS[name] ?? name}</dt><dd>{value == null ? '未评分' : typeof value === 'number' ? formatNumber(value) : String(value)}</dd></div>)}</dl>}
        {item.judgment && <div className="ev-judge"><strong>模型裁判</strong><p>正确性：{item.judgment.correct ? '通过' : '未通过'}；忠实性：{item.judgment.faithful ? '通过' : '未通过'}</p><p>{item.judgment.reason}</p></div>}
        {item.judge_error && <p className="ev-fail">裁判失败：{item.judge_error}</p>}
        <JsonDetails value={item} />
      </div>
    </section>)}
  </>
}

export function RunDetail() {
  const { id = '' } = useParams()
  const run = useApi<Run>(`/runs/${id}`, { poll: 2500 })
  const items = useApi<EvalItem[]>(`/runs/${id}/items`, { poll: 3000 })
  const { kbName, datasetName } = useNames()
  const [filter, setFilter] = useState<ItemFilter>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [inspectId, setInspectId] = useState<string | null>(null)
  const control = useAction((action: 'pause' | 'resume' | 'retry-failed') => post<Run>(`/runs/${id}/${action}`), { invalidate: [`/runs/${id}`, `/runs/${id}/items`, '/runs'], success: '操作已提交，状态即将更新' })
  const exported = useAction(() => downloadExport(id), { success: '评测结果已导出' })
  const data = run.data
  const methods = data?.methods ?? []
  const by = data?.summary?.by_method ?? {}
  const summaryMethods = methods.filter(method => by[method])
  const rows = useMemo<QuestionRow[]>(() => {
    const map = new Map<string, QuestionRow>()
    for (const item of items.data ?? []) {
      const row = map.get(item.question_id) ?? { id: item.question_id, question: item.question, byMethod: new Map<string, EvalItem>(), judgeFailed: false }
      row.byMethod.set(item.method, item)
      row.judgeFailed ||= !!item.judge_error
      map.set(item.question_id, row)
    }
    return [...map.values()]
  }, [items.data])
  const scored = (row: QuestionRow): boolean[] => methods.map(method => hitOf(row.byMethod.get(method))).filter((hit): hit is boolean => hit !== null)
  const differs = (row: QuestionRow): boolean => { const hits = scored(row); return hits.length > 1 && hits.some(Boolean) && !hits.every(Boolean) }
  const noneHit = (row: QuestionRow): boolean => { const hits = scored(row); return hits.length > 0 && !hits.some(Boolean) }
  const counts: Record<ItemFilter, number> = { all: rows.length, differ: rows.filter(differs).length, none: rows.filter(noneHit).length }
  const needle = search.trim().toLowerCase()
  const visible = rows.filter(row => (filter === 'all' || (filter === 'differ' ? differs(row) : noneHit(row))) && row.question.toLowerCase().includes(needle))
  const pages = Math.max(1, Math.ceil(visible.length / pageSize))
  const current = Math.min(page, pages)
  const pageRows = visible.slice((current - 1) * pageSize, current * pageSize)
  const inspectIndex = inspectId ? visible.findIndex(row => row.id === inspectId) : -1
  const judgeFailures = rows.some(row => row.judgeFailed)
  const running = !!data && ['queued', 'running'].includes(data.status)

  const columns: Column<QuestionRow>[] = [
    { key: 'n', header: '#', width: 48, cell: (_row, index) => <span className="tm-faint tm-num">{(current - 1) * pageSize + index + 1}</span> },
    { key: 'question', header: '问题', cell: row => <><button type="button" className="tm-linkbtn ev-q" onClick={() => setInspectId(row.id)}>{row.question}</button>{row.judgeFailed && <span className="tm-table-sub ev-fail">裁判调用失败</span>}</> },
    ...methods.flatMap((method): Column<QuestionRow>[] => [
      { key: `${method}-hit`, header: '证据进前 5', nowrap: true, cell: row => hitCell(row.byMethod.get(method)) },
      { key: `${method}-f1`, header: 'Token F1', nowrap: true, cell: row => <span className="tm-num">{pct(f1Of(row.byMethod.get(method)), 0)}</span> },
    ]),
    { key: 'compare', header: <span className="sr-only">对比召回</span>, nowrap: true, cell: row => <Link className="tm-textlink" to={`/evaluation/retrieval?${new URLSearchParams({ kb: data?.knowledge_base_id ?? '', q: row.question })}`}>对比召回</Link> },
  ]
  const actions = data && <>
    {running && <Button variant="secondary" busy={control.isPending} onClick={() => control.mutate('pause')}>暂停</Button>}
    {['paused', 'failed'].includes(data.status) && <Button busy={control.isPending} onClick={() => control.mutate('resume')}>继续运行</Button>}
    <Button variant="secondary" busy={control.isPending} disabled={running || !(data.failed > 0 || judgeFailures)} onClick={() => control.mutate('retry-failed')}>只重试失败项</Button>
    <Button variant="secondary" busy={exported.isPending} onClick={() => exported.mutate()}>导出 JSON</Button>
  </>
  const body = run.isPending ? <Loading /> : run.isError ? <ErrorState error={run.error} retry={() => { void run.refetch() }} /> : data && <>
    <FactStrip items={[
      { label: '题集', value: `${datasetName(data.dataset_id)}，${Array.isArray(data.config.question_ids) ? data.config.question_ids.length : Math.round(data.total / Math.max(1, methods.length))} 题` },
      { label: '知识库', value: `${kbName(data.knowledge_base_id)}${data.config.kb_version != null ? `，快照 v${String(data.config.kb_version)}` : ''}` },
      { label: '对话模型', value: data.config.chat_model ? `${String(data.config.chat_model)}（已冻结）` : '—' },
      { label: '方法', value: `${methods.length} 种` },
      { label: '进度', value: `${data.completed} / ${data.total}，失败 ${data.failed}` },
      { label: '模型裁判', value: data.judge_enabled ? '开启' : '关闭' },
    ]} />
    {data.error && <ErrorState error={new Error(data.error)} />}
    <div className="ev-split">
      <section className="tm-panel ev-metrics-panel" aria-label="指标对比">
        <div className="ev-panel-head">
          <h2>指标对比</h2><span className="flex-1" />
          {summaryMethods.map(method => <span key={method} className="ev-legend"><span className="ev-swatch" style={{ background: methodColor(method) }} aria-hidden="true" />{methodLabel(method)}</span>)}
        </div>
        {summaryMethods.length ? <MetricChart methods={summaryMethods} by={by} /> : <p className="tm-faint ev-pad">还没有汇总结果</p>}
      </section>
      <section className="tm-panel ev-usage-panel" aria-label="耗时与用量">
        <div className="ev-panel-head"><h2>耗时与用量</h2></div>
        {summaryMethods.length ? <UsageTable methods={summaryMethods} by={by} /> : <p className="tm-faint ev-pad">还没有汇总结果</p>}
      </section>
    </div>
    <section className="tm-panel" aria-label="逐题结果">
      <div className="ev-panel-head ev-panel-head-line">
        <h2>逐题结果</h2><span className="flex-1" />
        <label className="tm-search ev-search ev-search-sm"><Search size={13} aria-hidden="true" /><input aria-label="搜索评测问题" placeholder="搜索问题" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
        <Segmented size="sm" label="结果筛选" value={filter} onChange={value => { setFilter(value); setPage(1) }} items={[
          { value: 'all', label: '全部', count: counts.all }, { value: 'differ', label: '结果不一致', count: counts.differ }, { value: 'none', label: '都没命中', count: counts.none },
        ]} />
      </div>
      {items.isPending ? <Loading /> : items.isError ? <ErrorState error={items.error} retry={() => { void items.refetch() }} /> : <>
        <DataTable className="ev-items" label="逐题结果" columns={columns} rows={pageRows} rowKey={row => row.id} minWidth={560 + methods.length * 190} selectedKey={inspectId} onRowClick={row => setInspectId(row.id)}
          headerGroups={[{ label: '', span: 2 }, ...methods.map(method => ({ label: <span style={{ color: methodColor(method) }}>{methodLabel(method)}</span>, span: 2 })), { label: '', span: 1 }]}
          empty={rows.length ? '没有符合条件的题目' : '等待后台生成结果'} />
        <Pager total={visible.length} page={current} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} unit="题" />
      </>}
    </section>
    <JsonDetails value={{ config: data.config, summary: data.summary }} label="运行快照" />
  </>
  return <Page title={data?.name ?? '评测运行'} crumbs={[{ to: '/evaluation', label: '批量评测' }]} meta={data && <StatusTag value={data.status} />} actions={actions}>
    {body}
    <Drawer open={!!inspectId} onOpenChange={open => { if (!open) setInspectId(null) }} title="逐题检查" width={760}
      position={inspectIndex >= 0 ? `${inspectIndex + 1} / ${visible.length}` : undefined}
      onPrev={inspectIndex > 0 ? () => setInspectId(visible[inspectIndex - 1].id) : undefined}
      onNext={inspectIndex >= 0 && inspectIndex < visible.length - 1 ? () => setInspectId(visible[inspectIndex + 1].id) : undefined}>
      {inspectId && <Inspection rows={methods.map(method => rows.find(row => row.id === inspectId)?.byMethod.get(method)).filter((item): item is EvalItem => !!item)} />}
    </Drawer>
  </Page>
}

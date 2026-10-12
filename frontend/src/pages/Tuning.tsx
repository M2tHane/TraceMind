import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowRight, Plus, Search } from 'lucide-react'
import { api, formatDate, post, useAction, useApi } from '../lib/api'
import type { KnowledgeBase, LeaderboardRow, TuningPresets, TuningRun } from '../lib/types'
import { Button, DataTable, Drawer, Empty, ErrorState, FactStrip, Loading, Pager, SearchableSelect, Segmented, StatusTag, Tag, type Column } from '../components/ui'
import { Page } from '../components/shell/Shell'
import {
  FieldSelect, FormField, MenuPopover, OBJECTIVE_LABELS, changedKeys, configChanges, configSummary, datasetOptions, downloadJson, kbOptions, objectiveLabel, pct, sameConfig, useNames,
} from './evalShared'

const GRID_EXAMPLE = '{\n  "route_k": [20, 40],\n  "vector_weight": [1, 2],\n  "rerank": [true, false]\n}'
const METRIC_ORDER = ['hit_at_1', 'hit_at_3', 'hit_at_5', 'hit_at_10', 'recall_at_5', 'recall_at_10', 'mrr_at_10', 'ndcg_at_10']
const BASE_METRICS = ['hit_at_1', 'hit_at_5', 'recall_at_5', 'mrr_at_10', 'ndcg_at_10']
/** 100% of a metric is this many pixels of bar. */
const BAR_PX = 60

interface TuningInput { name: string; knowledge_base_id: string; dataset_id: string; objective: string; limit: number; grid?: Record<string, unknown[]>; include_paid_rewrite?: boolean }

function CreateTuning({ onCreated, onClose }: { onCreated: (run: TuningRun) => void; onClose: () => void }) {
  const { kbs, datasets } = useNames()
  const presets = useApi<TuningPresets>('/tuning/presets')
  const [name, setName] = useState('')
  const [kbId, setKbId] = useState('')
  const [datasetId, setDatasetId] = useState('')
  const [objective, setObjective] = useState('mrr_at_10')
  const [limit, setLimit] = useState(100)
  const [mode, setMode] = useState<'presets' | 'grid'>('presets')
  const [rewrite, setRewrite] = useState(false)
  const [grid, setGrid] = useState(GRID_EXAMPLE)
  const [gridError, setGridError] = useState('')
  const create = useAction((body: TuningInput) => post<TuningRun>('/tuning-runs', body), { invalidate: ['/tuning-runs'], success: '调优任务已创建，后台开始执行', onSuccess: onCreated })
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); if (create.isPending) return
    const body: TuningInput = { name: name.trim(), knowledge_base_id: kbId, dataset_id: datasetId, objective, limit }
    if (mode === 'grid') {
      try {
        const parsed: unknown = JSON.parse(grid)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('grid 必须是 JSON 对象')
        body.grid = parsed as Record<string, unknown[]>
        setGridError('')
      } catch (error) { setGridError(error instanceof Error ? error.message : 'grid 不是合法 JSON'); return }
    } else body.include_paid_rewrite = rewrite
    create.mutate(body)
  }
  const dataset = datasets.data?.find(item => item.id === datasetId)
  return <Drawer open onOpenChange={open => { if (!open && !create.isPending) onClose() }} title="新建调优" width={480}
    footer={<div className="ev-actions">
      <Button variant="secondary" disabled={create.isPending} onClick={onClose}>取消</Button>
      <Button type="submit" form="tuning-form" busy={create.isPending} disabled={!name.trim() || !kbId || !datasetId || !dataset?.question_count}>创建并运行</Button>
    </div>}>
    <form id="tuning-form" className="ev-form ev-form-flush" onSubmit={handleSubmit}>
    <fieldset disabled={create.isPending} className="ev-fieldset ev-form-fields">
      <FormField label="任务名称"><input className="tm-input" required maxLength={200} placeholder="例如：重排与召回数量调优" value={name} onChange={event => setName(event.target.value)} autoFocus /></FormField>
      <FormField label="知识库"><FieldSelect label="知识库" placeholder="选择知识库" options={kbOptions(kbs.data, true)} value={kbId} onChange={setKbId} /></FormField>
      <FormField label="题集"><FieldSelect label="题集" placeholder="选择题集" options={datasetOptions(datasets.data)} value={datasetId} onChange={setDatasetId} /></FormField>
      <div className="ev-row2">
        <FormField label="优化目标"><FieldSelect label="优化目标" placeholder="选择优化目标" value={objective} onChange={setObjective}
          options={(presets.data?.objectives ?? Object.keys(OBJECTIVE_LABELS)).map(value => ({ value, label: objectiveLabel(value) }))} /></FormField>
        <FormField label="题数上限"><input className="tm-input" type="number" min={1} max={1000} required value={limit} onChange={event => setLimit(Number(event.target.value))} /></FormField>
      </div>
      <Segmented label="候选来源" value={mode} onChange={setMode} items={[{ value: 'presets', label: '内置预设' }, { value: 'grid', label: '参数网格' }]} />
      {mode === 'presets' ? <>
        <div className="ev-tags">{presets.data?.candidates.map(candidate => <Tag key={candidate.name} title={configSummary(candidate.config)} className="tm-mono">{candidate.name}</Tag>)}</div>
        <label className="ev-check"><input type="checkbox" className="tm-check" checked={rewrite} onChange={event => setRewrite(event.target.checked)} /><span>加入多查询改写候选<small className="tm-faint">每题多调用一次对话模型</small></span></label>
      </> : <FormField label="参数网格（JSON）" hint={`最多 24 组。可调字段：${presets.data?.tunable_fields.join('、') ?? ''}`}>
        <textarea className="tm-input tm-mono" rows={7} value={grid} onChange={event => setGrid(event.target.value)} spellCheck={false} />
      </FormField>}
      {gridError && <p role="alert" className="ev-fail">{gridError}</p>}
    </fieldset>
    {create.error && <ErrorState error={create.error} />}
    </form>
  </Drawer>
}

type TaskFilter = 'all' | 'active' | 'completed' | 'paused' | 'failed'
const TASK_FILTERS: Record<Exclude<TaskFilter, 'all'>, string[]> = { active: ['queued', 'running'], completed: ['completed'], paused: ['paused'], failed: ['failed'] }
const objectiveValue = (row: LeaderboardRow | null | undefined, objective: string): number | null => row ? (row[objective as keyof LeaderboardRow] as number | null) : null

export function TuningPage() {
  const runs = useApi<TuningRun[]>('/tuning-runs', { poll: 5000 })
  const { kbName, datasetName } = useNames()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<TaskFilter>('all')
  const [kbId, setKbId] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const navigate = useNavigate()
  const all = runs.data ?? []
  const counts = (filter: TaskFilter): number => filter === 'all' ? all.length : all.filter(run => TASK_FILTERS[filter].includes(run.status)).length
  const visible = all.filter(run => (status === 'all' || TASK_FILTERS[status].includes(run.status)) && (!kbId || run.knowledge_base_id === kbId) && run.name.toLowerCase().includes(search.trim().toLowerCase()))
  const pages = Math.max(1, Math.ceil(visible.length / pageSize))
  const current = Math.min(page, pages)
  const kbChoices = useMemo(() => [{ value: '', label: '全部' }, ...[...new Set(all.map(run => run.knowledge_base_id))].map(id => ({ value: id, label: kbName(id) }))], [all, kbName])
  const columns: Column<TuningRun>[] = [
    { key: 'name', header: '任务', cell: run => <Link to={`/evaluation/tuning/${run.id}`} className="tm-linkbtn">{run.name}</Link> },
    { key: 'status', header: '状态', nowrap: true, cell: run => <StatusTag value={run.status} /> },
    { key: 'kb', header: '知识库', cell: run => kbName(run.knowledge_base_id) },
    { key: 'dataset', header: '题集', cell: run => <>{datasetName(run.dataset_id)}<span className="tm-table-sub">{run.question_count} 题</span></> },
    { key: 'objective', header: '目标指标', nowrap: true, cell: run => objectiveLabel(run.objective) },
    { key: 'candidates', header: '候选配置', nowrap: true, cell: run => <span className="tm-num">{run.candidates.length} 组</span> },
    { key: 'progress', header: '进度', nowrap: true, cell: run => <><span className="tm-num">{run.completed + run.failed} / {run.total}</span>{run.failed > 0 && <span className="tm-table-sub ev-fail">失败 {run.failed}</span>}</> },
    { key: 'best', header: '最优配置', cell: run => run.best ? <><span className="tm-mono ev-name">{run.best.name}</span><span className="tm-table-sub tm-num">{objectiveLabel(run.objective)} {pct(objectiveValue(run.best, run.objective))}</span></> : <span className="tm-faint">—</span> },
    { key: 'created', header: '创建时间', nowrap: true, cell: run => <span className="tm-faint tm-num">{formatDate(run.created_at)}</span> },
  ]
  const newTask = <Button onClick={() => setOpen(true)}><Plus size={15} />新建调优</Button>
  return <Page title="检索调优" actions={newTask}>
    {runs.isPending ? <Loading /> : runs.isError ? <ErrorState error={runs.error} retry={() => { void runs.refetch() }} /> : !all.length
      ? <div className="tm-panel"><Empty title="还没有调优任务" description="选择知识库和带证据的题集，比较多组召回参数。" action={newTask} /></div>
      : <>
        <div className="ev-filter">
          <label className="tm-search ev-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索调优任务" placeholder="搜索任务名称" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
          <Segmented label="状态筛选" value={status} onChange={value => { setStatus(value); setPage(1) }} items={[
            { value: 'all', label: '全部', count: counts('all') }, { value: 'active', label: '运行中', count: counts('active') },
            { value: 'completed', label: '已完成', count: counts('completed') }, { value: 'paused', label: '已暂停', count: counts('paused') }, { value: 'failed', label: '失败', count: counts('failed') },
          ]} />
          <SearchableSelect label="知识库" options={kbChoices} value={kbId} onChange={value => { setKbId(value); setPage(1) }} allLabel="全部" />
        </div>
        <div className="tm-panel tm-listcard">
          <DataTable label="调优任务" columns={columns} rows={visible.slice((current - 1) * pageSize, current * pageSize)} rowKey={run => run.id} minWidth={980}
            onRowClick={run => navigate(`/evaluation/tuning/${run.id}`)} empty="没有符合条件的任务" />
          <Pager total={visible.length} page={current} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} unit="个" />
        </div>
      </>}
    {open && <CreateTuning onClose={() => setOpen(false)} onCreated={run => { setOpen(false); navigate(`/evaluation/tuning/${run.id}`) }} />}
  </Page>
}

// ---- Detail -----------------------------------------------------------------------------------------

interface BoardRow extends LeaderboardRow { rank: number }

function Conclusion({ run, kb, board, apply }: { run: TuningRun; kb: KnowledgeBase | undefined; board: BoardRow[]; apply: { pending: boolean; mutate: (candidate: string) => void } }) {
  const best = board[0]
  const configs = new Map(run.candidates.map(candidate => [candidate.name, candidate.config]))
  const bestConfig = configs.get(best.name)
  const currentRow = kb ? board.find(row => { const config = configs.get(row.name); return !!config && sameConfig(kb.retrieval_config, config) }) : undefined
  const currentConfig = currentRow ? configs.get(currentRow.name) : undefined
  const bestIsCurrent = !!currentRow && currentRow.name === best.name
  const bestValue = objectiveValue(best, run.objective)
  const currentValue = objectiveValue(currentRow, run.objective)
  const delta = bestValue != null && currentValue != null ? (bestValue - currentValue) * 100 : null
  const changes = bestConfig && currentConfig && !bestIsCurrent ? configChanges(currentConfig, bestConfig) : []
  const rest = bestConfig ? configSummary(bestConfig, bestConfig && currentConfig ? changedKeys(currentConfig, bestConfig) : new Set()) : ''
  const kbLabel = kb?.name ?? '知识库'
  return <section className="tm-panel ev-conclusion" aria-label="调优结论">
    <div className="ev-conclusion-score">
      <p className="tm-faint">{run.status === 'completed' ? '最优配置' : '当前领先配置'}的 {objectiveLabel(run.objective)}</p>
      <p className="ev-big tm-num">{pct(bestValue)}</p>
      {currentRow && !bestIsCurrent && delta != null && <p className="ev-gain tm-num">{delta > 0.0005 ? `比当前默认高 ${delta.toFixed(1)} 个点` : '与当前默认持平'}</p>}
    </div>
    <div className="ev-conclusion-body">
      <p className="ev-conclusion-title"><span className="tm-mono">{best.name}</span>
        <span className="tm-muted">{bestIsCurrent ? `已是${kbLabel}的默认配置` : changes.length ? (changes.length === 1 ? ' 与当前默认只差一个参数' : ` 与当前默认相差 ${changes.length} 个参数`) : ''}</span></p>
      {changes.length > 0 ? <p className="ev-changes">
        {changes.map(change => <span key={change.key} className="ev-change">{change.label}<s className="tm-faint tm-num">{change.from}</s><ArrowRight size={13} aria-hidden="true" /><b className="tm-num">{change.to}</b></span>)}
        {rest && <span className="tm-faint ev-rest">其余相同：{rest}</span>}
      </p> : <p className="tm-faint">{rest}</p>}
    </div>
    {!bestIsCurrent && <div className="ev-conclusion-action">
      <Button busy={apply.pending} disabled={best.questions === best.failed} onClick={() => apply.mutate(best.name)}>设为{kbLabel}的默认配置</Button>
    </div>}
  </section>
}

export function TuningDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const run = useApi<TuningRun>(`/tuning-runs/${id}`, { poll: 4000 })
  const kb = useApi<KnowledgeBase>(`/knowledge-bases/${run.data?.knowledge_base_id ?? ''}`, { enabled: !!run.data })
  const { datasetName } = useNames()
  const pause = useAction(() => post<TuningRun>(`/tuning-runs/${id}/pause`), { invalidate: [`/tuning-runs/${id}`, '/tuning-runs'], success: '已暂停，当前题目完成后停止' })
  const resume = useAction(() => post<TuningRun>(`/tuning-runs/${id}/resume`), { invalidate: [`/tuning-runs/${id}`, '/tuning-runs'], success: '已继续运行' })
  const apply = useAction((candidate: string) => post<KnowledgeBase>(`/tuning-runs/${id}/apply`, { candidate }), { invalidate: [`/knowledge-bases/${run.data?.knowledge_base_id ?? ''}`, '/knowledge-bases'], success: '已设为知识库默认检索配置' })
  const exported = useAction(async () => downloadJson(`tuning-run-${id}.json`, await api<unknown>(`/tuning-runs/${id}?include_results=true`)), { success: '调优结果已导出' })
  const rerun = useAction((source: TuningRun) => post<TuningRun>('/tuning-runs', {
    name: `${source.name}（再跑）`, knowledge_base_id: source.knowledge_base_id, dataset_id: source.dataset_id, objective: source.objective, limit: source.question_count, candidates: source.candidates,
  }), { invalidate: ['/tuning-runs'], success: '调优任务已创建，后台开始执行', onSuccess: created => navigate(`/evaluation/tuning/${created.id}`) })
  const data = run.data
  const configs = new Map(data?.candidates.map(candidate => [candidate.name, candidate.config]))
  const board = useMemo<BoardRow[]>(() => {
    if (!data) return []
    const value = (row: LeaderboardRow): number => objectiveValue(row, data.objective) ?? -1
    return data.leaderboard.map(row => ({ ...row, rank: 1 + data.leaderboard.filter(other => value(other) > value(row) + 1e-9).length }))
  }, [data])
  const metricKeys = useMemo(() => METRIC_ORDER.filter(key => BASE_METRICS.includes(key) || key === data?.objective), [data?.objective])
  const bestOf = (key: string): number => Math.max(...board.map(row => (row[key as keyof LeaderboardRow] as number | null) ?? -1))
  const done = data ? data.completed + data.failed : 0
  const current = kb.data
  const columns: Column<BoardRow>[] = data ? [
    { key: 'rank', header: '名次', width: 56, cell: row => <strong className="tm-num">{row.rank}</strong> },
    { key: 'config', header: '配置', cell: row => {
      const config = configs.get(row.name)
      const isCurrent = !!current && !!config && sameConfig(current.retrieval_config, config)
      return <><span className="ev-config-name"><span className="tm-mono ev-name">{row.name}</span>{isCurrent && <Tag>当前默认</Tag>}</span>{config && <span className="tm-table-sub">{configSummary(config)}</span>}</>
    } },
    ...metricKeys.map((key): Column<BoardRow> => {
      const goal = key === data.objective
      const top = bestOf(key)
      return {
        key, header: objectiveLabel(key), nowrap: true, className: goal ? 'ev-goal' : undefined, headerClassName: goal ? 'ev-goal' : undefined,
        cell: row => {
          const value = row[key as keyof LeaderboardRow] as number | null
          if (value == null) return <span className="tm-faint">—</span>
          return <span className="ev-mv"><span className={`tm-num${value >= top - 1e-9 ? ' ev-best' : ''}`}>{pct(value)}</span><i className={goal ? 'ev-goal-bar' : undefined} style={{ width: Math.max(1, value * BAR_PX) }} /></span>
        },
      }
    }),
    { key: 'p50', header: 'P50 耗时', nowrap: true, cell: row => <span className="tm-faint tm-num">{row.latency_p50_ms == null ? '—' : `${row.latency_p50_ms.toFixed(1)} ms`}</span> },
    { key: 'failed', header: '失败', cell: row => <span className={row.failed ? 'ev-fail tm-num' : 'tm-faint tm-num'}>{row.failed}</span> },
    { key: 'more', header: <span className="sr-only">更多操作</span>, width: 44, cell: row => {
      const config = configs.get(row.name)
      const isCurrent = !!current && !!config && sameConfig(current.retrieval_config, config)
      return <MenuPopover label={`更多操作 ${row.name}`}>
        {isCurrent ? <span className="ev-menu-note">已是默认配置</span>
          : <button type="button" className="ev-menu-item" disabled={apply.isPending || row.questions === row.failed} onClick={() => apply.mutate(row.name)}>设为默认</button>}
      </MenuPopover>
    } },
  ] : []
  const actions = data && <>
    {['queued', 'running'].includes(data.status) && <Button variant="secondary" busy={pause.isPending} onClick={() => pause.mutate(undefined)}>暂停</Button>}
    {['paused', 'failed'].includes(data.status) && <Button variant="secondary" busy={resume.isPending} onClick={() => resume.mutate(undefined)}>继续运行</Button>}
    <Button variant="secondary" busy={exported.isPending} onClick={() => exported.mutate(undefined)}>导出 JSON</Button>
    <Button variant="secondary" busy={rerun.isPending} disabled={!data.question_count} onClick={() => rerun.mutate(data)}>用相同设置再跑一次</Button>
  </>
  return <Page title={data?.name ?? '检索调优'} crumbs={[{ to: '/evaluation/tuning', label: '检索调优' }]} meta={data && <StatusTag value={data.status} />} actions={actions}>
    {run.isPending ? <Loading /> : run.isError ? <ErrorState error={run.error} retry={() => { void run.refetch() }} /> : data && <>
      <FactStrip items={[
        { label: '知识库', value: kb.data?.name ?? '—' },
        { label: '题集', value: `${datasetName(data.dataset_id)}，${data.question_count} 题` },
        { label: '候选配置', value: `${data.candidates.length} 组` },
        { label: '进度', value: `${done} / ${data.total}，失败 ${data.failed}` },
        { label: '目标指标', value: objectiveLabel(data.objective) },
        { label: '创建', value: formatDate(data.created_at) },
      ]} />
      {data.error && <ErrorState error={new Error(data.error)} />}
      {board.length > 0 && <Conclusion run={data} kb={kb.data} board={board} apply={{ pending: apply.isPending, mutate: apply.mutate }} />}
      <section className="tm-panel ev-board" aria-label="排行榜">
        <div className="ev-panel-head ev-panel-head-line"><h2>排行榜</h2></div>
        {board.length ? <DataTable label="排行榜" columns={columns} rows={board} rowKey={row => row.name} minWidth={900} />
          : <Empty title={['queued', 'running'].includes(data.status) ? '正在计算第一道题' : '还没有结果'} />}
      </section>
    </>}
  </Page>
}

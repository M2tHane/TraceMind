import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowUpRight, CheckCircle2, Pause, Play, Plus, SlidersHorizontal } from 'lucide-react'
import { formatDate, formatNumber, post, ratio, useAction, useApi } from '../lib/api'
import type { Dataset, KnowledgeBase, LeaderboardRow, RetrievalConfig, TuningPresets, TuningRun } from '../lib/types'
import { Button, Empty, ErrorState, Field, JsonDetails, Loading, Modal, Notice, PageHeader, Status } from '../components/ui'
import { EvalNav } from '../components/EvalNav'
import { Select } from '../components/Select'
import { retrievalSummary } from '../components/Retrieval'

const OBJECTIVE_LABELS: Record<string, string> = {
  hit_at_1: 'Hit@1', hit_at_3: 'Hit@3', hit_at_5: 'Hit@5', hit_at_10: 'Hit@10', recall_at_5: 'Recall@5',
  recall_at_10: 'Recall@10', mrr_at_10: 'MRR@10', ndcg_at_10: 'nDCG@10',
}
const METRIC_COLUMNS: (keyof LeaderboardRow)[] = ['hit_at_1', 'recall_at_5', 'mrr_at_10', 'ndcg_at_10']
const GRID_EXAMPLE = '{\n  "route_k": [20, 40],\n  "vector_weight": [1, 2],\n  "rerank": [true, false]\n}'

interface TuningInput { name: string; knowledge_base_id: string; dataset_id: string; objective: string; limit: number; grid?: Record<string, unknown[]>; include_paid_rewrite?: boolean }

function CreateTuning({ onCreated, onClose }: { onCreated: (run: TuningRun) => void; onClose: () => void }) {
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases')
  const platformKbs = (kbs.data ?? []).filter(kb => kb.scope === 'platform')
  const datasets = useApi<Dataset[]>('/datasets')
  const presets = useApi<TuningPresets>('/tuning/presets')
  const [mode, setMode] = useState<'presets' | 'grid'>('presets')
  const [rewrite, setRewrite] = useState(false)
  const [grid, setGrid] = useState(GRID_EXAMPLE)
  const [gridError, setGridError] = useState('')
  const create = useAction((body: TuningInput) => post<TuningRun>('/tuning-runs', body), { invalidate: ['/tuning-runs'], success: '调优任务已创建，后台开始执行', onSuccess: onCreated })
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); if (create.isPending) return
    const data = new FormData(event.currentTarget)
    const body: TuningInput = { name: String(data.get('name')).trim(), knowledge_base_id: String(data.get('knowledge_base_id')), dataset_id: String(data.get('dataset_id')), objective: String(data.get('objective')), limit: Number(data.get('limit')) }
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
  const presetCount = (presets.data?.candidates.length ?? 8) + (rewrite ? 1 : 0)
  return <form className="dialog-body space-y-5" onSubmit={handleSubmit}><fieldset disabled={create.isPending} className="space-y-5">
    <Field label="任务名称"><input name="name" required maxLength={200} placeholder="例如：重排与召回数量调优" autoFocus /></Field>
    <div className="grid sm:grid-cols-2 gap-4">
      <Field label="知识库"><Select name="knowledge_base_id" label="知识库" required defaultValue="" placeholder="选择知识库" options={platformKbs.map(kb => ({ value: kb.id, label: `${kb.name}（${kb.ready_count} 份就绪）`, disabled: !kb.ready_count }))} /></Field>
      <Field label="问题数据集" hint="只使用带证据标注的可回答题目"><Select name="dataset_id" label="问题数据集" required defaultValue="" placeholder="选择数据集" options={(datasets.data ?? []).map(dataset => ({ value: dataset.id, label: `${dataset.name}（${dataset.question_count} 题）`, disabled: !dataset.question_count }))} /></Field>
      <Field label="优化目标"><Select name="objective" label="优化目标" defaultValue="mrr_at_10" options={(presets.data?.objectives ?? Object.keys(OBJECTIVE_LABELS)).map(value => ({ value, label: OBJECTIVE_LABELS[value] ?? value }))} /></Field>
      <Field label="题目数上限"><input name="limit" type="number" min={1} max={1000} defaultValue={100} required /></Field>
    </div>
    <div className="tabs" role="tablist">{(['presets', 'grid'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={mode === value} className={`tab ${mode === value ? 'tab-active' : ''}`} onClick={() => setMode(value)}>{value === 'presets' ? '内置预设' : '参数网格'}</button>)}</div>
    {mode === 'presets' ? <>
      <div className="flex flex-wrap gap-1">{presets.data?.candidates.map(candidate => <span key={candidate.name} className="file-tag" title={retrievalSummary(candidate.config)}>{candidate.name}</span>)}</div>
      <label className="checkbox-label"><input type="checkbox" checked={rewrite} onChange={e => setRewrite(e.target.checked)} /><span>加入多查询改写候选<small>每道题额外调用一次对话模型。</small></span></label>
    </> : <Field label="参数网格（JSON）" hint={`在默认配置上展开笛卡尔积，最多 24 组。可调字段：${presets.data?.tunable_fields.join('、') ?? ''}`}>
      <textarea rows={7} className="font-mono text-xs" value={grid} onChange={e => setGrid(e.target.value)} spellCheck={false} />
    </Field>}
    {gridError && <Notice>{gridError}</Notice>}
    <Notice>调优只做检索不生成回答。向量与重排结果在同一任务内跨配置复用{mode === 'presets' ? `，${presetCount} 组配置的费用接近单组` : ''}。指标是词法证据代理，不是人工相关性标注。</Notice>
  </fieldset>
  {create.error && <ErrorState error={create.error} />}
  <div className="dialog-actions"><Button variant="secondary" disabled={create.isPending} onClick={onClose}>取消</Button><Button type="submit" busy={create.isPending} disabled={!platformKbs.length || !datasets.data?.length}><Play size={15} />创建并运行</Button></div></form>
}

export function TuningPage() {
  const runs = useApi<TuningRun[]>('/tuning-runs', { poll: 5000 })
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  return <div className="page"><PageHeader title="检索调优" description="用带证据标注的题目，对多组召回参数做纯检索评估并选出最优配置。" actions={<Button onClick={() => setOpen(true)}><Plus size={16} />新建调优</Button>} /><EvalNav current="tuning" />
    {runs.isPending ? <Loading /> : runs.isError ? <ErrorState error={runs.error} retry={() => { void runs.refetch() }} /> : !runs.data.length
      ? <Empty title="让数据决定检索参数" description="选择知识库与带证据的问题集，比较召回路线、融合权重、重排和后处理策略，并一键应用最优配置。" action={<Button onClick={() => setOpen(true)}><SlidersHorizontal size={16} />创建第一次调优</Button>} />
      : <div className="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>最优配置</th><th>创建时间</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{runs.data.map(run => <tr key={run.id}>
        <td><Link to={`/evaluation/tuning/${run.id}`} className="font-medium hover:text-accent-700">{run.name}</Link><p className="text-xs text-slate-400 mt-1">{run.candidates.length} 组配置 · {run.question_count} 题 · 目标 {OBJECTIVE_LABELS[run.objective] ?? run.objective}</p></td>
        <td><Status value={run.status} /></td>
        <td className="text-xs tabular-nums whitespace-nowrap">{run.completed + run.failed} / {run.total}{run.failed > 0 && <p className="text-red-600 mt-1">{run.failed} 失败</p>}</td>
        <td className="text-xs">{run.best ? <><span className="font-medium">{run.best.name}</span><p className="text-slate-500 mt-1">{OBJECTIVE_LABELS[run.objective]} {ratio(run.best[run.objective as keyof LeaderboardRow] as number | null)}</p></> : '—'}</td>
        <td className="text-xs whitespace-nowrap text-slate-500">{formatDate(run.created_at)}</td>
        <td><Link className="text-link whitespace-nowrap" to={`/evaluation/tuning/${run.id}`}>查看<ArrowUpRight size={14} /></Link></td>
      </tr>)}</tbody></table></div>}
    <Modal open={open} onOpenChange={setOpen} title="创建检索调优" description="固定题目与候选配置，结果可复现。" wide>{open && <CreateTuning onClose={() => setOpen(false)} onCreated={run => { setOpen(false); navigate(`/evaluation/tuning/${run.id}`) }} />}</Modal>
  </div>
}

function sameConfig(left: Partial<RetrievalConfig> | undefined, right: RetrievalConfig): boolean {
  return !!left && Object.keys(right).every(key => JSON.stringify(left[key as keyof RetrievalConfig] ?? null) === JSON.stringify(right[key as keyof RetrievalConfig] ?? null))
}

export function TuningDetail() {
  const { id = '' } = useParams()
  const run = useApi<TuningRun>(`/tuning-runs/${id}`, { poll: 4000 })
  const kb = useApi<KnowledgeBase>(`/knowledge-bases/${run.data?.knowledge_base_id ?? ''}`, { enabled: !!run.data })
  const pause = useAction(() => post<TuningRun>(`/tuning-runs/${id}/pause`), { invalidate: [`/tuning-runs/${id}`, '/tuning-runs'], success: '已暂停，当前题目完成后停止' })
  const resume = useAction(() => post<TuningRun>(`/tuning-runs/${id}/resume`), { invalidate: [`/tuning-runs/${id}`, '/tuning-runs'], success: '已继续运行' })
  const apply = useAction((candidate: string) => post<KnowledgeBase>(`/tuning-runs/${id}/apply`, { candidate }), { invalidate: [`/knowledge-bases/${run.data?.knowledge_base_id ?? ''}`, '/knowledge-bases'], success: '已设为知识库默认检索配置' })
  const data = run.data
  const configs = new Map(data?.candidates.map(candidate => [candidate.name, candidate.config]))
  const done = data ? data.completed + data.failed : 0
  return <div className="page page-wide"><PageHeader title={data?.name ?? '检索调优'} description="纯检索评估 · 自动刷新 · 按优化目标排序" back={{ to: '/evaluation/tuning', label: '所有调优任务' }}
    actions={data && <>{['queued', 'running'].includes(data.status) && <Button variant="secondary" busy={pause.isPending} onClick={() => pause.mutate(undefined)}><Pause size={15} />暂停</Button>}{['paused', 'failed'].includes(data.status) && <Button variant="secondary" busy={resume.isPending} onClick={() => resume.mutate(undefined)}><Play size={15} />继续</Button>}</>} />
    {run.isPending ? <Loading /> : run.isError ? <ErrorState error={run.error} retry={() => { void run.refetch() }} /> : data && <>
      <div className="run-status-panel"><Status value={data.status} /><p className="text-sm flex-1">已完成 <strong>{done}</strong> / {data.total} 项<span className="text-slate-400 mx-3">·</span>{data.question_count} 题 × {data.candidates.length} 组配置{data.failed > 0 && <span className="text-red-700 ml-3">{data.failed} 项失败（继续时重试）</span>}</p><span className="text-xs text-slate-500">目标 {OBJECTIVE_LABELS[data.objective] ?? data.objective} · 知识库 {kb.data?.name ?? data.knowledge_base_id}</span></div>
      {data.error && <ErrorState error={new Error(data.error)} />}
      {!data.leaderboard.length ? <Empty title="正在计算第一道题" description="每完成一道题，排行榜都会刷新。" /> : <div className="table-wrap"><table className="metrics-table"><thead><tr><th>候选配置</th>{METRIC_COLUMNS.map(column => <th key={column} className={column === data.objective ? 'text-accent-700' : ''}>{OBJECTIVE_LABELS[column]}</th>)}<th title="同一任务内各配置共享向量与重排缓存，先执行者承担真实调用耗时">P50 耗时*</th><th>失败</th></tr></thead><tbody>
        {data.leaderboard.map((row, index) => {
          const config = configs.get(row.name)
          const current = config && sameConfig(kb.data?.retrieval_config, config)
          return <tr key={row.name} className={index === 0 ? 'leaderboard-best' : ''}>
            <td><div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className="font-medium">{index === 0 && '🏆 '}{row.name}</span><p className="text-xs text-slate-500 mt-1">{config ? retrievalSummary(config) : ''}</p></div><div className="shrink-0">{current ? <span className="inline-flex items-center gap-1 text-xs text-green-700 whitespace-nowrap"><CheckCircle2 size={14} />当前默认</span> : <Button variant="secondary" busy={apply.isPending && apply.variables === row.name} disabled={apply.isPending || row.questions === row.failed} onClick={() => apply.mutate(row.name)}>设为默认</Button>}</div></div></td>
            {METRIC_COLUMNS.map(column => <td key={column} className={`tabular-nums ${column === data.objective ? 'font-semibold' : ''}`}>{ratio(row[column] as number | null)}</td>)}
            <td className="tabular-nums">{formatNumber(row.latency_p50_ms)} ms</td>
            <td className={`tabular-nums text-xs ${row.failed ? 'text-red-700' : ''}`}>{row.failed}</td>
          </tr>
        })}
      </tbody></table></div>}
      <p className="text-xs text-slate-500 mt-3">*耗时含跨配置缓存影响，仅供参考，不参与排名。指标为词法证据代理：被召回分块包含标注引文即视为相关。“设为默认”后，聊天默认方法与 MCP method=auto 使用该配置。</p>
      <div className="mt-6"><JsonDetails value={data.candidates} label="查看候选配置" /></div>
    </>}
  </div>
}

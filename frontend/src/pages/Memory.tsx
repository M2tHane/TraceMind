import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, formatNumber, patch, post, remove, useAction, useApi } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatDateTime, formatWhen, useAccountNames } from '../lib/knowledge'
import { MEMORY_CATEGORIES, memoryCategoryLabel, type Memory, type MemoryCategory, type MemoryEvent, type MemorySearchResult, type Page as Paged } from '../lib/types'
import { Page } from '../components/shell/Shell'
import { Button, DataTable, Empty, ErrorState, FactStrip, Field, ImportanceMeter, Loading, Modal, Notice, Pager, SearchableSelect, Segmented, SelectionBar, StatusTag, Tag } from '../components/ui'
import type { Column, TagTone } from '../components/ui'
import { Select } from '../components/Select'

const ACTION_LABELS: Record<string, string> = { create: '创建', update: '更新', delete: '删除', restore: '恢复', merge: '合并', purge: '彻底删除', pending: '提议', approve: '审批通过', reject: '驳回' }
const CATEGORY_TONES: Record<string, TagTone> = { preference: 'run', instruction: 'ok', profile: 'personal', goal: 'warn', fact: 'neutral', other: 'neutral' }
const SOURCE_LABELS: Record<string, string> = { web: '网页', mcp: 'MCP', merge: '合并', extract: '从对话提取', api: 'API' }
const LIST_LIMIT = 500
/** `/memories{suffix}?extra` — always the caller's own memories. */
const memoryPath = (suffix = '', extra = '') => `/memories${suffix}${extra ? `?${extra}` : ''}`
const listPath = (status: string) => memoryPath('', `status=${status}&limit=${LIST_LIMIT}`)
const countPath = (status: string) => memoryPath('', `status=${status}&limit=1`)

function sourceLabel(source: string | undefined): string {
  if (!source) return '—'
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source]
  if (source.startsWith('user:')) return '从对话提取'
  if (source.includes('consolidation')) return '自动整理'
  return source
}

interface MemoryFields { content: string; category: MemoryCategory; tags: string[]; importance: number }
interface AddResult { action: 'created' | 'duplicate' | 'updated' | 'pending'; similarity: number | null; memory: Memory }

function parseTags(value: FormDataEntryValue | null): string[] {
  return String(value ?? '').split(/[,，]/).map(tag => tag.trim()).filter(Boolean)
}

function MemoryForm({ initial, busy, onSubmit, onCancel }: { initial?: Memory; busy: boolean; onSubmit: (fields: MemoryFields) => void; onCancel: () => void }) {
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    onSubmit({ content: String(data.get('content')).trim(), category: String(data.get('category')) as MemoryCategory, tags: parseTags(data.get('tags')), importance: Number(data.get('importance')) })
  }
  return <form className="dialog-body space-y-4" onSubmit={handleSubmit}><fieldset disabled={busy} className="space-y-4">
    <Field label="记忆内容" hint="一条记忆只写一个自包含的事实或偏好"><textarea className="tm-input" name="content" rows={4} required maxLength={4000} defaultValue={initial?.content} placeholder="例如：用户偏好简洁的中文回答" autoFocus /></Field>
    <div className="grid sm:grid-cols-2 gap-4">
      <Field label="分类"><Select name="category" label="分类" defaultValue={initial?.category ?? 'preference'} options={MEMORY_CATEGORIES.map(c => ({ value: c.value, label: c.label }))} /></Field>
      <Field label="重要度" hint="1 低，5 高"><input className="tm-input" name="importance" type="number" min={1} max={5} defaultValue={initial?.importance ?? 3} required /></Field>
    </div>
    <Field label="标签（可选）" hint="逗号分隔"><input className="tm-input" name="tags" defaultValue={initial?.tags.join(', ')} placeholder="例如：语言, 格式" /></Field>
  </fieldset><div className="dialog-actions"><Button variant="secondary" disabled={busy} onClick={onCancel}>取消</Button><Button type="submit" busy={busy}>保存</Button></div></form>
}

// ── character / word level diff for the history panel ──
interface Piece { text: string; kind: 'same' | 'del' | 'add' }
const tokens = (text: string): string[] => text.match(/[A-Za-z0-9_]+|\s+|[\s\S]/gu) ?? []
export function diffText(before: string, after: string): Piece[] {
  const a = tokens(before)
  const b = tokens(after)
  if (a.length * b.length > 1_500_000) return [{ text: before, kind: 'del' }, { text: after, kind: 'add' }]
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
  }
  const pieces: Piece[] = []
  const push = (text: string, kind: Piece['kind']) => { const last = pieces[pieces.length - 1]; if (last?.kind === kind) last.text += text; else pieces.push({ text, kind }) }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(a[i], 'same'); i++; j++ }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) push(a[i++], 'del')
    else push(b[j++], 'add')
  }
  while (i < a.length) push(a[i++], 'del')
  while (j < b.length) push(b[j++], 'add')
  return pieces
}

function DiffLines({ before, after }: { before: string; after: string }) {
  const pieces = diffText(before, after)
  const line = (sign: string, kind: 'del' | 'add') => <p className={`mem-diff mem-diff-${kind}`}><span aria-hidden="true">{sign}</span>
    <span>{pieces.filter(piece => piece.kind === 'same' || piece.kind === kind).map((piece, index) => piece.kind === 'same' ? <span key={index}>{piece.text}</span> : <mark key={index}>{piece.text}</mark>)}</span></p>
  return <div className="mem-diffs" aria-label="内容变化">{line('−', 'del')}{line('+', 'add')}</div>
}

function fieldChanges(before: Partial<Memory>, after: Partial<Memory>): ReactNode[] {
  const out: ReactNode[] = []
  if (before.importance !== undefined && after.importance !== undefined && before.importance !== after.importance) out.push(<p key="importance">重要度 {before.importance} → {after.importance}</p>)
  if (before.category && after.category && before.category !== after.category) out.push(<p key="category">类别 {memoryCategoryLabel(before.category)} → {memoryCategoryLabel(after.category)}</p>)
  if (before.tags && after.tags && before.tags.join() !== after.tags.join()) out.push(<p key="tags">标签 {before.tags.join('、') || '无'} → {after.tags.join('、') || '无'}</p>)
  return out
}

function HistoryPanel({ memory, onClose }: { memory: Memory; onClose: () => void }) {
  const events = useApi<MemoryEvent[]>(memoryPath(`/${memory.id}/history`))
  const { user } = useAuth()
  const actorLabel = (actor: string) => actor === `user:${user?.id}` ? user?.display_name || user?.username || '我' : actor === 'system:consolidation' ? '自动整理' : actor === 'mcp' ? 'MCP' : actor.startsWith('user:') ? '用户' : actor
  const ordered = [...(events.data ?? [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || Number(b.id) - Number(a.id))
  return <aside className="mem-history" aria-label="变更历史">
    <div className="mem-history-head"><h2>变更历史</h2><Button variant="icon" aria-label="关闭变更历史" onClick={onClose}><X size={15} /></Button></div>
    <div className="mem-history-card"><p>{memory.content}</p>
      <span>{memoryCategoryLabel(memory.category)}，最近一次命中{memory.last_accessed_at ? ` ${formatWhen(memory.last_accessed_at)}` : '：无'}，更新于 {formatWhen(memory.updated_at)}</span></div>
    {events.isPending ? <Loading /> : events.isError ? <ErrorState error={events.error} /> : <ol className="mem-timeline">
      {ordered.map((event, index) => {
        const version = event.after?.version ?? event.before?.version
        const channel = sourceLabel((event.after ?? event.before)?.source)
        const changed = event.before?.content !== undefined && event.after?.content !== undefined && event.before.content !== event.after.content
        const fields = event.before && event.after ? fieldChanges(event.before, event.after) : []
        return <li key={event.id} data-latest={index === 0 || undefined}>
          <span className="mem-dot" aria-hidden="true" />
          <p className="mem-event"><strong>{version !== undefined ? `v${version} ` : ''}{ACTION_LABELS[event.action] ?? event.action}</strong><span>{formatWhen(event.created_at)}，{actorLabel(event.actor)}，{channel}</span></p>
          {(changed || fields.length > 0) && <div className="mem-change">{changed && <DiffLines before={event.before!.content!} after={event.after!.content!} />}{fields.length > 0 && <div className="mem-fields">{fields}</div>}</div>}
          {!changed && event.action === 'create' && event.after?.content && <p className="mem-note">{event.after.content}</p>}
          {event.action === 'merge' && event.after?.merged_into_id && <p className="mem-note">合并到 {event.after.merged_into_id}</p>}
        </li>
      })}
    </ol>}
  </aside>
}

function MemoryList() {
  const [status, setStatus] = useState('active')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [detail, setDetail] = useState<Memory | null>(null)
  const [dialog, setDialog] = useState<null | { kind: 'add' | 'merge' | 'extract' } | { kind: 'edit'; memory: Memory }>(null)
  const [extracted, setExtracted] = useState<{ candidates: { content: string; category: string; importance: number }[]; results: AddResult[] } | null>(null)
  const list = useApi<Paged<Memory>>(listPath(status))
  const counts = { active: useApi<{ total: number }>(countPath('active')), merged: useApi<{ total: number }>(countPath('merged')), deleted: useApi<{ total: number }>(countPath('deleted')) }
  const invalidate = [...['active', 'merged', 'deleted'].flatMap(value => [listPath(value), countPath(value)])]
  const search = useAction((text: string) => post<MemorySearchResult>(memoryPath('/search'), { query: text, top_k: 10 }))
  const add = useAction((fields: MemoryFields) => post<AddResult>(memoryPath(), fields), { invalidate, onSuccess: result => {
    setDialog(null)
    if (result.action === 'duplicate') toast.warning(`已存在相同或高度相似的记忆（相似度 ${result.similarity ?? 1}），未重复写入`)
    else toast.success('记忆已添加')
  } })
  const edit = useAction(({ id, fields }: { id: string; fields: MemoryFields & { expected_version: number } }) => patch<Memory>(memoryPath(`/${id}`), fields), { invalidate, success: '记忆已更新', onSuccess: () => { setDialog(null); setDetail(null) } })
  const del = useAction(({ id, hard }: { id: string; hard: boolean }) => remove<unknown>(memoryPath(`/${id}`, `hard=${hard}`)), { invalidate, success: '记忆已删除', onSuccess: (_, { id }) => { setDetail(current => current?.id === id ? null : current); setSelected(current => { const next = new Set(current); next.delete(id); return next }) } })
  const restore = useAction((id: string) => post<Memory>(memoryPath(`/${id}/restore`)), { invalidate, success: '记忆已恢复' })
  const merge = useAction((content: string) => post<{ memory: Memory }>(memoryPath('/merge'), { memory_ids: [...selected], ...(content ? { content } : {}) }), { invalidate, success: '已合并为一条新记忆', onSuccess: () => { setSelected(new Set()); setDialog(null); setDetail(null) } })
  const extract = useAction(({ text, dryRun }: { text: string; dryRun: boolean }) => post<NonNullable<typeof extracted>>('/memories/extract', { text, dry_run: dryRun }), { invalidate, onSuccess: setExtracted })
  const clear = useAction(() => remove<{ deleted: number }>('/memories'), { invalidate, success: '已删除你的全部有效个人记忆', onSuccess: () => { setSelected(new Set()); setDetail(null) } })

  const searching = !!(search.data && query.trim())
  const source = searching ? search.data.results : list.data?.items
  const rows = (source ?? []).filter(row => category === 'all' || row.category === category)
  const shown = rows.slice((page - 1) * pageSize, page * pageSize)
  const selectable = searching || status === 'active'
  const selectedRows = (source ?? []).filter(row => selected.has(row.id))
  function submitSearch(event: FormEvent<HTMLFormElement>): void { event.preventDefault(); if (query.trim()) { setPage(1); search.mutate(query.trim()) } }
  function clearSearch(): void { setQuery(''); search.reset(); setPage(1) }

  const columns: Column<Memory>[] = [
    { key: 'content', header: '内容', cell: memory => <>
      <button type="button" className="tm-linkbtn mem-content" onClick={() => setDetail(memory)}>{memory.content}</button>
      {(memory.tags.length > 0 || !memory.has_embedding || memory.similarity != null || memory.merged_into_id) && <span className="kb-sub">
        {memory.tags.map(tag => `#${tag}`).join(' ')}
        {memory.similarity != null && <span className="tm-num">{memory.tags.length ? '，' : ''}相似度 {memory.similarity.toFixed(3)}</span>}
        {!memory.has_embedding && <span className="kb-sub-warn">{memory.tags.length || memory.similarity != null ? '，' : ''}无向量，仅关键词检索</span>}
        {memory.merged_into_id && <span>{memory.tags.length ? '，' : ''}已合并到 {memory.merged_into_id}</span>}
      </span>}
    </> },
    { key: 'category', header: '类别', nowrap: true, cell: memory => <Tag tone={CATEGORY_TONES[memory.category] ?? 'neutral'}>{memoryCategoryLabel(memory.category)}</Tag> },
    { key: 'importance', header: '重要度', nowrap: true, cell: memory => <ImportanceMeter value={memory.importance} /> },
    { key: 'hits', header: '命中', cell: memory => memory.access_count },
    { key: 'source', header: '来源', nowrap: true, cell: memory => sourceLabel(memory.source) },
    { key: 'version', header: '版本', nowrap: true, cell: memory => `v${memory.version}` },
    { key: 'updated', header: '更新', nowrap: true, cell: memory => <span className="tm-muted">{formatWhen(memory.updated_at)}</span> },
    { key: 'actions', header: <span className="sr-only">操作</span>, nowrap: true, cell: memory => <span className="inline-flex items-center justify-end gap-1">
      {memory.status === 'active' && <>
        <Button variant="icon" aria-label="编辑" title="编辑" onClick={() => setDialog({ kind: 'edit', memory })}><Pencil size={14} /></Button>
        <Button variant="icon" aria-label="删除" title="删除" onClick={() => del.mutate({ id: memory.id, hard: false })}><Trash2 size={14} /></Button></>}
      {memory.status === 'deleted' && <>
        <Button variant="secondary" size="sm" aria-label="恢复" onClick={() => restore.mutate(memory.id)}><RotateCcw size={13} />恢复</Button>
        <Button variant="danger" size="sm" aria-label="彻底删除" onClick={() => { if (window.confirm('彻底删除后无法恢复，仅保留审计记录。继续？')) del.mutate({ id: memory.id, hard: true }) }}>彻底删除</Button></>}
    </span> },
  ]

  return <Page bare title="我的记忆" actions={<>
    <Button variant="secondary" onClick={() => { setExtracted(null); setDialog({ kind: 'extract' }) }}><Sparkles size={14} />从对话中提取</Button>
    <Button onClick={() => setDialog({ kind: 'add' })}><Plus size={14} />添加记忆</Button></>}>
    <div className="mem-layout">
      <div className="tm-body mem-main">
        <div className="kb-filters">
          <form className="tm-search" style={{ flex: '0 1 420px' }} onSubmit={submitSearch}><Search size={14} aria-hidden="true" />
            <input aria-label="语义检索记忆" value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) clearSearch() }} placeholder="按意思或关键词找记忆，回车搜索" /></form>
          {!searching && <Segmented label="记忆状态" value={status} onChange={value => { setStatus(value); setSelected(new Set()); setPage(1); setDetail(null) }}
            items={[{ value: 'active', label: '有效', count: counts.active.data?.total }, { value: 'merged', label: '已合并', count: counts.merged.data?.total }, { value: 'deleted', label: '已删除', count: counts.deleted.data?.total }]} />}
          <SearchableSelect label="类别" trigger={category === 'all' ? '全部类别' : memoryCategoryLabel(category)} value={category} onChange={value => { setCategory(value); setPage(1) }} width={180}
            options={[{ value: 'all', label: '全部类别' }, ...MEMORY_CATEGORIES.map(item => ({ value: item.value, label: item.label }))]} />
          {searching && search.data && <span className="kb-summary">{search.data.mode === 'hybrid' ? '向量 + BM25' : '仅关键词'}，范围 {search.data.searched} 条{search.data.unembedded ? `，${search.data.unembedded} 条缺少向量` : ''}，<button type="button" className="tm-textlink" onClick={clearSearch}>清除搜索</button></span>}
        </div>

        {selected.size > 0 && selectable && <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <Button size="sm" disabled={selected.size < 2} onClick={() => setDialog({ kind: 'merge' })}>合并为一条</Button>
        </SelectionBar>}

        {list.isError && !searching ? <ErrorState error={list.error} retry={() => { void list.refetch() }} /> : (list.isPending && !searching) || search.isPending ? <Loading /> : <div className="tm-panel">
          <DataTable label="记忆" rows={shown} rowKey={memory => memory.id} columns={columns} compact selectedKey={detail?.id} onRowClick={setDetail}
            selection={selectable ? { selected, onChange: setSelected, label: key => (source ?? []).find(row => row.id === key)?.content.slice(0, 30) ?? key } : undefined}
            empty={<Empty title={searching ? '没有相关记忆' : category !== 'all' ? '没有该类别的记忆' : '还没有记忆'} />} />
          <Pager total={rows.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </div>}

        <div className="mem-clear"><button type="button" className="tm-textlink tm-textlink-danger" disabled={clear.isPending} onClick={() => { if (window.confirm('删除你的全部有效个人记忆？删除后可在“已删除”中恢复。')) clear.mutate(undefined) }}>清空我的记忆</button></div>
      </div>
      {detail && <HistoryPanel key={detail.id} memory={detail} onClose={() => setDetail(null)} />}
    </div>

    <Modal open={dialog?.kind === 'add'} onOpenChange={open => { if (!open) setDialog(null) }} title="添加记忆" description="写入前会按文本与向量相似度去重。">{dialog?.kind === 'add' && <>{add.error && <div className="px-5 pt-4"><ErrorState error={add.error} /></div>}<MemoryForm busy={add.isPending} onCancel={() => setDialog(null)} onSubmit={fields => add.mutate(fields)} /></>}</Modal>
    <Modal open={dialog?.kind === 'edit'} onOpenChange={open => { if (!open) setDialog(null) }} title="编辑记忆" description="修改内容会重新计算向量并递增版本号。">{dialog?.kind === 'edit' && <MemoryForm initial={dialog.memory} busy={edit.isPending} onCancel={() => setDialog(null)} onSubmit={fields => edit.mutate({ id: dialog.memory.id, fields: { ...fields, expected_version: dialog.memory.version } })} />}</Modal>
    <Modal open={dialog?.kind === 'merge'} onOpenChange={open => { if (!open) setDialog(null) }} title={`合并 ${selected.size} 条记忆`} description="生成一条新记忆，原记忆标记为已合并。">{dialog?.kind === 'merge' && <form className="dialog-body space-y-4" onSubmit={event => { event.preventDefault(); merge.mutate(String(new FormData(event.currentTarget).get('content') ?? '').trim()) }}>
      <ul className="mem-merge-list">{selectedRows.map(row => <li key={row.id}>{row.content}</li>)}</ul>
      <Field label="合并后的内容（可选）" hint="留空则由对话模型整合，可能产生费用"><textarea className="tm-input" name="content" rows={4} maxLength={4000} /></Field>
      {merge.error && <ErrorState error={merge.error} />}
      <div className="dialog-actions"><Button variant="secondary" disabled={merge.isPending} onClick={() => setDialog(null)}>取消</Button><Button type="submit" busy={merge.isPending}>合并为一条</Button></div>
    </form>}</Modal>
    <Modal open={dialog?.kind === 'extract'} onOpenChange={open => { if (!open) setDialog(null) }} title="从对话中提取记忆" description="对话模型挑出长期有效的偏好、画像与目标；与已有记忆重复的会跳过。" wide>{dialog?.kind === 'extract' && <form className="dialog-body space-y-4" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); extract.mutate({ text: String(data.get('text')), dryRun: data.get('dry_run') === 'on' }) }}>
      <Field label="对话文本"><textarea className="tm-input" name="text" rows={8} required maxLength={50000} placeholder={'用户：以后回答都用中文，尽量简短。\n助手：好的。\n用户：我在做检索增强生成相关的研究……'} /></Field>
      <label className="doc-follow"><input type="checkbox" className="tm-check" name="dry_run" />仅预览，不写入</label>
      <Notice>会调用对话模型，可能产生费用。</Notice>
      {extract.error && <ErrorState error={extract.error} />}
      {extracted && <ul className="mem-merge-list">{!extracted.candidates.length ? <li className="tm-muted">没有提取到需要长期保存的信息。</li> : extracted.candidates.map((candidate, index) => <li key={index}><Tag tone={CATEGORY_TONES[candidate.category] ?? 'neutral'}>{memoryCategoryLabel(candidate.category)}</Tag> {candidate.content}{extracted.results[index] && <span className="tm-muted tm-num"> {({ created: '已写入', duplicate: '重复，已跳过', updated: '已更新', pending: '待审批' })[extracted.results[index].action]}</span>}</li>)}</ul>}
      <div className="dialog-actions"><Button variant="secondary" disabled={extract.isPending} onClick={() => setDialog(null)}>关闭</Button><Button type="submit" busy={extract.isPending}><Sparkles size={14} />提取</Button></div>
    </form>}</Modal>
  </Page>
}

export function MemoryPage() {
  return <MemoryList />
}

// ───────────────────────────── 自动整理（管理员） ─────────────────────────────

interface ConsolidationRun { id: string; status: string; trigger: string; started_at: string; finished_at: string | null; users_processed: number; memories_merged: number; memories_archived: number; error: string | null; created_at: string }
interface Consolidation {
  settings: { enabled: boolean; interval_minutes: number; threshold: number; target_ratio: number; target: number; similarity: number; batch_size: number; max_active_per_user: number }
  running: boolean
  runs: ConsolidationRun[]
  users_over_threshold: { user_id: string; active: number }[]
}
const TRIGGER_LABELS: Record<string, string> = { schedule: '定时', scheduled: '定时', manual: '手动' }
const RUN_LABELS: Record<string, string> = { running: '运行中', completed: '已完成', failed: '失败' }
function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

export function MemoryConsolidationPage() {
  const data = useApi<Consolidation>('/admin/memory/consolidation', { poll: 5000 })
  const names = useAccountNames()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const client = useQueryClient()
  const run = useMutation<ConsolidationRun, Error>({
    mutationFn: () => post<ConsolidationRun>('/admin/memory/consolidate'),
    onSuccess: () => { toast.success('已开始整理'); void client.invalidateQueries({ queryKey: ['/admin/memory/consolidation'] }) },
    onError: error => {
      if (error instanceof ApiError && error.status === 409) { toast.info('整理正在运行，请稍后再试'); void client.invalidateQueries({ queryKey: ['/admin/memory/consolidation'] }) }
      else toast.error(error.message)
    },
  })
  const trigger = () => run.mutate()
  const settings = data.data?.settings
  const runs = data.data?.runs ?? []
  const shown = runs.slice((page - 1) * pageSize, page * pageSize)
  const running = data.data?.running ?? false

  const runColumns: Column<ConsolidationRun>[] = [
    { key: 'trigger', header: '触发方式', nowrap: true, cell: item => TRIGGER_LABELS[item.trigger] ?? item.trigger },
    { key: 'status', header: '状态', nowrap: true, cell: item => <StatusTag value={item.status} label={RUN_LABELS[item.status]} /> },
    { key: 'started', header: '开始', nowrap: true, cell: item => <span className="tm-muted">{formatDateTime(item.started_at)}</span> },
    { key: 'finished', header: '结束', nowrap: true, cell: item => item.finished_at ? <span className="tm-muted">{formatDateTime(item.finished_at)}</span> : <span className="tm-faint">—</span> },
    { key: 'users', header: '处理用户', cell: item => formatNumber(item.users_processed) },
    { key: 'merged', header: '合并', cell: item => formatNumber(item.memories_merged) },
    { key: 'archived', header: '归档', cell: item => formatNumber(item.memories_archived) },
    { key: 'error', header: '错误', cell: item => item.error ? <span className="kb-sub-err break-words">{item.error}</span> : <span className="tm-faint">—</span> },
  ]

  return <Page title="自动整理" meta={running && <Tag tone="run">运行中</Tag>}
    actions={<Button busy={run.isPending} disabled={running} onClick={trigger}>立即整理</Button>}>
    {data.isError ? <ErrorState error={data.error} retry={() => { void data.refetch() }} /> : data.isPending ? <Loading /> : <>
      {settings && <FactStrip items={[
        { label: '状态', value: <Tag tone={settings.enabled ? 'ok' : 'neutral'}>{settings.enabled ? '已启用' : '已停用'}</Tag> },
        { label: '触发阈值', value: `超过 ${formatNumber(settings.threshold)} 条` },
        { label: '整理目标', value: `${formatNumber(settings.target)} 条（${Math.round(settings.target_ratio * 100)}%）` },
        { label: '运行间隔', value: intervalLabel(settings.interval_minutes) },
        { label: '相似度', value: settings.similarity },
        { label: '单用户上限', value: `${formatNumber(settings.max_active_per_user)} 条` },
      ]} />}
      <section className="tm-panel" aria-label="超过阈值的用户">
        <div className="kb-section-title"><h2>超过阈值的用户</h2><span className="tm-faint tm-num">{data.data.users_over_threshold.length}</span></div>
        <DataTable label="超过阈值的用户" rows={data.data.users_over_threshold} rowKey={item => item.user_id} empty="没有用户超过阈值"
          columns={[
            { key: 'user', header: '用户', cell: item => names(item.user_id.replace(/^user:/, '')) ?? item.user_id },
            { key: 'active', header: '有效记忆', cell: item => `${formatNumber(item.active)} 条` },
          ]} />
      </section>
      <section className="tm-panel" aria-label="最近运行">
        <div className="kb-section-title"><h2>最近运行</h2><span className="tm-faint tm-num">{runs.length}</span></div>
        <DataTable label="最近运行" rows={shown} rowKey={item => item.id} columns={runColumns} minWidth={820} empty="还没有运行记录" />
        <Pager total={runs.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} unit="次" />
      </section>
    </>}
  </Page>
}

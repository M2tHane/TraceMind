import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Building2, Combine, History, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, Undo2, UserRound } from 'lucide-react'
import { formatDate, patch, post, remove, useAction, useApi } from '../lib/api'
import { useIsAdmin } from '../lib/auth'
import { MEMORY_CATEGORIES, memoryCategoryLabel, type Memory, type MemoryCategory, type MemoryEvent, type MemorySearchResult, type Scope } from '../lib/types'
import { Button, Empty, ErrorState, Field, Loading, Modal, Notice, PageHeader, Status, Tabs } from '../components/ui'
import { Select } from '../components/Select'

const ACTION_LABELS: Record<string, string> = { create: '创建', update: '更新', delete: '删除', restore: '恢复', merge: '合并', purge: '彻底删除', pending: '提议', approve: '审批通过', reject: '驳回' }
/** `/memories{suffix}?scope=…&extra` */
const memoryPath = (scope: Scope, suffix = '', extra = '') => `/memories${suffix}?scope=${scope}${extra ? `&${extra}` : ''}`

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
  return <form className="dialog-body space-y-5" onSubmit={handleSubmit}><fieldset disabled={busy} className="space-y-5">
    <Field label="记忆内容" hint="一条记忆只写一个自包含的事实或偏好"><textarea name="content" rows={4} required maxLength={4000} defaultValue={initial?.content} placeholder="例如：用户偏好简洁的中文回答" autoFocus /></Field>
    <div className="grid sm:grid-cols-2 gap-4">
      <Field label="分类"><Select name="category" label="分类" defaultValue={initial?.category ?? 'preference'} options={MEMORY_CATEGORIES.map(c => ({ value: c.value, label: c.label }))} /></Field>
      <Field label="重要度" hint="1 低 — 5 高"><input name="importance" type="number" min={1} max={5} defaultValue={initial?.importance ?? 3} required /></Field>
    </div>
    <Field label="标签（可选）" hint="逗号分隔"><input name="tags" defaultValue={initial?.tags.join(', ')} placeholder="例如：语言, 格式" /></Field>
  </fieldset><div className="dialog-actions"><Button variant="secondary" disabled={busy} onClick={onCancel}>取消</Button><Button type="submit" busy={busy}>保存</Button></div></form>
}

function HistoryView({ scope, memoryId }: { scope: Scope; memoryId: string }) {
  const events = useApi<MemoryEvent[]>(memoryPath(scope, `/${memoryId}/history`))
  if (events.isPending) return <Loading />
  if (events.isError) return <ErrorState error={events.error} />
  return <ol className="dialog-body space-y-4">{events.data.map(event => <li key={event.id} className="memory-card">
    <div className="flex justify-between text-sm"><strong>{ACTION_LABELS[event.action] ?? event.action}</strong><span className="text-xs text-slate-500">{formatDate(event.created_at)} · {event.actor}</span></div>
    {event.before?.content && event.after?.content && event.before.content !== event.after.content
      ? <div className="text-xs mt-2 space-y-1"><p className="text-red-700 line-through break-words">{event.before.content}</p><p className="text-green-700 break-words">{event.after.content}</p></div>
      : <p className="text-xs text-slate-600 mt-2 break-words">{(event.after ?? event.before)?.content}</p>}
    {event.after && <p className="text-xs text-slate-400 mt-1">状态 {event.after.status} · 版本 {event.after.version}</p>}
  </li>)}</ol>
}

function MemoryCard({ memory, canEdit, selected, onSelect, onEdit, onHistory, onDelete, onRestore, onPurge, onWithdraw }: { memory: Memory; canEdit: boolean; selected: boolean; onSelect: (checked: boolean) => void; onEdit: () => void; onHistory: () => void; onDelete: () => void; onRestore: () => void; onPurge: () => void; onWithdraw?: () => void }) {
  return <article className="memory-card"><div className="flex gap-3 items-start">
    {canEdit && memory.status === 'active' && <input type="checkbox" className="mt-1" aria-label="选择以合并" checked={selected} onChange={e => onSelect(e.target.checked)} />}
    <div className="flex-1 min-w-0">
      <p className="text-sm leading-6 break-words">{memory.content}</p>
      <div className="memory-card-meta">
        {['pending', 'rejected'].includes(memory.status) && <Status value={memory.status} />}
        <span className="file-tag">{memoryCategoryLabel(memory.category)}</span>
        {memory.tags.map(tag => <span key={tag} className="file-tag">#{tag}</span>)}
        <span className="importance" title={`重要度 ${memory.importance}`}>{'★'.repeat(memory.importance)}{'☆'.repeat(5 - memory.importance)}</span>
        <span>v{memory.version}</span><span>命中 {memory.access_count}</span><span>{memory.source}</span><span>{formatDate(memory.updated_at)}</span>
        {!memory.has_embedding && <span className="text-amber-700">无向量（仅关键词检索）</span>}
        {memory.similarity != null && <span>相似度 {memory.similarity.toFixed(3)}</span>}
        {memory.merged_into_id && <span>已合并到 {memory.merged_into_id}</span>}
      </div>
    </div>
    <div className="flex gap-1 shrink-0">
      {canEdit && memory.status === 'active' && <button type="button" className="icon-button" title="编辑" aria-label="编辑" onClick={onEdit}><Pencil size={15} /></button>}
      <button type="button" className="icon-button" title="历史" aria-label="历史" onClick={onHistory}><History size={15} /></button>
      {canEdit && memory.status === 'active' && <button type="button" className="icon-button" title="删除（可恢复）" aria-label="删除" onClick={onDelete}><Trash2 size={15} /></button>}
      {onWithdraw && memory.status === 'pending' && <button type="button" className="icon-button" title="撤回提议" aria-label="撤回提议" onClick={onWithdraw}><Undo2 size={15} /></button>}
      {canEdit && memory.status === 'deleted' && <><button type="button" className="icon-button" title="恢复" aria-label="恢复" onClick={onRestore}><RotateCcw size={15} /></button><button type="button" className="icon-button text-red-700" title="彻底删除" aria-label="彻底删除" onClick={onPurge}><Trash2 size={15} /></button></>}
    </div>
  </div></article>
}

function ScopeMemories({ scope }: { scope: Scope }) {
  const admin = useIsAdmin()
  // Personal memories belong to the caller. Platform memories: administrators edit, employees propose.
  const canEdit = scope === 'personal' || admin
  const proposing = scope === 'platform' && !admin
  const tabs = canEdit ? [{ value: 'active', label: '有效' }, ...(scope === 'platform' ? [{ value: 'pending', label: '待审批' }] : []), { value: 'merged', label: '已合并' }, { value: 'deleted', label: '已删除' }]
    : [{ value: 'active', label: '有效' }, { value: 'pending', label: '我的提议' }, { value: 'rejected', label: '已驳回' }]
  const [status, setStatus] = useState('active')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<null | { kind: 'add' | 'merge' | 'extract' } | { kind: 'edit' | 'history'; memory: Memory }>(null)
  const [extracted, setExtracted] = useState<{ candidates: { content: string; category: string; importance: number }[]; results: AddResult[] } | null>(null)
  const listPath = (value: string) => memoryPath(scope, '', `status=${value}&limit=200`)
  const list = useApi<{ total: number; items: Memory[] }>(listPath(status))
  const invalidate = [...['active', 'pending', 'rejected', 'merged', 'deleted'].map(listPath), '/admin/reviews', '/admin/reviews/count']
  const search = useAction((text: string) => post<MemorySearchResult>(memoryPath(scope, '/search'), { query: text, top_k: 10 }))
  const add = useAction((fields: MemoryFields) => post<AddResult>(memoryPath(scope), fields), { invalidate, onSuccess: result => {
    setDialog(null)
    if (result.action === 'duplicate') window.alert(`已存在相同或高度相似的记忆（相似度 ${result.similarity ?? 1}），未重复写入。`)
    else if (result.action === 'pending') window.alert('已提交，管理员审批通过后对所有人生效。')
  } })
  const edit = useAction(({ id, fields }: { id: string; fields: MemoryFields & { expected_version: number } }) => patch<Memory>(memoryPath(scope, `/${id}`), fields), { invalidate, success: '记忆已更新', onSuccess: () => setDialog(null) })
  const del = useAction(({ id, hard }: { id: string; hard: boolean }) => remove<unknown>(memoryPath(scope, `/${id}`, `hard=${hard}`)), { invalidate, success: '记忆已删除' })
  const restore = useAction((id: string) => post<Memory>(memoryPath(scope, `/${id}/restore`)), { invalidate, success: '记忆已恢复' })
  const merge = useAction((content: string) => post<{ memory: Memory }>(memoryPath(scope, '/merge'), { memory_ids: selected, ...(content ? { content } : {}) }), { invalidate, success: '已合并为一条新记忆', onSuccess: () => { setSelected([]); setDialog(null) } })
  const extract = useAction(({ text, dryRun }: { text: string; dryRun: boolean }) => post<NonNullable<typeof extracted>>('/memories/extract', { text, dry_run: dryRun }), { invalidate, onSuccess: setExtracted })
  const clear = useAction(() => remove<{ deleted: number }>('/memories'), { invalidate, success: '已删除你的全部有效个人记忆' })
  const rows = search.data && query.trim() ? search.data.results : list.data?.items
  function submitSearch(event: FormEvent<HTMLFormElement>): void { event.preventDefault(); if (query.trim()) search.mutate(query.trim()) }
  const selectedRows = (list.data?.items ?? []).filter(row => selected.includes(row.id))

  return <section className="min-w-0">
    <div className="flex flex-wrap items-center gap-3 mb-4">
      <span className="text-xs text-slate-500">{list.data ? `${list.data.total} 条` : ''}</span>
      <div className="ml-auto flex flex-wrap gap-2">
        {scope === 'personal' && <Button variant="secondary" onClick={() => { setExtracted(null); setDialog({ kind: 'extract' }) }}><Sparkles size={15} />从对话抽取</Button>}
        {canEdit && <Button variant="secondary" disabled={selected.length < 2} onClick={() => setDialog({ kind: 'merge' })}><Combine size={15} />合并所选 {selected.length || ''}</Button>}
        <Button onClick={() => setDialog({ kind: 'add' })}><Plus size={15} />{proposing ? '提议平台记忆' : '添加记忆'}</Button>
      </div>
    </div>
    <form className="search-field memory-search mb-4" onSubmit={submitSearch}><Search size={15} /><input aria-label="语义检索记忆" value={query} onChange={e => { setQuery(e.target.value); if (!e.target.value) search.reset() }} placeholder="语义 + 关键词检索有效记忆，回车搜索…" /></form>
    {search.data && query.trim() && <p className="text-xs text-slate-500 mb-3">检索模式 {search.data.mode === 'hybrid' ? '向量 + BM25' : '仅关键词'} · 范围 {search.data.searched} 条{search.data.unembedded ? ` · ${search.data.unembedded} 条缺少向量` : ''} · <button type="button" className="text-link" onClick={() => { setQuery(''); search.reset() }}>清除搜索</button></p>}
    {!(search.data && query.trim()) && <Tabs value={status} onChange={value => { setStatus(value); setSelected([]) }} items={tabs} />}
    {admin && scope === 'platform' && status === 'pending' && <p className="text-xs text-slate-500 mt-3">员工提议在 <Link className="text-link" to="/admin/reviews">管理 · 待审批</Link> 中处理。</p>}
    <div className="mt-4">{list.isPending || search.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} retry={() => { void list.refetch() }} /> : !rows?.length
      ? <Empty title={query ? '没有相关记忆' : '还没有记忆'} description={scope === 'personal' ? '通过“添加记忆”手动写入，或从一段对话中自动抽取。Agent 也可以通过 MCP 写入。' : '平台记忆对所有员工生效，用于个性化每个人的回答。'} />
      : rows.map(memory => <MemoryCard key={memory.id} memory={memory} canEdit={canEdit} selected={selected.includes(memory.id)}
        onWithdraw={proposing ? () => { if (window.confirm('撤回这条提议？')) del.mutate({ id: memory.id, hard: false }) } : undefined}
        onSelect={checked => setSelected(current => checked ? [...current, memory.id] : current.filter(id => id !== memory.id))}
        onEdit={() => setDialog({ kind: 'edit', memory })} onHistory={() => setDialog({ kind: 'history', memory })}
        onDelete={() => del.mutate({ id: memory.id, hard: false })} onRestore={() => restore.mutate(memory.id)}
        onPurge={() => { if (window.confirm('彻底删除后无法恢复，仅保留审计记录。继续？')) del.mutate({ id: memory.id, hard: true }) }} />)}</div>
    {scope === 'personal' && <div className="mt-8 pt-4 border-t text-right"><Button variant="danger" busy={clear.isPending} onClick={() => { if (window.confirm('删除你的全部有效个人记忆？删除后可在“已删除”中恢复。')) clear.mutate(undefined) }}><Trash2 size={15} />清空我的记忆</Button></div>}

    <Modal open={dialog?.kind === 'add'} onOpenChange={open => { if (!open) setDialog(null) }} title={proposing ? '提议平台记忆' : '添加记忆'} description={proposing ? '提交后由管理员审批，通过后对所有员工生效。' : '写入前会按文本与向量相似度去重。'}>{dialog?.kind === 'add' && <>{add.error && <div className="px-6"><ErrorState error={add.error} /></div>}<MemoryForm busy={add.isPending} onCancel={() => setDialog(null)} onSubmit={fields => add.mutate(fields)} /></>}</Modal>
    <Modal open={dialog?.kind === 'edit'} onOpenChange={open => { if (!open) setDialog(null) }} title="编辑记忆" description="修改内容会重新计算向量并递增版本号。">{dialog?.kind === 'edit' && <MemoryForm initial={dialog.memory} busy={edit.isPending} onCancel={() => setDialog(null)} onSubmit={fields => edit.mutate({ id: dialog.memory.id, fields: { ...fields, expected_version: dialog.memory.version } })} />}</Modal>
    <Modal open={dialog?.kind === 'history'} onOpenChange={open => { if (!open) setDialog(null) }} title="变更历史" description="创建、修改、删除、恢复与合并的审计记录。" wide>{dialog?.kind === 'history' && <HistoryView scope={scope} memoryId={dialog.memory.id} />}</Modal>
    <Modal open={dialog?.kind === 'merge'} onOpenChange={open => { if (!open) setDialog(null) }} title={`合并 ${selected.length} 条记忆`} description="生成一条新记忆，原记忆标记为“已合并”。标签取并集，重要度取最大值。">{dialog?.kind === 'merge' && <form className="dialog-body space-y-4" onSubmit={event => { event.preventDefault(); merge.mutate(String(new FormData(event.currentTarget).get('content') ?? '').trim()) }}>
      <ul className="text-sm space-y-2">{selectedRows.map(row => <li key={row.id} className="memory-card">{row.content}</li>)}</ul>
      <Field label="合并后的内容（可选）" hint="留空则由对话模型整合（可能产生费用）"><textarea name="content" rows={4} maxLength={4000} /></Field>
      {merge.error && <ErrorState error={merge.error} />}
      <div className="dialog-actions"><Button variant="secondary" disabled={merge.isPending} onClick={() => setDialog(null)}>取消</Button><Button type="submit" busy={merge.isPending}><Combine size={15} />合并</Button></div>
    </form>}</Modal>
    <Modal open={dialog?.kind === 'extract'} onOpenChange={open => { if (!open) setDialog(null) }} title="从对话抽取记忆" description="对话模型挑出长期有效的偏好、画像与目标；与已有记忆重复的会跳过。" wide>{dialog?.kind === 'extract' && <form className="dialog-body space-y-4" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); extract.mutate({ text: String(data.get('text')), dryRun: data.get('dry_run') === 'on' }) }}>
      <Field label="对话文本"><textarea name="text" rows={8} required maxLength={50000} placeholder={'用户：以后回答都用中文，尽量简短。\n助手：好的。\n用户：我在做检索增强生成相关的研究……'} /></Field>
      <label className="checkbox-label"><input type="checkbox" name="dry_run" /><span>仅预览，不写入</span></label>
      <Notice>会调用对话模型，可能产生费用。</Notice>
      {extract.error && <ErrorState error={extract.error} />}
      {extracted && <div className="space-y-2">{!extracted.candidates.length ? <p className="text-sm text-slate-500">没有抽取到需要长期保存的信息。</p> : extracted.candidates.map((candidate, index) => <div key={index} className="memory-card text-sm"><span className="file-tag mr-2">{memoryCategoryLabel(candidate.category)}</span>{candidate.content}{extracted.results[index] && <span className="text-xs text-slate-500 ml-2">{({ created: '已写入', duplicate: '重复，已跳过', updated: '已更新', pending: '待审批' })[extracted.results[index].action]}</span>}</div>)}</div>}
      <div className="dialog-actions"><Button variant="secondary" disabled={extract.isPending} onClick={() => setDialog(null)}>关闭</Button><Button type="submit" busy={extract.isPending}><Sparkles size={15} />抽取</Button></div>
    </form>}</Modal>
  </section>
}

export function MemoryPage() {
  const { scope: param } = useParams()
  const navigate = useNavigate()
  const scope: Scope = param === 'platform' ? 'platform' : 'personal'
  return <div className="page page-wide"><PageHeader title="记忆" description="长期记忆用于个性化回答：个人记忆只属于你，平台记忆对所有员工生效。" />
    <nav className="tabs mb-6" aria-label="记忆范围">{[{ value: 'personal', label: '我的记忆', icon: UserRound }, { value: 'platform', label: '平台记忆', icon: Building2 }].map(tab =>
      <button key={tab.value} type="button" className={`tab inline-flex items-center gap-2 ${scope === tab.value ? 'tab-active' : ''}`} aria-current={scope === tab.value ? 'page' : undefined} onClick={() => navigate(tab.value === 'personal' ? '/memory' : '/memory/platform')}><tab.icon size={15} />{tab.label}</button>)}</nav>
    <ScopeMemories key={scope} scope={scope} />
  </div>
}

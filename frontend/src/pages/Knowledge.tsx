import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatNumber, post, put, remove, useAction, useApi } from '../lib/api'
import { DEFAULT_RETRIEVAL } from '../lib/types'
import type { Citation, Document, KnowledgeBase, Scope } from '../lib/types'
import { useAuth } from '../lib/auth'
import {
  documentsPath, formatDateTime, formatElapsed, formatWhen, isFailed, isProcessing, latest, retrievalLabel, sourceLabel, useAccountNames, useLibraryDocuments,
  type LibraryDocument, type LibraryInfo,
} from '../lib/knowledge'
import { Select } from '../components/Select'
import { KnowledgeListSide, KnowledgeSide, rememberKnowledgeBase, type KnowledgeFilter } from '../components/shell/ModuleNav'
import { Page } from '../components/shell/Shell'
import {
  Button, DataTable, Empty, ErrorState, FactList, FactStrip, Field, FileTypeTag, Loading, Modal, Notice, Pager, ScopeTag, SearchableSelect, Segmented, SelectionBar,
  StatusTag, StepBar, Tabs, Tag, buttonClass, documentSteps,
} from '../components/ui'
import type { Column } from '../components/ui'
import { Markdown, PdfViewer } from '../components/sources'
import { PdfCanvas } from '../components/PdfCanvas'

const FILE_PATTERN = /\.(pdf|md|markdown|txt)$/i
const ACCEPT = '.pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain'

// ───────────────────────────── 知识库列表 ─────────────────────────────

interface LibraryRow { kb: LibraryInfo; docs: Document[] | undefined; processing: number; failed: number; updated: string }
const STATUS_FILTERS = [
  { value: 'all', label: '全部' }, { value: 'clean', label: '全部就绪' }, { value: 'processing', label: '有处理中' }, { value: 'failed', label: '有失败' }, { value: 'pending', label: '有待审批' },
]
type DocView = 'all' | 'processing' | 'failed'

function stageNote(doc: Document): { text: string; failed: boolean } {
  const { current } = documentSteps(doc.status, doc.stage)
  if (isFailed(doc)) return { text: doc.error ? `${current}：${doc.error}` : current, failed: true }
  return { text: doc.status === 'queued' ? '排队中' : current, failed: false }
}

export function KnowledgePage() {
  const query = useApi<KnowledgeBase[]>('/knowledge-bases', { poll: 10000 })
  const libraries = query.data as LibraryInfo[] | undefined
  const { docs, byLibrary, loaded } = useLibraryDocuments(libraries)
  const names = useAccountNames()
  const client = useQueryClient()
  const navigate = useNavigate()
  const admin = useAuth().user?.role === 'admin'
  const [params, setParams] = useSearchParams()
  const scope: KnowledgeFilter = params.get('scope') === 'platform' || params.get('scope') === 'personal' ? params.get('scope') as Scope : 'all'
  const docView: DocView = params.get('docs') === 'failed' ? 'failed' : params.get('docs') === 'processing' ? 'processing' : 'all'
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [docPage, setDocPage] = useState(1)
  const [docPageSize, setDocPageSize] = useState(10)
  const [open, setOpen] = useState(false)
  const [formScope, setFormScope] = useState<Scope>('personal')
  const problems = useRef<HTMLElement>(null)

  const create = useAction((body: { name: string; description: string; chunk_size: number; chunk_overlap: number; scope: Scope }) => post<KnowledgeBase>('/knowledge-bases', body), { invalidate: ['/knowledge-bases'], success: '知识库已创建', onSuccess: kb => { setOpen(false); navigate(`/knowledge/${kb.id}`) } })
  const retry = useAction((doc: LibraryDocument) => post<Document>(`/documents/${doc.id}/retry`), { success: '已重新加入处理队列', onSuccess: (_, doc) => { void client.invalidateQueries({ queryKey: [documentsPath(doc.knowledge_base_id)] }) } })

  const rows: LibraryRow[] = (libraries ?? []).map(kb => {
    const kbDocs = byLibrary.get(kb.id)
    return { kb, docs: kbDocs, processing: kbDocs?.filter(isProcessing).length ?? 0, failed: kbDocs?.filter(isFailed).length ?? 0, updated: latest([...(kbDocs ?? []).map(doc => doc.updated_at), kb.created_at]) ?? kb.created_at }
  })
  const needle = search.trim().toLowerCase()
  const visible = rows.filter(row => (scope === 'all' || row.kb.scope === scope)
    && (!needle || `${row.kb.name} ${row.kb.description}`.toLowerCase().includes(needle))
    && (status === 'all' || (status === 'clean' ? row.kb.document_count === row.kb.ready_count && !row.processing && !row.failed
      : status === 'processing' ? row.processing > 0 : status === 'failed' ? row.failed > 0 : (row.kb.pending_count ?? 0) > 0)))
  const shown = visible.slice((page - 1) * pageSize, page * pageSize)
  const scopeCount = (value: Scope) => rows.filter(row => row.kb.scope === value).length

  const processing = docs.filter(isProcessing)
  const failed = docs.filter(isFailed)
  const problemDocs = (docView === 'failed' ? failed : docView === 'processing' ? processing : [...processing, ...failed])
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  const shownProblems = problemDocs.slice((docPage - 1) * docPageSize, docPage * docPageSize)
  const kbById = new Map((libraries ?? []).map(kb => [kb.id, kb]))
  const hasUploaders = problemDocs.some(doc => names(doc.uploaded_by))

  useEffect(() => { if (docView !== 'all' && loaded) problems.current?.scrollIntoView({ block: 'start' }) }, [docView, loaded])

  function setParam(key: string, value: string | null): void {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    setParams(next, { replace: true })
    setPage(1)
  }
  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const chunk_size = Number(form.get('chunk_size')); const chunk_overlap = Number(form.get('chunk_overlap'))
    if (chunk_overlap >= chunk_size) { toast.error('分块重叠长度必须小于分块长度'); return }
    create.mutate({ name: String(form.get('name')).trim(), description: String(form.get('description')).trim(), chunk_size, chunk_overlap, scope: admin ? formScope : 'personal' })
  }

  const columns: Column<LibraryRow>[] = [
    { key: 'name', header: '名称', cell: ({ kb }) => <><Link className="kb-name" to={`/knowledge/${kb.id}`}>{kb.name}</Link><span className="kb-sub kb-sub-clip" title={kb.description || undefined}>{kb.description || '暂无描述'}</span></> },
    { key: 'scope', header: '范围', cell: ({ kb }) => <ScopeTag scope={kb.scope} /> },
    { key: 'docs', header: '文档', nowrap: true, cell: ({ kb, processing: running, failed: broken }) => <>
      {kb.document_count === 0 ? '0 份' : kb.ready_count === kb.document_count ? `${formatNumber(kb.document_count)} 份，全部就绪` : `${formatNumber(kb.ready_count)} / ${formatNumber(kb.document_count)} 已就绪`}
      {(running > 0 || broken > 0) && <span className="kb-sub">{running > 0 && <span className="kb-sub-run">{running} 份处理中</span>}{running > 0 && broken > 0 && '，'}{broken > 0 && <span className="kb-sub-err">{broken} 份失败</span>}</span>}
    </> },
    { key: 'chunks', header: '分块', align: 'right', cell: ({ kb }) => formatNumber(kb.chunk_count) },
    { key: 'embedding', header: 'Embedding', nowrap: true, cell: ({ kb }) => <><span className="tm-mono">{kb.embedding_model || '未配置'}</span>{kb.embedding_dimensions ? <span className="kb-sub">{kb.embedding_dimensions} 维</span> : null}</> },
    { key: 'retrieval', header: '默认检索', nowrap: true, cell: ({ kb }) => retrievalLabel(kb.retrieval_config) },
    { key: 'pending', header: '待审批', align: 'right', cell: ({ kb }) => kb.pending_count ? <Tag tone="wait">{kb.pending_count}</Tag> : <span className="tm-faint">—</span> },
    { key: 'updated', header: '更新', nowrap: true, cell: row => <span className="tm-muted">{formatWhen(row.updated)}</span> },
    { key: 'actions', header: <span className="sr-only">操作</span>, align: 'right', nowrap: true, cell: ({ kb }) => <Link className={buttonClass('secondary', 'sm')} to={`/chat?kb=${kb.id}`} aria-label={`去提问：${kb.name}`}>去提问</Link> },
  ]
  const problemColumns: Column<LibraryDocument>[] = [
    { key: 'file', header: '文档', cell: doc => <span className="kb-file"><FileTypeTag filename={doc.filename} /><span className="min-w-0"><Link className="kb-file-name" to={`/knowledge/${doc.knowledge_base_id}/documents/${doc.id}`}>{doc.filename}</Link>
      {doc.replaces_document_id && <span className="kb-sub">替换旧版本，旧版本在新版本就绪前继续可检索</span>}</span></span> },
    { key: 'kb', header: '知识库', cell: doc => <Link className="tm-muted" to={`/knowledge/${doc.knowledge_base_id}`}>{doc.knowledge_base_name}</Link> },
    { key: 'steps', header: '进度', cell: doc => { const { steps, current } = documentSteps(doc.status, doc.stage); return <StepBar steps={steps} label={`处理进度：${current}`} /> } },
    { key: 'stage', header: '当前阶段', cell: doc => { const note = stageNote(doc); return <span className={note.failed ? 'kb-sub-err' : 'kb-sub-run'} title={note.text}>{note.text.length > 46 ? `${note.text.slice(0, 46)}…` : note.text}</span> } },
    ...(hasUploaders ? [{ key: 'uploader', header: '上传者', nowrap: true, cell: (doc: LibraryDocument) => names(doc.uploaded_by) ?? '—' }] : []),
    { key: 'elapsed', header: '已用时', align: 'right', nowrap: true, cell: doc => isProcessing(doc) ? formatElapsed(doc.created_at) : <span className="tm-faint">—</span> },
    { key: 'actions', header: <span className="sr-only">操作</span>, align: 'right', nowrap: true, cell: doc => isFailed(doc) && kbById.get(doc.knowledge_base_id)?.can_manage
      ? <Button variant="secondary" size="sm" busy={retry.isPending && retry.variables?.id === doc.id} disabled={retry.isPending} onClick={() => retry.mutate(doc)} aria-label={`重新处理 ${doc.filename}`}>重新处理</Button> : null },
  ]

  return <Page side={<KnowledgeSide filter={scope} failedView={docView === 'failed'} />} title="知识库" actions={<Button onClick={() => setOpen(true)}><Plus size={14} />新建知识库</Button>}>
    <div className="kb-filters">
      <label className="tm-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索知识库" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} placeholder="按名称或描述搜索" /></label>
      <Segmented label="范围" value={scope} onChange={value => setParam('scope', value === 'all' ? null : value)} items={[{ value: 'all', label: '全部' }, { value: 'platform', label: '平台', count: scopeCount('platform') }, { value: 'personal', label: '个人', count: scopeCount('personal') }]} />
      <SearchableSelect label="状态" options={STATUS_FILTERS.filter(item => item.value !== 'pending' || admin)} value={status} onChange={value => { setStatus(value); setPage(1) }} width={180} />
      <span className="kb-summary">{libraries ? `${libraries.length} 个知识库，${formatNumber(libraries.reduce((sum, kb) => sum + kb.document_count, 0))} 份文档` : '正在读取知识库'}{loaded && libraries && `，${processing.length} 份处理中，${failed.length} 份失败`}</span>
    </div>

    {query.isError ? <ErrorState error={query.error} retry={() => { void query.refetch() }} /> : query.isPending ? <Loading /> : <div className="tm-panel">
      <DataTable label="知识库" rows={shown} rowKey={row => row.kb.id} columns={columns} onRowClick={row => navigate(`/knowledge/${row.kb.id}`)} minWidth={980}
        empty={search || status !== 'all' || scope !== 'all' ? '没有匹配的知识库' : <Empty title="还没有知识库" action={<Button onClick={() => setOpen(true)}><Plus size={14} />新建知识库</Button>} />} />
      <Pager total={visible.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} unit="个" />
    </div>}

    <section ref={problems} id="problem-documents" className="tm-panel" aria-label="处理中和失败的文档">
      <div className="kb-section-title"><h2>处理中和失败的文档</h2><span className="tm-faint tm-num">{problemDocs.length}</span>
        <Segmented label="文档状态" size="sm" value={docView} onChange={value => { setParam('docs', value === 'all' ? null : value); setDocPage(1) }}
          items={[{ value: 'all', label: '全部', count: processing.length + failed.length }, { value: 'processing', label: '处理中', count: processing.length }, { value: 'failed', label: '失败', count: failed.length }]} /></div>
      <DataTable label="处理中和失败的文档" rows={shownProblems} rowKey={doc => doc.id} columns={problemColumns} minWidth={860}
        empty={loaded ? '没有处理中或失败的文档' : '正在读取文档'} />
      {problemDocs.length > docPageSize && <Pager total={problemDocs.length} page={docPage} pageSize={docPageSize} onPageChange={setDocPage} onPageSizeChange={setDocPageSize} unit="份" />}
    </section>

    <Modal open={open} onOpenChange={value => { if (!create.isPending) setOpen(value) }} title="新建知识库" description="分块参数应用于此知识库中上传的文档。">
      <form className="dialog-body space-y-4" onSubmit={handleCreate}>
        {admin && <Field label="范围"><Select label="范围" value={formScope} onChange={value => setFormScope(value as Scope)} options={[{ value: 'personal', label: '我的知识库（个人）' }, { value: 'platform', label: '平台知识库（全员）' }]} /></Field>}
        <Field label="知识库名称"><input className="tm-input" name="name" required maxLength={200} placeholder="例如：研究论文库" autoFocus /></Field>
        <Field label="描述（可选）"><textarea className="tm-input" name="description" rows={3} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="分块长度（字符）"><input className="tm-input" name="chunk_size" type="number" min={100} max={20000} defaultValue={2200} required /></Field>
          <Field label="重叠长度（字符）"><input className="tm-input" name="chunk_overlap" type="number" min={0} max={19999} defaultValue={400} required /></Field>
        </div>
        {create.error && <ErrorState error={create.error} />}
        <div className="dialog-actions"><Button variant="secondary" onClick={() => setOpen(false)} disabled={create.isPending}>取消</Button><Button type="submit" busy={create.isPending}>创建知识库</Button></div>
      </form>
    </Modal>
  </Page>
}

// ───────────────────────────── 知识库详情 ─────────────────────────────

type DocFilter = 'all' | 'ready' | 'processing' | 'failed' | 'pending'
const docCategory = (doc: Document): DocFilter => doc.review_status === 'pending' || doc.status === 'pending_review' ? 'pending' : doc.status === 'ready' ? 'ready' : isFailed(doc) ? 'failed' : isProcessing(doc) ? 'processing' : 'all'
const isReplacing = (doc: Document) => !!doc.replaces_document_id && isProcessing(doc)

/** Deleting is allowed for managers on settled documents and for uploaders withdrawing their own unapproved submission. */
function useDocumentRights(manage: boolean) {
  const me = useAuth().user
  return {
    removable: (doc: Document) => (manage && ['ready', 'rejected', 'pending_review'].includes(doc.status)) || (doc.review_status !== 'approved' && doc.uploaded_by === me?.id),
    confirmDelete: (doc: Document, run: (id: string) => void) => { if (window.confirm(doc.review_status === 'pending' ? `撤回「${doc.filename}」的上传申请？` : `删除「${doc.filename}」？向量、分块和原文件将被永久移除。`)) run(doc.id) },
  }
}

export function KnowledgeDetail() {
  const { id = '' } = useParams()
  useEffect(() => { if (id) rememberKnowledgeBase(id) }, [id])
  const navigate = useNavigate()
  const kb = useApi<LibraryInfo>(`/knowledge-bases/${id}`, { poll: 5000 })
  const docs = useApi<Document[]>(documentsPath(id), { poll: 3000 })
  const [params, setParams] = useSearchParams()
  const tab = ['documents', 'retrieval', 'index', 'access'].includes(params.get('tab') ?? '') ? params.get('tab') as string : 'documents'
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [inputKey, setInputKey] = useState(0)
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState<DocFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const replaceInput = useRef<HTMLInputElement>(null)
  const replaceTarget = useRef<string | null>(null)
  const me = useAuth().user
  const names = useAccountNames()
  const manage = kb.data?.can_manage ?? false
  const needsReview = kb.data?.scope === 'platform' && me?.role !== 'admin'
  const { removable, confirmDelete } = useDocumentRights(manage)
  const refresh = [documentsPath(id), `/knowledge-bases/${id}`, '/knowledge-bases']

  const upload = useAction((chosen: File[]) => { const body = new FormData(); chosen.forEach(file => body.append('files', file)); return post<Document[]>(`/knowledge-bases/${id}/documents`, body) }, { invalidate: refresh, success: needsReview ? '已提交，管理员审批通过后开始解析' : '上传成功，文档已进入处理队列', onSuccess: () => { setFiles([]); setInputKey(key => key + 1); setUploadOpen(false) } })
  const retry = useAction((docId: string) => post<Document>(`/documents/${docId}/retry`), { invalidate: [documentsPath(id)], success: '已重新加入处理队列' })
  const replace = useAction(({ docId, file }: { docId: string; file: File }) => { const body = new FormData(); body.append('file', file); return api<Document>(`/documents/${docId}/content`, { method: 'PUT', body }) }, { invalidate: refresh, success: '新版本已上传，就绪前旧版本仍可检索' })
  const resetRetrieval = useAction(() => put<KnowledgeBase>(`/knowledge-bases/${id}/retrieval-config`, null), { invalidate: [`/knowledge-bases/${id}`], success: '已恢复默认检索配置' })
  const destroy = useAction((docId: string) => remove<unknown>(`/documents/${docId}`), { invalidate: refresh, success: '文档已删除' })
  const bulk = useAction(async ({ kind, items }: { kind: 'retry' | 'delete'; items: Document[] }) => {
    const results = await Promise.allSettled(items.map(doc => kind === 'retry' ? post<Document>(`/documents/${doc.id}/retry`) : remove<unknown>(`/documents/${doc.id}`)))
    const rejected = results.filter(result => result.status === 'rejected').length
    if (rejected) throw new Error(`${rejected} 份文档${kind === 'retry' ? '重新处理' : '删除'}失败`)
    return kind
  }, { invalidate: refresh, onSuccess: kind => { setSelected(new Set()); toast.success(kind === 'retry' ? '已重新加入处理队列' : '文档已删除') } })

  function chooseFiles(chosen: File[]): void { if (chosen.some(file => !FILE_PATTERN.test(file.name))) { toast.error('仅支持 PDF、Markdown 和 TXT 文件，请重新选择'); return }; setFiles(chosen) }
  function pickReplacement(docId: string): void { replaceTarget.current = docId; replaceInput.current?.click() }
  function replacementChosen(file: File | undefined): void {
    const docId = replaceTarget.current
    if (replaceInput.current) replaceInput.current.value = ''
    if (!file || !docId) return
    if (!FILE_PATTERN.test(file.name)) { toast.error('仅支持 PDF、Markdown 和 TXT 文件，请重新选择'); return }
    replace.mutate({ docId, file })
  }
  function setTab(value: string): void { const next = new URLSearchParams(params); if (value === 'documents') next.delete('tab'); else next.set('tab', value); setParams(next, { replace: true }) }

  const all = docs.data ?? []
  const count = (value: DocFilter) => value === 'all' ? all.length : all.filter(doc => docCategory(doc) === value).length
  const needle = filter.trim().toLowerCase()
  const visible = all.filter(doc => doc.filename.toLowerCase().includes(needle) && (category === 'all' || docCategory(doc) === category))
  const shown = visible.slice((page - 1) * pageSize, page * pageSize)
  const chosenDocs = all.filter(doc => selected.has(doc.id))
  const hasUploaders = all.some(doc => names(doc.uploaded_by))
  const data = kb.data
  const canUpload = !!data && (data.can_manage || data.scope === 'platform')
  const merged = { ...DEFAULT_RETRIEVAL, ...(data?.retrieval_config ?? {}) }
  const customRetrieval = !!data?.retrieval_config?.routes

  const columns: Column<Document>[] = [
    { key: 'file', header: '文件名', cell: doc => {
      const replacing = isReplacing(doc)
      const note = isFailed(doc) && doc.error ? { text: `${doc.error}${manage ? '，可重新处理' : ''}`, cls: 'kb-sub-err' }
        : doc.review_status === 'rejected' && doc.review_note ? { text: `驳回原因：${doc.review_note}`, cls: 'kb-sub-err' }
        : replacing ? { text: '新版本处理中，旧版本在新版本就绪前继续可检索', cls: 'kb-sub-warn' }
        : isProcessing(doc) ? { text: stageNote(doc).text, cls: 'kb-sub-run' } : null
      return <span className="kb-file"><FileTypeTag filename={doc.filename} /><span className="min-w-0"><Link className="kb-file-name" to={`/knowledge/${id}/documents/${doc.id}`}>{doc.filename}</Link>{note && <span className={`kb-sub ${note.cls}`}>{note.text}</span>}</span></span>
    } },
    { key: 'status', header: '状态', nowrap: true, cell: doc => isReplacing(doc) ? <Tag tone="warn">替换中</Tag> : <StatusTag value={doc.status} /> },
    { key: 'steps', header: '进度', cell: doc => { if (['pending_review', 'rejected'].includes(doc.status)) return <span className="tm-faint">—</span>; const { steps, current } = documentSteps(doc.status, doc.stage); return <StepBar steps={steps} label={`处理进度：${current}`} /> } },
    { key: 'pages', header: '页数', align: 'right', cell: doc => doc.page_count ? formatNumber(doc.page_count) : <span className="tm-faint">—</span> },
    { key: 'chunks', header: '分块', align: 'right', cell: doc => doc.chunk_count ? formatNumber(doc.chunk_count) : <span className="tm-faint">—</span> },
    ...(hasUploaders ? [{ key: 'uploader', header: '上传者', nowrap: true, cell: (doc: Document) => names(doc.uploaded_by) ?? '—' }] : []),
    { key: 'updated', header: '更新', nowrap: true, cell: doc => <span className="tm-muted">{formatWhen(doc.updated_at)}</span> },
    { key: 'actions', header: <span className="sr-only">操作</span>, align: 'right', nowrap: true, cell: doc => <span className="inline-flex items-center justify-end gap-1">
      {isFailed(doc) && manage && <Button variant="secondary" size="sm" busy={retry.isPending && retry.variables === doc.id} disabled={retry.isPending} onClick={() => retry.mutate(doc.id)} aria-label={`重新处理 ${doc.filename}`}>重新处理</Button>}
      {manage && doc.status === 'ready' && <Button variant="icon" aria-label={`上传新版本 ${doc.filename}`} title="上传新版本" disabled={replace.isPending} onClick={() => pickReplacement(doc.id)}><RefreshCw size={14} /></Button>}
      {removable(doc) && <Button variant="icon" aria-label={`删除 ${doc.filename}`} title={doc.review_status === 'pending' ? '撤回' : '删除'} disabled={destroy.isPending} onClick={() => confirmDelete(doc, destroy.mutate)}><Trash2 size={14} /></Button>}
    </span> },
  ]

  return <Page side={<KnowledgeListSide />} title={data?.name ?? '知识库'}
    meta={data && <><ScopeTag scope={data.scope} />{data.description && <span className="tm-muted">{data.description}</span>}</>}
    actions={data && <><Link className={buttonClass('secondary')} to={`/chat?kb=${id}`}>在问答中使用</Link>{canUpload && <Button onClick={() => setUploadOpen(true)}><Upload size={14} />上传文档</Button>}</>}>
    {kb.isError && <ErrorState error={kb.error} retry={() => { void kb.refetch() }} />}
    {needsReview && <Notice>这是平台知识库：你上传的文档需要管理员审批，通过后才会解析并供所有人检索。审批前仅你和管理员可见。</Notice>}
    {data && <FactStrip items={[
      { label: '文档', value: `${formatNumber(data.document_count)} 份，${formatNumber(data.ready_count)} 份就绪` },
      { label: '分块', value: formatNumber(data.chunk_count) },
      { label: 'Embedding', value: <><span className="tm-mono">{data.embedding_model || '未配置'}</span>{data.embedding_dimensions ? `，${data.embedding_dimensions} 维` : ''}</> },
      { label: '分块长度 / 重叠', value: `${data.chunk_size} / ${data.chunk_overlap} 字` },
      { label: '默认检索', value: retrievalLabel(data.retrieval_config) },
      { label: '索引版本', value: `v${data.version}` },
    ]} />}
    <Tabs value={tab} onChange={setTab} label="知识库视图" items={[{ value: 'documents', label: '文档', count: all.length }, { value: 'retrieval', label: '默认检索配置' }, { value: 'index', label: '分块与索引' }, { value: 'access', label: '访问与审批' }]} />

    {tab === 'documents' && <>
      <div className="kb-filters">
        <label className="tm-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索文档" value={filter} onChange={event => { setFilter(event.target.value); setPage(1) }} placeholder="搜索文件名" /></label>
        <Segmented label="文档状态" value={category} onChange={value => { setCategory(value); setPage(1) }}
          items={[{ value: 'all', label: '全部', count: count('all') }, { value: 'ready', label: '已就绪', count: count('ready') }, { value: 'processing', label: '处理中', count: count('processing') }, { value: 'failed', label: '失败', count: count('failed') }, { value: 'pending', label: '待审批', count: count('pending') }]} />
      </div>
      {selected.size > 0 && <SelectionBar count={selected.size} unit="份" onClear={() => setSelected(new Set())}>
        {manage && <Button variant="secondary" size="sm" disabled={bulk.isPending || !chosenDocs.some(isFailed)} onClick={() => bulk.mutate({ kind: 'retry', items: chosenDocs.filter(isFailed) })}>重新处理</Button>}
        <Button variant="secondary" size="sm" disabled={bulk.isPending || !chosenDocs.length || !chosenDocs.every(removable)} onClick={() => { if (window.confirm(`删除所选的 ${chosenDocs.length} 份文档？向量、分块和原文件将被永久移除。`)) bulk.mutate({ kind: 'delete', items: chosenDocs }) }}>删除</Button>
      </SelectionBar>}
      {docs.isError ? <ErrorState error={docs.error} retry={() => { void docs.refetch() }} /> : docs.isPending ? <Loading /> : <div className="tm-panel">
        <DataTable label="文档" rows={shown} rowKey={doc => doc.id} columns={columns} minWidth={900} onRowClick={doc => navigate(`/knowledge/${id}/documents/${doc.id}`)}
          selection={{ selected, onChange: setSelected, label: key => all.find(doc => doc.id === key)?.filename ?? key }}
          empty={filter || category !== 'all' ? '没有匹配的文档' : <Empty title="还没有文档" description={canUpload ? '上传 PDF、Markdown 或 TXT 后会自动解析并建立索引。' : undefined} />} />
        <Pager total={visible.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} unit="份" />
      </div>}
    </>}

    {tab === 'retrieval' && <section className="tm-panel" aria-label="默认检索配置">
      <div className="kb-section-title"><h2>默认检索配置</h2><Tag tone={customRetrieval ? 'platform' : 'neutral'}>{customRetrieval ? '已自定义' : '系统默认'}</Tag>
        <span className="flex-1" />
        {manage && customRetrieval && <Button variant="secondary" size="sm" busy={resetRetrieval.isPending} onClick={() => resetRetrieval.mutate(undefined)}>恢复默认</Button>}
        {me?.role === 'admin' && <Link className={buttonClass('secondary', 'sm')} to="/evaluation/tuning">去调优</Link>}</div>
      <dl className="kb-config-grid">
        {([
          ['召回路径', merged.routes.map(route => route === 'vector' ? '向量' : 'BM25').join(' + ')], ['每路召回数', merged.route_k],
          ['权重（向量 : BM25）', `${merged.vector_weight} : ${merged.bm25_weight}`], ['RRF k', merged.rrf_k], ['融合保留数', merged.fusion_k], ['重排', merged.rerank ? '开启' : '关闭'],
          ['查询改写', merged.query_rewrite === 'multi_query' ? `多查询，${merged.rewrite_count} 条` : '关闭'], ['最低分', merged.min_score ?? '不限'], ['去重阈值', merged.dedupe_threshold],
          ['MMR', merged.mmr_lambda ?? '关闭'], ['邻近窗口', merged.neighbor_window], ['返回条数', merged.top_k],
        ] as [string, string | number][]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </section>}

    {tab === 'index' && data && <section className="tm-panel" aria-label="分块与索引">
      <div className="kb-section-title"><h2>分块与索引</h2></div>
      <dl className="kb-config-grid">
        <div><dt>分块长度</dt><dd>{data.chunk_size} 字</dd></div><div><dt>重叠长度</dt><dd>{data.chunk_overlap} 字</dd></div>
        <div><dt>Embedding 模型</dt><dd className="tm-mono">{data.embedding_model || '未配置'}</dd></div><div><dt>向量维度</dt><dd>{data.embedding_dimensions ? `${data.embedding_dimensions} 维` : '—'}</dd></div>
        <div><dt>索引版本</dt><dd>v{data.version}</dd></div><div><dt>分块总数</dt><dd>{formatNumber(data.chunk_count)}</dd></div>
        <div><dt>文档</dt><dd>{formatNumber(data.document_count)} 份，{formatNumber(data.ready_count)} 份就绪</dd></div><div><dt>创建时间</dt><dd>{formatDateTime(data.created_at)}</dd></div>
      </dl>
    </section>}

    {tab === 'access' && data && <section className="tm-panel" aria-label="访问与审批">
      <div className="kb-section-title"><h2>访问与审批</h2></div>
      <dl className="kb-config-grid">
        <div><dt>范围</dt><dd><ScopeTag scope={data.scope} /></dd></div>
        <div><dt>可见范围</dt><dd>{data.scope === 'platform' ? '所有员工' : '仅所有者'}</dd></div>
        <div><dt>你的权限</dt><dd>{data.can_manage ? '管理（上传、删除、重新处理、修改检索配置）' : data.scope === 'platform' ? '使用与提交上传' : '使用'}</dd></div>
        <div><dt>上传审批</dt><dd>{data.scope === 'platform' ? (me?.role === 'admin' ? '员工上传需要你审批' : '上传需要管理员审批') : '无需审批'}</dd></div>
        {data.scope === 'platform' && me?.role === 'admin' && <div><dt>待审批文档</dt><dd>{data.pending_count ? <Link to="/admin/reviews">{data.pending_count} 份，去审批</Link> : '0 份'}</dd></div>}
        <div><dt>我提交且未通过的文档</dt><dd>{all.filter(doc => doc.uploaded_by === me?.id && doc.review_status !== 'approved').length} 份</dd></div>
      </dl>
    </section>}

    <input ref={replaceInput} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept={ACCEPT} onChange={event => replacementChosen(event.target.files?.[0])} />
    <Modal open={uploadOpen} onOpenChange={value => { if (!upload.isPending) setUploadOpen(value) }} title="上传文档" description="选择 PDF、Markdown 或 TXT 文件。">
      <div className="dialog-body space-y-4">
        <div className="kb-dropzone" data-dragging={dragging || undefined}
          onDragOver={event => { event.preventDefault(); if (!upload.isPending) setDragging(true) }} onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); if (!upload.isPending) chooseFiles(Array.from(event.dataTransfer.files)) }}>
          <Upload size={20} strokeWidth={1.6} aria-hidden="true" />
          <span>拖放文件到这里，或</span>
          <label className={`tm-btn cursor-pointer ${upload.isPending ? 'opacity-50 pointer-events-none' : ''}`}>选择文件
            <input key={inputKey} className="sr-only" type="file" accept={ACCEPT} multiple disabled={upload.isPending} onChange={event => chooseFiles(Array.from(event.target.files ?? []))} aria-label="选择文档文件" /></label>
        </div>
        {files.length > 0 && <ul className="kb-dialog-files">{files.map((file, index) => <li key={`${file.name}-${index}`} className="kb-file"><FileTypeTag filename={file.name} /><span className="kb-file-name">{file.name}</span><span className="tm-faint tm-num">{(file.size / 1024 / 1024).toFixed(1)} MB</span></li>)}</ul>}
        {upload.error && <ErrorState error={upload.error} />}
        <div className="dialog-actions"><Button variant="secondary" disabled={upload.isPending} onClick={() => setUploadOpen(false)}>取消</Button><Button busy={upload.isPending} disabled={!files.length} onClick={() => upload.mutate(files)}>{files.length ? `上传 ${files.length} 份文件` : '上传'}</Button></div>
      </div>
    </Modal>
  </Page>
}

// ───────────────────────────── 文档详情 ─────────────────────────────

type ChunkItem = Citation & { chunk_index?: number }
const CHUNKS_PER_PAGE = 20
const chunkNumber = (chunk: ChunkItem, index: number) => (chunk.chunk_index ?? index) + 1
const REVIEW_LABELS: Record<string, string> = { approved: '已通过', pending: '待审批', rejected: '已驳回' }

export function DocumentDetail() {
  const { id = '', documentId = '' } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const doc = useApi<Document>(`/documents/${documentId}`, { poll: 3000 })
  const kb = useApi<LibraryInfo>(`/knowledge-bases/${id}`)
  const parsed = useApi<{ markdown: string; chunks: ChunkItem[] }>(`/documents/${documentId}/parsed`, { poll: doc.data && ['ready', 'failed'].includes(doc.data.status) ? false : 5000 })
  const names = useAccountNames()
  const manage = kb.data?.can_manage ?? false
  const { removable, confirmDelete } = useDocumentRights(manage)
  const initialPage = Number.parseInt(params.get('page') ?? '', 10)
  const [tab, setTab] = useState('chunks')
  const [page, setPage] = useState<number | null>(Number.isFinite(initialPage) && initialPage > 0 ? initialPage : null)
  const [shownPage, setShownPage] = useState(page ?? 1)
  const [selectedId, setSelectedId] = useState<string | null>(params.get('chunk'))
  const [follow, setFollow] = useState(true)
  const [search, setSearch] = useState('')
  const [listPage, setListPage] = useState(1)
  const replaceInput = useRef<HTMLInputElement>(null)
  const chunks = parsed.data?.chunks ?? []
  const needle = search.trim().toLowerCase()
  const filtered = chunks.filter(chunk => chunk.text.toLowerCase().includes(needle))
  const selected = chunks.find(chunk => chunk.id === selectedId)
  const isPdf = !!doc.data && /\.pdf$/i.test(doc.data.filename)

  const destroy = useAction((docId: string) => remove<unknown>(`/documents/${docId}`), { invalidate: [documentsPath(id), `/knowledge-bases/${id}`, '/knowledge-bases'], success: '文档已删除', onSuccess: () => navigate(`/knowledge/${id}`) })
  const replace = useAction((file: File) => { const body = new FormData(); body.append('file', file); return api<Document>(`/documents/${documentId}/content`, { method: 'PUT', body }) }, { invalidate: [documentsPath(id), `/knowledge-bases/${id}`], success: '新版本已上传，就绪前旧版本仍可检索', onSuccess: () => navigate(`/knowledge/${id}`) })

  // Arriving with ?chunk= (and no page): open the page that holds the chunk.
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current || !selected) return
    deepLinked.current = true
    if (page === null && selected.page) setPage(selected.page)
  }, [selected, page])
  // Show the list page that contains the selected chunk, and scroll it into view.
  useEffect(() => {
    if (!selectedId) return
    const index = filtered.findIndex(chunk => chunk.id === selectedId)
    if (index >= 0) setListPage(Math.floor(index / CHUNKS_PER_PAGE) + 1)
    const frame = requestAnimationFrame(() => document.getElementById(`chunk-${selectedId}`)?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
    // Only a new selection moves the list; paging by hand must not snap back.
  }, [selectedId, parsed.dataUpdatedAt])

  function selectChunk(chunk: ChunkItem): void {
    setSelectedId(chunk.id)
    if (chunk.page) setPage(chunk.page)
  }
  function pageChanged(next: number): void {
    setPage(next)
    if (next === shownPage) return
    setShownPage(next)
    if (follow && !(selected && selected.page === next)) {
      const first = chunks.find(chunk => chunk.page === next)
      if (first) setSelectedId(first.id)
    }
  }
  function replacementChosen(file: File | undefined): void {
    if (replaceInput.current) replaceInput.current.value = ''
    if (!file) return
    if (!FILE_PATTERN.test(file.name)) { toast.error('仅支持 PDF、Markdown 和 TXT 文件，请重新选择'); return }
    replace.mutate(file)
  }

  const data = doc.data
  const onThisPage = chunks.filter(chunk => chunk.page === shownPage).length
  const listed = filtered.slice((listPage - 1) * CHUNKS_PER_PAGE, listPage * CHUNKS_PER_PAGE)
  const highlight = isPdf && selected && selected.page === shownPage ? { label: `分块 #${chunkNumber(selected, chunks.indexOf(selected))}` } : null
  const uploader = names(data?.uploaded_by)
  const meta = data && <>
    <StatusTag value={data.status} />
    <span className="tm-muted tm-num">{[data.page_count && isPdf ? `${data.page_count} 页` : null, `${formatNumber(data.chunk_count)} 个分块`, sourceLabel(data.source_type), `${uploader ? `${uploader} ` : ''}${formatWhen(data.created_at)} 上传`].filter(Boolean).join('，')}</span>
  </>
  const actions = data && <>
    {manage && data.status === 'ready' && <Button variant="secondary" busy={replace.isPending} onClick={() => replaceInput.current?.click()}>上传新版本</Button>}
    <a className={buttonClass('secondary')} href={`/api/documents/${encodeURIComponent(documentId)}/file`} download={data.filename}>下载原文件</a>
    {removable(data) && <Button variant="danger" busy={destroy.isPending} onClick={() => confirmDelete(data, destroy.mutate)}>{data.review_status === 'pending' ? '撤回' : '删除'}</Button>}
  </>

  return <Page bare title={data?.filename ?? '文档'} crumbs={[{ to: `/knowledge/${id}`, label: kb.data?.name ?? '知识库' }]} meta={meta} actions={actions}>
    <input ref={replaceInput} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept={ACCEPT} onChange={event => replacementChosen(event.target.files?.[0])} />
    {doc.isError ? <div className="tm-body"><ErrorState error={doc.error} retry={() => { void doc.refetch() }} /></div> : doc.isPending ? <Loading /> : <div className="doc-split">
      <section className="doc-original document-original" aria-label="原文">
        {isPdf
          ? <PdfCanvas documentId={documentId} filename={data!.filename} page={page} highlight={highlight} onPageChange={pageChanged} showOpenLink={false}
            toolbarEnd={chunks.length > 0 && <span className="tm-faint tm-num text-xs whitespace-nowrap">本页 {onThisPage} 个分块</span>} />
          : <div className="doc-text"><PdfViewer documentId={documentId} filename={data!.filename} /></div>}
      </section>

      <section className="doc-side document-parsed" aria-label="解析结果">
        <Tabs value={tab} onChange={setTab} label="解析结果" items={[{ value: 'chunks', label: '分块', count: parsed.data ? chunks.length : undefined }, { value: 'markdown', label: '解析正文' }, { value: 'log', label: '处理记录' }]} />
        {tab === 'chunks' && <>
          <div className="doc-tools">
            <label className="tm-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索分块文本" value={search} onChange={event => { setSearch(event.target.value); setListPage(1) }} placeholder="搜索分块文本" /></label>
            {isPdf && <label className="doc-follow"><input type="checkbox" className="tm-check" checked={follow} onChange={event => setFollow(event.target.checked)} />跟随当前页</label>}
          </div>
          <div className="doc-scroll">
            {parsed.isPending ? <Loading /> : parsed.isError ? <ErrorState error={parsed.error} retry={() => { void parsed.refetch() }} />
              : !listed.length ? <Empty title={search ? '没有匹配的分块' : data!.status === 'failed' ? '文档处理失败，没有分块' : '分块尚未生成'} description={!search && data!.status === 'failed' ? data!.error ?? undefined : undefined} />
              : listed.map(chunk => {
                const on = chunk.id === selectedId
                const index = chunks.indexOf(chunk)
                return <button key={chunk.id} id={`chunk-${chunk.id}`} type="button" className={`chunk-card ${on ? 'tm-ev-card' : ''}`} aria-pressed={on} onClick={() => selectChunk(chunk)}>
                  <span className="chunk-head"><strong>#{chunkNumber(chunk, index)}</strong><span className="tm-muted">{chunk.page ? `第 ${chunk.page} 页` : '无页码'}</span><span className="tm-faint tm-num">{formatNumber(chunk.text.length)} 字</span>
                    {on && highlight && <span className="chunk-on">在左侧高亮</span>}</span>
                  <span className="chunk-body">{chunk.text}</span>
                </button>
              })}
          </div>
          <div className="doc-pager"><Pager total={filtered.length} page={listPage} pageSize={CHUNKS_PER_PAGE} onPageChange={setListPage} unit="个" /></div>
        </>}

        {tab === 'markdown' && <div className="doc-scroll" style={{ padding: '16px 20px' }}>
          {parsed.isPending ? <Loading /> : parsed.isError ? <ErrorState error={parsed.error} retry={() => { void parsed.refetch() }} />
            : parsed.data.markdown ? <Markdown text={parsed.data.markdown} /> : <Empty title="解析正文尚未生成" />}
        </div>}

        {tab === 'log' && data && <div className="doc-scroll" style={{ padding: '16px 20px' }}>
          {(() => { const { steps, current } = documentSteps(data.status, data.stage); return <div className="mb-4 flex items-center gap-3"><StepBar steps={steps} label={`处理进度：${current}`} /><span className={isFailed(data) ? 'kb-sub-err' : 'tm-muted'}>{current}</span></div> })()}
          <FactList items={[
            { label: '状态', value: <StatusTag value={data.status} /> },
            { label: '解析方式', value: sourceLabel(data.source_type) },
            { label: '上传者', value: uploader ?? '—' },
            { label: '上传时间', value: formatDateTime(data.created_at) },
            { label: '最近更新', value: formatDateTime(data.updated_at) },
            { label: '审批状态', value: REVIEW_LABELS[data.review_status ?? 'approved'] ?? data.review_status },
            ...(data.reviewed_at ? [{ label: '审批时间', value: formatDateTime(data.reviewed_at) }] : []),
            ...(data.review_note ? [{ label: '审批备注', value: data.review_note }] : []),
            ...(data.replaces_document_id ? [{ label: '替换的旧版本', value: <Link to={`/knowledge/${id}/documents/${data.replaces_document_id}`}>查看旧版本</Link> }] : []),
          ]} />
          {data.error && <p className="mt-4 kb-sub-err break-words" role="alert">{data.error}</p>}
        </div>}
      </section>
    </div>}
  </Page>
}

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Download, Plus, Search, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatDate, post, useAction, useApi } from '../lib/api'
import type { Dataset, Evidence, Question, QuestionFields } from '../lib/types'
import { Button, DataTable, Drawer, Empty, ErrorState, FactStrip, JsonDetails, Loading, Pager, Segmented, StatusTag, Tag, type Column } from '../components/ui'
import { Page } from '../components/shell/Shell'
import { EvaluationSide } from '../components/shell/ModuleNav'
import { FormField, MenuPopover } from './evalShared'

function NewDatasetDrawer({ pending, error, onSubmit, onClose }: { pending: boolean; error: Error | null; onSubmit: (body: { name: string; description: string }) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  return <Drawer open onOpenChange={open => { if (!open && !pending) onClose() }} title="新建题集" width={480}
    footer={<div className="ev-actions"><Button variant="secondary" disabled={pending} onClick={onClose}>取消</Button><Button type="submit" form="dataset-form" busy={pending} disabled={!name.trim()}>创建题集</Button></div>}>
    <form id="dataset-form" className="ev-form ev-form-flush" onSubmit={event => { event.preventDefault(); if (!pending) onSubmit({ name: name.trim(), description: description.trim() }) }}>
      <FormField label="题集名称"><input className="tm-input" required maxLength={200} placeholder="例如：论文问答基准 v1" value={name} onChange={event => setName(event.target.value)} autoFocus /></FormField>
      <FormField label="描述（可选）"><textarea className="tm-input" rows={3} value={description} onChange={event => setDescription(event.target.value)} /></FormField>
      {error && <ErrorState error={error} />}
    </form>
  </Drawer>
}

export function DatasetsPage() {
  const query = useApi<Dataset[]>('/datasets')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const navigate = useNavigate()
  const create = useAction((body: { name: string; description: string }) => post<Dataset>('/datasets', body), { invalidate: ['/datasets'], success: '题集已创建', onSuccess: dataset => { setOpen(false); navigate(`/evaluation/datasets/${dataset.id}`) } })
  const example = useAction(() => post<Dataset>('/datasets/import-example'), { invalidate: ['/datasets'], success: '示例题集已就绪，请另行上传对应 PDF', onSuccess: dataset => navigate(`/evaluation/datasets/${dataset.id}`) })
  const all = query.data ?? []
  const visible = all.filter(dataset => `${dataset.name} ${dataset.description}`.toLowerCase().includes(search.trim().toLowerCase()))
  const current = Math.min(page, Math.max(1, Math.ceil(visible.length / pageSize)))
  const columns: Column<Dataset>[] = [
    { key: 'name', header: '题集', cell: dataset => <><Link to={`/evaluation/datasets/${dataset.id}`} className="tm-linkbtn">{dataset.name}</Link>{dataset.description && <span className="tm-table-sub ev-clamp">{dataset.description}</span>}</> },
    { key: 'count', header: '题数', align: 'right', nowrap: true, width: 90, cell: dataset => <span className="tm-num">{dataset.question_count}</span> },
    { key: 'created', header: '创建时间', nowrap: true, width: 140, cell: dataset => <span className="tm-faint tm-num">{formatDate(dataset.created_at)}</span> },
  ]
  const actions = <>
    <Button variant="secondary" busy={example.isPending} onClick={() => example.mutate(undefined)}><Download size={14} />导入 100 题示例</Button>
    <Button onClick={() => setOpen(true)}><Plus size={15} />新建题集</Button>
  </>
  return <Page side={<EvaluationSide section="datasets" />} title="评测题集" actions={actions}>
    {query.isPending ? <Loading /> : query.isError ? <ErrorState error={query.error} retry={() => { void query.refetch() }} /> : !all.length
      ? <div className="tm-panel"><Empty title="还没有题集" description="手动添加问题，或导入 JSONL、CSV 文件。" action={<Button onClick={() => setOpen(true)}><Plus size={15} />新建题集</Button>} /></div>
      : <>
        <div className="ev-filter">
          <label className="tm-search ev-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索题集" placeholder="搜索题集" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
        </div>
        <div className="tm-panel">
          <DataTable label="评测题集" columns={columns} rows={visible.slice((current - 1) * pageSize, current * pageSize)} rowKey={dataset => dataset.id} minWidth={560}
            onRowClick={dataset => navigate(`/evaluation/datasets/${dataset.id}`)} empty="没有符合条件的题集" />
          <Pager total={visible.length} page={current} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} unit="个" />
        </div>
      </>}
    {open && <NewDatasetDrawer pending={create.isPending} error={create.error} onSubmit={create.mutate} onClose={() => setOpen(false)} />}
  </Page>
}

function parseEvidence(text: string): Evidence[] {
  const value: unknown = JSON.parse(text || '[]')
  if (!Array.isArray(value)) throw new Error('证据必须是 JSON 数组')
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('page' in entry) || !Number.isInteger(entry.page) || Number(entry.page) < 1 || !('quote' in entry) || typeof entry.quote !== 'string') throw new Error('每条证据都需要正整数 page 与文本 quote')
    if ('document_id' in entry && entry.document_id != null && typeof entry.document_id !== 'string') throw new Error('document_id 必须是字符串，不能是数字')
    if ('doc_id' in entry && entry.doc_id != null && typeof entry.doc_id !== 'string') throw new Error('doc_id 必须是字符串')
    return { page: Number(entry.page), quote: entry.quote, ...('document_id' in entry && typeof entry.document_id === 'string' ? { document_id: entry.document_id } : {}), ...('doc_id' in entry && typeof entry.doc_id === 'string' ? { doc_id: entry.doc_id } : {}) }
  })
}

/** Question editor in a drawer; mounted per question so its fields start from that question. */
function QuestionDrawer({ datasetId, question, position, onPrev, onNext, onClose }: {
  datasetId: string; question?: Question; position?: string; onPrev?: () => void; onNext?: () => void; onClose: () => void
}) {
  const [text, setText] = useState(question?.question ?? '')
  const [answer, setAnswer] = useState(question?.reference_answer ?? '')
  const [answerable, setAnswerable] = useState(question?.answerable ?? true)
  const [reviewed, setReviewed] = useState(question?.review_status === 'reviewed')
  const [evidence, setEvidence] = useState(JSON.stringify(question?.evidence ?? [], null, 2))
  const [validation, setValidation] = useState('')
  const save = useAction((body: QuestionFields) => question ? api<Question>(`/questions/${question.id}`, { method: 'PATCH', body: JSON.stringify(body) }) : post<Question>(`/datasets/${datasetId}/questions`, body), { invalidate: [`/datasets/${datasetId}/questions`, '/datasets'], success: '问题已保存', onSuccess: onClose })
  function handleSave(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault(); if (save.isPending) return
    try { const parsed = parseEvidence(evidence); setValidation(''); save.mutate({ question: text.trim(), reference_answer: answer.trim(), answerable, review_status: reviewed ? 'reviewed' : 'pending', evidence: parsed }) } catch (error) { setValidation(error instanceof Error ? error.message : '证据 JSON 格式不正确') }
  }
  return <Drawer open onOpenChange={open => { if (!open && !save.isPending) onClose() }} title={question ? '编辑问题' : '添加问题'} position={position} onPrev={onPrev} onNext={onNext} width={560}
    footer={<div className="ev-actions"><Button variant="secondary" disabled={save.isPending} onClick={onClose}>取消</Button><Button type="submit" form="question-form" busy={save.isPending}>保存问题</Button></div>}>
    <form id="question-form" className="ev-form ev-form-flush" onSubmit={handleSave}>
      <fieldset disabled={save.isPending} className="ev-fieldset ev-form-fields">
        <FormField label="问题"><textarea className="tm-input" rows={3} required value={text} onChange={event => setText(event.target.value)} placeholder="输入清晰、可验证的问题" autoFocus /></FormField>
        <FormField label="参考答案（可选）"><textarea className="tm-input" rows={4} value={answer} onChange={event => setAnswer(event.target.value)} /></FormField>
        <div className="ev-checks">
          <label className="ev-check"><input type="checkbox" className="tm-check" checked={answerable} onChange={event => setAnswerable(event.target.checked)} /><span>根据文档可回答</span></label>
          <label className="ev-check"><input type="checkbox" className="tm-check" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>已人工核对问题与证据</span></label>
        </div>
        <FormField label="证据（JSON 数组）" hint="每项包含 document_id 或 doc_id、page（从 1 开始）、quote；无证据填 []">
          <textarea className="tm-input tm-mono" rows={8} value={evidence} onChange={event => setEvidence(event.target.value)} spellCheck={false} />
        </FormField>
      </fieldset>
      {validation && <p role="alert" className="ev-fail">{validation}</p>}
      {save.error && <ErrorState error={save.error} />}
    </form>
  </Drawer>
}

type ReviewFilter = 'all' | 'pending' | 'reviewed'

export function DatasetDetail() {
  const { id = '' } = useParams()
  const datasets = useApi<Dataset[]>('/datasets')
  const dataset = datasets.data?.find(item => item.id === id)
  const questions = useApi<Question[]>(`/datasets/${id}/questions`)
  const examples = useApi<{ name: string; url: string }[]>('/examples')
  const [editor, setEditor] = useState<string | 'new' | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [search, setSearch] = useState('')
  const [review, setReview] = useState<ReviewFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const imported = useAction((input: File) => { const form = new FormData(); form.append('file', input); return post<unknown>(`/datasets/${id}/import`, form) }, { invalidate: [`/datasets/${id}/questions`, '/datasets'], success: '问题导入成功', onSuccess: () => { setImportOpen(false); setFile(null) } })
  const all = questions.data ?? []
  const counts: Record<ReviewFilter, number> = { all: all.length, pending: all.filter(item => item.review_status === 'pending').length, reviewed: all.filter(item => item.review_status === 'reviewed').length }
  const filtered = all.filter(item => item.question.toLowerCase().includes(search.trim().toLowerCase()) && (review === 'all' || item.review_status === review))
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)))
  const editing = editor && editor !== 'new' ? all.find(item => item.id === editor) : undefined
  const editIndex = editing ? filtered.findIndex(item => item.id === editing.id) : -1
  const columns: Column<Question>[] = [
    { key: 'n', header: '序号', align: 'right', width: 56, cell: (_question, index) => <span className="tm-faint tm-num">{(current - 1) * pageSize + index + 1}</span> },
    { key: 'question', header: '问题', cell: question => <><button type="button" className="tm-linkbtn ev-q" onClick={() => setEditor(question.id)}>{question.question}</button>{question.reference_answer && <span className="tm-table-sub ev-clamp">{question.reference_answer}</span>}</> },
    { key: 'labels', header: '标注', nowrap: true, cell: question => <><Tag tone={question.answerable ? 'neutral' : 'warn'}>{question.answerable ? '可回答' : '不可回答'}</Tag><span className="tm-table-sub tm-num">{question.evidence?.length ?? 0} 条证据</span></> },
    { key: 'review', header: '审核状态', nowrap: true, cell: question => <StatusTag value={question.review_status} label={question.review_status === 'reviewed' ? '已审核' : '待审核'} /> },
    { key: 'edit', header: <span className="sr-only">操作</span>, align: 'right', nowrap: true, cell: (question, index) => <button type="button" className="tm-textlink" aria-label={`编辑问题 ${(current - 1) * pageSize + index + 1}`} onClick={() => setEditor(question.id)}>编辑</button> },
  ]
  const actions = <>
    <Button variant="secondary" onClick={() => setImportOpen(true)}><Upload size={14} />导入文件</Button>
    <Button onClick={() => setEditor('new')}><Plus size={15} />添加问题</Button>
  </>
  return <Page side={<EvaluationSide section="datasets" />} title={dataset?.name ?? '题集'} crumbs={[{ to: '/evaluation/datasets', label: '评测题集' }]} actions={actions}
    meta={dataset?.description ? <span className="tm-muted ev-desc">{dataset.description}</span> : undefined}>
    {questions.isPending ? <Loading /> : questions.isError ? <ErrorState error={questions.error} retry={() => { void questions.refetch() }} /> : <>
      <FactStrip items={[
        { label: '题数', value: String(all.length) },
        { label: '已审核', value: `${counts.reviewed} / ${all.length}` },
        { label: '可回答', value: String(all.filter(item => item.answerable).length) },
        { label: '带证据', value: String(all.filter(item => item.evidence?.length).length) },
        { label: '创建', value: formatDate(dataset?.created_at) },
      ]} />
      <div className="ev-filter">
        <label className="tm-search ev-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索问题" placeholder="搜索问题" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
        <Segmented label="审核状态筛选" value={review} onChange={value => { setReview(value); setPage(1) }} items={[
          { value: 'all', label: '全部', count: counts.all }, { value: 'pending', label: '待审核', count: counts.pending }, { value: 'reviewed', label: '已审核', count: counts.reviewed },
        ]} />
        <span className="flex-1" />
        {!!examples.data?.length && <MenuPopover label="示例源文档" text="示例源文档">
          {examples.data.map(example => <a key={example.name} className="ev-menu-item" href={`/api/examples/${encodeURIComponent(example.name)}`} target="_blank" rel="noopener noreferrer"><Download size={13} aria-hidden="true" />{example.name}</a>)}
        </MenuPopover>}
      </div>
      <div className="tm-panel">
        <DataTable label="题集问题" columns={columns} rows={filtered.slice((current - 1) * pageSize, current * pageSize)} rowKey={question => question.id} minWidth={640} selectedKey={editor}
          onRowClick={question => setEditor(question.id)} empty={all.length ? '没有符合条件的问题' : <Empty title="题集里还没有问题" description="添加一个问题，或导入文件。" action={<Button variant="secondary" onClick={() => setEditor('new')}><Plus size={14} />添加问题</Button>} />} />
        <Pager total={filtered.length} page={current} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} unit="题" />
      </div>
    </>}
    {(editor === 'new' || editing) && <QuestionDrawer key={editing?.id ?? 'new'} datasetId={id} question={editing} onClose={() => setEditor(null)}
      position={editIndex >= 0 ? `${editIndex + 1} / ${filtered.length}` : undefined}
      onPrev={editIndex > 0 ? () => setEditor(filtered[editIndex - 1].id) : undefined}
      onNext={editIndex >= 0 && editIndex < filtered.length - 1 ? () => setEditor(filtered[editIndex + 1].id) : undefined} />}
    {importOpen && <Drawer open onOpenChange={open => { if (!open && !imported.isPending) setImportOpen(false) }} title="导入问题" width={480}
      footer={<div className="ev-actions"><Button variant="secondary" onClick={() => setImportOpen(false)} disabled={imported.isPending}>取消</Button><Button type="submit" form="import-form" busy={imported.isPending} disabled={!file}>验证并导入</Button></div>}>
      <form id="import-form" className="ev-form ev-form-flush" onSubmit={event => { event.preventDefault(); if (file) imported.mutate(file) }}>
        <FormField label="问题文件" hint="UTF-8 编码的 JSONL 或 CSV；CSV 列为 question、reference_answer、answerable，可选 evidence（JSON 数组）">
          <input type="file" accept=".jsonl,.csv" disabled={imported.isPending} required onChange={event => { const selected = event.target.files?.[0]; if (selected && !/\.(jsonl|csv)$/i.test(selected.name)) { toast.error('请选择 .jsonl 或 .csv 文件'); return }; setFile(selected ?? null) }} />
        </FormField>
        {imported.error && <ErrorState error={imported.error} />}
        {imported.data !== undefined && <JsonDetails value={imported.data} label="上次导入结果" />}
      </form>
    </Drawer>}
  </Page>
}

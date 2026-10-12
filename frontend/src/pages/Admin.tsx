import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { errorText, patch, post, useAction, useApi } from '../lib/api'
import { useAuth } from '../lib/auth'
import type { PendingDocument, Role, UserAccount } from '../lib/types'
import { Button, DataTable, Drawer, Empty, ErrorState, FactList, Loading, Modal, Pager, ScopeTag, SearchableSelect, Segmented, StatusTag, Tag, buttonClass, type Column } from '../components/ui'
import { FormField } from '../components/ConfigurationControls'
import { Page } from '../components/shell/Shell'
import { Markdown } from '../components/sources'
import { PdfCanvas } from '../components/PdfCanvas'
import { TIME_RANGE_OPTIONS, formatStamp, personName, roleLabel, useRangeStart, useUserChoices, type PersonRef, type TimeRange } from './adminShared'

const PAGE_SIZES = [20, 50, 100]
const SOURCE_LABEL: Record<string, string> = { markdown: 'Markdown', text: '文本', pdf: 'PDF' }
const formatLabel = (doc: PendingDocument): string => SOURCE_LABEL[doc.source_type ?? ''] ?? (/\.pdf$/i.test(doc.filename) ? 'PDF' : /\.(md|markdown)$/i.test(doc.filename) ? 'Markdown' : '文本')
const sizeLabel = (doc: PendingDocument): string => `${formatLabel(doc)}${doc.page_count ? `，${doc.page_count} 页` : ''}`

// ------------------------------------------------------------------ accounts

function TemporaryPassword({ account, onClose }: { account: UserAccount | null; onClose: () => void }) {
  return <Modal open={account !== null} onOpenChange={value => { if (!value) onClose() }} title="临时密码" description={`账号 ${account?.username ?? ''} 首次登录后必须修改密码。`}>
    <div className="dialog-body space-y-4">
      <p className="tm-note m-0">临时密码只显示这一次，请通过安全渠道交给员工。</p>
      <code className="adm-secret" data-testid="temporary-password">{account?.temporary_password}</code>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(account?.temporary_password ?? '').then(() => toast.success('已复制'), () => toast.error('复制失败，请手动选择文本')) }}><Copy size={14} />复制</Button>
        <Button onClick={onClose}>完成</Button>
      </div>
    </div>
  </Modal>
}

export function UsersPage() {
  const { user: me } = useAuth()
  const users = useApi<UserAccount[]>('/admin/users')
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<Role>('employee')
  const [issued, setIssued] = useState<UserAccount | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const create = useAction((body: { username: string; display_name: string; role: Role }) => post<UserAccount>('/admin/users', body), { invalidate: ['/admin/users'], onSuccess: account => { setOpen(false); setIssued(account) } })
  const update = useAction(({ id, ...body }: { id: string; role?: Role; status?: 'active' | 'disabled' }) => patch<UserAccount>(`/admin/users/${id}`, body), { invalidate: ['/admin/users'], success: '账号已更新' })
  const reset = useAction((id: string) => post<UserAccount>(`/admin/users/${id}/reset-password`), { invalidate: ['/admin/users'], onSuccess: account => setIssued(account) })
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    create.mutate({ username: String(form.get('username')).trim(), display_name: String(form.get('display_name')).trim(), role })
  }
  const rows = users.data ?? []
  const shown = rows.slice((page - 1) * pageSize, page * pageSize)

  const columns: Column<UserAccount>[] = [
    { key: 'account', header: '账号', cell: account => <>
      <span className="font-medium">{account.display_name || account.username}</span>
      <span className="ml-2 tm-faint text-xs">{account.username}{account.id === me?.id ? '（我）' : ''}</span>
      {account.must_change_password && <span className="tm-table-sub" style={{ color: 'var(--warning)' }}>等待首次修改密码</span>}
    </> },
    { key: 'role', header: '角色', cell: account => account.role === 'admin' ? <Tag tone="ink">管理员</Tag> : <Tag>员工</Tag>, nowrap: true },
    { key: 'status', header: '状态', cell: account => <StatusTag value={account.status} />, nowrap: true },
    { key: 'login', header: '最近登录', cell: account => <span className="tm-muted tm-num">{formatStamp(account.last_login_at)}</span>, nowrap: true },
    { key: 'created', header: '创建', cell: account => <span className="tm-muted tm-num">{formatStamp(account.created_at)}</span>, nowrap: true },
    { key: 'actions', header: <span className="sr-only">操作</span>, nowrap: true, cell: account => account.id === me?.id ? null : <span className="inline-flex gap-4">
      <button type="button" className="tm-textlink" disabled={update.isPending} onClick={() => update.mutate({ id: account.id, role: account.role === 'admin' ? 'employee' : 'admin' })}>{account.role === 'admin' ? '设为员工' : '设为管理员'}</button>
      <button type="button" className="tm-textlink" disabled={update.isPending} onClick={() => { if (account.status === 'active' && !window.confirm(`停用 ${account.username}？该账号将立即退出登录，令牌失效。`)) return; update.mutate({ id: account.id, status: account.status === 'active' ? 'disabled' : 'active' }) }}>{account.status === 'active' ? '停用' : '启用'}</button>
      <button type="button" className="tm-textlink" disabled={reset.isPending} onClick={() => { if (window.confirm(`为 ${account.username} 生成新的临时密码？`)) reset.mutate(account.id) }}>重置密码</button>
    </span> },
  ]

  return <Page title="员工账号" actions={<Button onClick={() => setOpen(true)}><Plus size={14} />新建账号</Button>}>
    {users.isPending ? <Loading /> : users.isError ? <ErrorState error={users.error} retry={() => { void users.refetch() }} />
      : <section className="tm-panel adm-panel tm-listcard" aria-label="员工账号">
        <DataTable label="员工账号" columns={columns} rows={shown} rowKey={account => account.id} minWidth={720} rowProps={account => ({ dim: account.status === 'disabled' })} />
        <Pager total={rows.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} pageSizes={PAGE_SIZES} unit="个" />
      </section>}
    <Modal open={open} onOpenChange={value => { if (!create.isPending) setOpen(value) }} title="新建账号" description="系统生成临时密码，员工首次登录时设置自己的密码。">
      <form className="dialog-body adm-form" onSubmit={submit}>
        <FormField label="用户名" caption="3-64 位小写字母、数字或 _ . -"><input className="tm-input" name="username" required minLength={3} maxLength={64} autoFocus /></FormField>
        <FormField label="显示名"><input className="tm-input" name="display_name" maxLength={100} /></FormField>
        <div className="tm-field"><span className="tm-field-label">角色</span><Segmented label="角色" value={role} onChange={setRole} items={[{ value: 'employee', label: '员工' }, { value: 'admin', label: '管理员' }]} /></div>
        {create.error && <ErrorState error={create.error} />}
        <div className="dialog-actions"><Button variant="secondary" onClick={() => setOpen(false)} disabled={create.isPending}>取消</Button><Button type="submit" busy={create.isPending}>创建账号</Button></div>
      </form>
    </Modal>
    <TemporaryPassword account={issued} onClose={() => setIssued(null)} />
  </Page>
}

// ------------------------------------------------------------------ approvals: shared pieces

interface ReviewedDocument extends PendingDocument { result: 'approved' | 'rejected'; reviewer: PersonRef }
interface ReviewHistory { total: number; items: ReviewedDocument[]; limit: number; offset: number; counts: { all: number; approved: number; rejected: number } }

const TypeTag = () => <Tag tone="run">文档</Tag>
function Destination({ doc }: { doc: PendingDocument }) {
  return <span className="inline-flex items-center gap-1.5">{doc.knowledge_base_name}<ScopeTag scope="platform" /></span>
}
function Applicant({ person, role }: { person: PersonRef; role?: Role }) {
  return <span>{personName(person)}{role && <span className="tm-faint text-xs ml-1.5">{roleLabel(role)}</span>}</span>
}

/** The uploaded file as the reviewer will see it: Markdown and text rendered, a PDF on its first page. */
function SourcePreview({ doc }: { doc: PendingDocument }) {
  const pdf = doc.source_type === 'pdf' || /\.pdf$/i.test(doc.filename)
  const markdown = doc.source_type === 'markdown' || /\.(md|markdown)$/i.test(doc.filename)
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (pdf) return
    const controller = new AbortController()
    setText(null); setFailed(false)
    fetch(`/api/documents/${encodeURIComponent(doc.id)}/file`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.text() })
      .then(setText)
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [doc.id, pdf])
  return <section aria-label="原文预览" className="adm-preview-block">
    <h3 className="adm-subtitle">原文预览</h3>
    {pdf ? <div className="adm-preview-pdf"><PdfCanvas documentId={doc.id} page={1} filename={doc.filename} showOpenLink={false} /></div>
      : <div className="adm-preview">{failed ? <p className="tm-muted m-0">原文加载失败，请稍后重试。</p> : text === null ? <p className="tm-faint m-0">正在加载原文…</p>
        : markdown ? <Markdown text={text} /> : <pre className="adm-plain">{text}</pre>}</div>}
  </section>
}

function useRefreshReviews() {
  const client = useQueryClient()
  return () => { void client.invalidateQueries({ predicate: query => String(query.queryKey[0]).startsWith('/admin/reviews') }) }
}

// ------------------------------------------------------------------ approvals: pending

export function ReviewsPage() {
  const reviews = useApi<{ documents: PendingDocument[] }>('/admin/reviews', { poll: 15000 })
  const { users } = useUserChoices()
  const refresh = useRefreshReviews()
  const [text, setText] = useState('')
  const [applicant, setApplicant] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const reasonBox = useRef<HTMLTextAreaElement>(null)

  const all = useMemo(() => reviews.data?.documents ?? [], [reviews.data])
  const roles = useMemo(() => new Map(users.map(user => [user.username, user.role])), [users])
  const applicants = useMemo(() => {
    const seen = new Map<string, string>()
    for (const doc of all) seen.set(doc.uploader.username, personName(doc.uploader))
    return [{ value: '', label: '全部' }, ...[...seen].map(([value, label]) => ({ value, label, hint: label === value ? undefined : value }))]
  }, [all])
  const visible = useMemo(() => {
    const needle = text.trim().toLowerCase()
    return all.filter(doc => (!needle || doc.filename.toLowerCase().includes(needle)) && (!applicant || doc.uploader.username === applicant))
  }, [all, text, applicant])
  const shown = visible.slice((page - 1) * pageSize, page * pageSize)
  const index = visible.findIndex(doc => doc.id === openId)
  const current = index >= 0 ? visible[index] : null

  useEffect(() => {
    if (!rejecting || !current) return
    const timer = window.setTimeout(() => reasonBox.current?.focus(), 40)
    return () => window.clearTimeout(timer)
  }, [rejecting, current])

  function open(id: string, intent = false): void { setOpenId(id); setReason(''); setRejecting(intent) }
  function close(): void { setOpenId(null); setRejecting(false) }
  function step(offset: number): void {
    if (!visible.length) return
    open(visible[(Math.max(index, 0) + offset + visible.length) % visible.length].id)
  }

  const decide = useAction(({ id, approve, note }: { id: string; approve: boolean; note: string }) => post(`/admin/reviews/documents/${id}`, { approve, note: approve ? '' : note }), {
    onSuccess: (_, { id, approve }) => {
      toast.success(approve ? '已通过' : '已驳回')
      refresh()
      setSelected(previous => { const next = new Set(previous); next.delete(id); return next })
      if (openId === id) {
        const at = visible.findIndex(doc => doc.id === id)
        const next = visible[at + 1] ?? visible[at - 1]
        if (next) open(next.id); else close()
      }
    },
  })
  const approveMany = useAction(async (ids: string[]) => {
    const results = await Promise.allSettled(ids.map(id => post(`/admin/reviews/documents/${id}`, { approve: true, note: '' })))
    const failed = results.filter(result => result.status === 'rejected')
    if (failed.length) throw new Error(`${failed.length} 份文档未能通过：${errorText((failed[0] as PromiseRejectedResult).reason)}`)
    return ids.length
  }, { onSuccess: count => { toast.success(`已通过 ${count} 份文档`); setSelected(new Set()) } })
  const busy = decide.isPending || approveMany.isPending

  const columns: Column<PendingDocument>[] = [
    { key: 'type', header: '类型', cell: TypeTag, nowrap: true },
    { key: 'name', header: '文档名', cell: doc => <button type="button" className="tm-linkbtn" onClick={() => open(doc.id)}>{doc.filename}</button> },
    { key: 'kb', header: '提交到', cell: doc => <Destination doc={doc} />, nowrap: true },
    { key: 'who', header: '申请人', cell: doc => <Applicant person={doc.uploader} role={roles.get(doc.uploader.username)} />, nowrap: true },
    { key: 'at', header: '申请时间', cell: doc => <span className="tm-muted tm-num">{formatStamp(doc.created_at)}</span>, nowrap: true },
    { key: 'size', header: '大小', cell: doc => <span className="tm-muted">{sizeLabel(doc)}</span>, nowrap: true },
    { key: 'status', header: '状态', cell: doc => <StatusTag value={doc.review_status ?? 'pending'} />, nowrap: true },
    { key: 'actions', header: <span className="sr-only">操作</span>, nowrap: true, cell: doc => <span className="inline-flex gap-1.5">
      <Button variant="secondary" size="sm" disabled={busy} aria-label={`通过 ${doc.filename}`} onClick={() => decide.mutate({ id: doc.id, approve: true, note: '' })}>通过</Button>
      <Button variant="danger" size="sm" disabled={busy} aria-label={`驳回 ${doc.filename}`} onClick={() => open(doc.id, true)}>驳回</Button>
    </span> },
  ]

  return <Page title="待审批">
    {reviews.isPending ? <Loading /> : reviews.isError ? <ErrorState error={reviews.error} retry={() => { void reviews.refetch() }} /> : <>
      <div className="adm-filters">
        <label className="tm-search adm-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索文档名" placeholder="搜索文件名" value={text} onChange={event => { setText(event.target.value); setPage(1) }} /></label>
        <SearchableSelect label="申请人" options={applicants} value={applicant} onChange={value => { setApplicant(value); setPage(1) }} />
        <span className="flex-1" />
        <Button variant="secondary" disabled={!selected.size || busy} busy={approveMany.isPending} onClick={() => approveMany.mutate([...selected])}>批量通过{selected.size ? ` ${selected.size}` : ''}</Button>
      </div>
      <section className="tm-panel adm-panel tm-listcard" aria-label="待审批文档">
        <DataTable label="待审批文档" columns={columns} rows={shown} rowKey={doc => doc.id} minWidth={980} selectedKey={openId} onRowClick={doc => open(doc.id)}
          selection={{ selected, onChange: setSelected, label: key => all.find(doc => doc.id === key)?.filename ?? key }}
          empty={all.length ? '没有符合条件的文档' : '没有待审批文档'} />
        <Pager total={visible.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} pageSizes={PAGE_SIZES} unit="项" />
      </section>
    </>}
    <Drawer open={!!current} onOpenChange={value => { if (!value) close() }} width={520} label={current?.filename}
      leading={<TypeTag />} title={current?.filename} position={current ? `${index + 1} / ${visible.length}` : undefined}
      onPrev={visible.length > 1 ? () => step(-1) : undefined} onNext={visible.length > 1 ? () => step(1) : undefined}
      footer={current && <>
        <label className="tm-field-label" htmlFor="review-note">驳回原因（可选，申请人能看到）</label>
        <textarea id="review-note" ref={reasonBox} className="tm-input" rows={2} maxLength={1000} placeholder="例如：内容与现行制度重复，请合并后重新提交" value={reason} onChange={event => setReason(event.target.value)} />
        <div className="adm-foot-actions">
          <Button variant="danger" disabled={busy} onClick={() => decide.mutate({ id: current.id, approve: false, note: reason.trim() })}>驳回并删除原文件</Button>
          <Button disabled={busy} busy={decide.isPending} onClick={() => decide.mutate({ id: current.id, approve: true, note: '' })}>通过并开始解析</Button>
        </div>
      </>}>
      {current && <>
        <FactList items={[
          { label: '提交到', value: `${current.knowledge_base_name}（平台）` },
          { label: '申请人', value: `${personName(current.uploader)}，${roleLabel(roles.get(current.uploader.username))}` },
          { label: '格式', value: sizeLabel(current) },
          { label: '申请时间', value: formatStamp(current.created_at) },
          { label: '原文件', value: '暂存，未进入索引' },
        ]} />
        <SourcePreview key={current.id} doc={current} />
      </>}
    </Drawer>
  </Page>
}

// ------------------------------------------------------------------ approvals: decided

const RESULTS: { value: '' | 'approved' | 'rejected'; label: string }[] = [{ value: '', label: '全部' }, { value: 'approved', label: '已通过' }, { value: 'rejected', label: '已驳回' }]

function outcome(doc: ReviewedDocument): { text: string; tone: 'ok' | 'err' | 'muted' } {
  if (doc.result === 'rejected') return doc.review_note ? { text: doc.review_note, tone: 'err' } : { text: '未填写驳回原因', tone: 'muted' }
  if (doc.status === 'ready') return { text: `已就绪，${doc.chunk_count} 个分块`, tone: 'ok' }
  if (doc.status === 'failed') return { text: doc.error ? `处理失败：${doc.error}` : '处理失败', tone: 'err' }
  return { text: '正在入库', tone: 'muted' }
}

export function ReviewHistoryPage() {
  const [result, setResult] = useState<'' | 'approved' | 'rejected'>('')
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [applicant, setApplicant] = useState('')
  const [range, setRange] = useState<TimeRange>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [openId, setOpenId] = useState<string | null>(null)
  const { choices } = useUserChoices()
  const since = useRangeStart(range)

  const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize), type: 'document' })
  if (result) params.set('result', result)
  if (query) params.set('q', query)
  if (applicant) params.set('uploader_id', applicant)
  if (since) params.set('since', since)
  const history = useApi<ReviewHistory>(`/admin/reviews/history?${params.toString()}`, { poll: 30000 })
  const items = history.data?.items ?? []
  const index = items.findIndex(doc => doc.id === openId)
  const current = index >= 0 ? items[index] : null
  const counts = history.data?.counts

  function step(offset: number): void { if (items.length) setOpenId(items[(Math.max(index, 0) + offset + items.length) % items.length].id) }
  const columns: Column<ReviewedDocument>[] = [
    { key: 'type', header: '类型', cell: TypeTag, nowrap: true },
    { key: 'name', header: '内容', cell: doc => <button type="button" className="tm-linkbtn adm-name" onClick={() => setOpenId(doc.id)}>{doc.filename}</button> },
    { key: 'kb', header: '提交到', cell: doc => <span className="tm-muted">{doc.knowledge_base_name}</span>, nowrap: true },
    { key: 'who', header: '申请人', cell: doc => personName(doc.uploader), nowrap: true },
    { key: 'at', header: '申请时间', cell: doc => <span className="tm-muted tm-num">{formatStamp(doc.created_at)}</span>, nowrap: true },
    { key: 'result', header: '结果', cell: doc => <StatusTag value={doc.result} />, nowrap: true },
    { key: 'reviewer', header: '审批人', cell: doc => personName(doc.reviewer), nowrap: true },
    { key: 'reviewed', header: '审批时间', cell: doc => <span className="tm-muted tm-num">{formatStamp(doc.reviewed_at)}</span>, nowrap: true },
    { key: 'note', header: '处理结果 / 驳回原因', cell: doc => { const info = outcome(doc); return <span className={`adm-clip adm-${info.tone}`} title={info.text}>{info.text}</span> } },
  ]

  return <Page title="已审批">
    <form className="adm-filters" onSubmit={event => { event.preventDefault(); setQuery(text.trim()); setPage(1) }}>
      <Segmented label="审批结果" value={result} onChange={value => { setResult(value); setPage(1) }}
        items={RESULTS.map(item => ({ ...item, count: counts ? (item.value ? counts[item.value] : counts.all) : undefined }))} />
      <label className="tm-search adm-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索文件名或驳回原因" placeholder="搜索文件名或驳回原因" value={text}
        onChange={event => { setText(event.target.value); if (!event.target.value.trim() && query) { setQuery(''); setPage(1) } }} /></label>
      <SearchableSelect label="申请人" options={choices} value={applicant} onChange={value => { setApplicant(value); setPage(1) }} />
      <SearchableSelect label="审批时间" options={TIME_RANGE_OPTIONS} value={range} onChange={value => { setRange(value as TimeRange); setPage(1) }} />
    </form>
    {history.isPending ? <Loading /> : history.isError ? <ErrorState error={history.error} retry={() => { void history.refetch() }} />
      : <section className="tm-panel adm-panel tm-listcard" aria-label="已审批文档">
        <DataTable label="已审批文档" columns={columns} rows={items} rowKey={doc => doc.id} minWidth={1060} selectedKey={openId} onRowClick={doc => setOpenId(doc.id)}
          empty={<Empty title="没有符合条件的审批记录" />} />
        <Pager total={history.data.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} pageSizes={PAGE_SIZES} unit="项" />
      </section>}
    <Drawer open={!!current} onOpenChange={value => { if (!value) setOpenId(null) }} width={520} label={current?.filename}
      leading={<TypeTag />} title={current?.filename} position={current ? `${index + 1} / ${items.length}` : undefined}
      onPrev={items.length > 1 ? () => step(-1) : undefined} onNext={items.length > 1 ? () => step(1) : undefined}>
      {current && <>
        <div className={`adm-result adm-result-${current.result}`}><StatusTag value={current.result} /><span>{personName(current.reviewer)}，{formatStamp(current.reviewed_at)}</span></div>
        <FactList items={[
          { label: '提交到', value: `${current.knowledge_base_name}（平台）` },
          { label: '申请人', value: personName(current.uploader) },
          { label: '申请时间', value: formatStamp(current.created_at) },
          { label: '审批时间', value: formatStamp(current.reviewed_at) },
          current.result === 'rejected' ? { label: '驳回原因', value: current.review_note || '未填写' } : { label: '处理结果', value: outcome(current).text },
          { label: '原文件', value: current.result === 'rejected' ? '已删除' : '已保留' },
        ]} />
        {current.result === 'approved' && <div><Link className={buttonClass('secondary')} to={`/knowledge/${current.knowledge_base_id}/documents/${current.id}`}>打开这份文档</Link></div>}
      </>}
    </Drawer>
  </Page>
}

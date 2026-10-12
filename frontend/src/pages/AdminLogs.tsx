import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useApi } from '../lib/api'
import { methodLabel, type KnowledgeBase, type McpCallLog, type Page as Paged, type QueryLog } from '../lib/types'
import { DataTable, Empty, ErrorState, Loading, Pager, ScopeTag, SearchableSelect, StatusTag, type Column, type SelectChoice } from '../components/ui'
import { AdminSide } from '../components/shell/ModuleNav'
import { Page } from '../components/shell/Shell'
import { TIME_RANGE_OPTIONS, formatClock, formatDuration, localMidnight, useRangeStart, useUserChoices, type TimeRange } from './adminShared'

const PAGE_SIZES = [20, 50, 100]
const SOURCE_LABEL: Record<string, string> = { chat: '问答', debug: '检索对比', mcp: 'MCP' }
const SOURCES: SelectChoice[] = [{ value: '', label: '全部' }, { value: 'chat', label: '问答' }, { value: 'debug', label: '检索对比' }, { value: 'mcp', label: 'MCP' }]
const STATUSES: SelectChoice[] = [{ value: '', label: '全部' }, { value: 'ok', label: '成功' }, { value: 'error', label: '失败' }]
const ALL_PERSONAL = '__personal__'

interface QueryLogPage extends Paged<QueryLog> { today?: { count: number; failed: number } }
interface McpLogPage extends Paged<McpCallLog> { tools: string[] }

function SearchBox({ label, placeholder, onSubmit }: { label: string; placeholder: string; onSubmit: (value: string) => void }) {
  const [text, setText] = useState('')
  return <form className="ad-search-form" onSubmit={event => { event.preventDefault(); onSubmit(text.trim()) }}>
    <label className="tm-search ad-search"><Search size={14} aria-hidden="true" />
      <input aria-label={label} placeholder={placeholder} value={text} onChange={event => { setText(event.target.value); if (!event.target.value.trim()) onSubmit('') }} />
    </label>
  </form>
}

// ------------------------------------------------------------------ query logs

export function QueryLogsPage() {
  const [q, setQ] = useState('')
  const [range, setRange] = useState<TimeRange>('all')
  const [source, setSource] = useState('')
  const [libraries, setLibraries] = useState<string[]>([])
  const [user, setUser] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[1])
  const since = useRangeStart(range)
  const todayStart = useMemo(() => localMidnight(), [])
  const kbs = useApi<KnowledgeBase[]>('/knowledge-bases')
  const { choices: userChoices } = useUserChoices()
  const libraryChoices = useMemo<SelectChoice[]>(() => [
    ...(kbs.data ?? []).filter(kb => kb.scope === 'platform').map(kb => ({ value: kb.id, label: kb.name, group: '平台' })),
    { value: ALL_PERSONAL, label: '所有个人库', hint: '只含元数据', group: '个人' },
  ], [kbs.data])

  const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize), today_since: todayStart })
  if (q) params.set('q', q)
  if (since) params.set('since', since)
  if (source) params.set('source', source)
  if (user) params.set('user_id', user)
  if (status) params.set('status', status)
  for (const value of libraries) if (value !== ALL_PERSONAL) params.append('knowledge_base_id', value)
  if (libraries.includes(ALL_PERSONAL)) params.set('include_personal', 'true')
  const logs = useApi<QueryLogPage>(`/admin/query-logs?${params.toString()}`, { poll: 15000 })
  const reset = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(1) }

  const columns: Column<QueryLog>[] = [
    { key: 'time', header: '时间', cell: row => <span className="tm-muted tm-num">{formatClock(row.created_at)}</span>, nowrap: true },
    { key: 'user', header: '用户', cell: row => row.username || '—', nowrap: true },
    { key: 'source', header: '来源', cell: row => <span className="tm-muted">{SOURCE_LABEL[row.source] ?? row.source}</span>, nowrap: true },
    { key: 'kb', header: '知识库', cell: row => <span className="inline-flex items-center gap-1.5">{row.knowledge_base_name || (row.knowledge_base_id ? '已删除的知识库' : '—')}<ScopeTag scope={row.kb_scope} /></span>, nowrap: true },
    { key: 'query', header: '问题', cell: row => <>
      {row.query === null && row.kb_scope === 'personal' ? <span className="tm-faint ad-italic">个人库，不记录原文（{row.query_chars} 字）</span> : row.query ?? '—'}
      {row.error && <span className="tm-table-sub" style={{ color: 'var(--tm-danger)' }}>{row.error}</span>}
    </>, className: 'ad-question' },
    { key: 'method', header: '方法', cell: row => <span className="tm-muted">{methodLabel(row.method)}</span>, nowrap: true },
    { key: 'results', header: '结果', align: 'right', cell: row => <span className="tm-num">{row.result_count}</span>, nowrap: true },
    { key: 'latency', header: '耗时', align: 'right', cell: row => <span className={row.status === 'error' ? 'ad-err tm-num' : 'tm-num'}>{formatDuration(row.latency_ms)}</span>, nowrap: true },
    { key: 'status', header: '状态', cell: row => <StatusTag value={row.status} />, nowrap: true },
  ]

  return <Page side={<AdminSide />} title="查询日志">
    <div className="ad-filters">
      <SearchBox label="搜索问题原文" placeholder="搜索平台库的问题原文" onSubmit={reset(setQ)} />
      <SearchableSelect label="时间" options={TIME_RANGE_OPTIONS} value={range} onChange={reset(value => setRange(value as TimeRange))} />
      <SearchableSelect label="来源" options={SOURCES} value={source} onChange={reset(setSource)} />
      <SearchableSelect label="知识库" multiple options={libraryChoices} value={libraries} onChange={reset(setLibraries)} width={320} />
      <SearchableSelect label="用户" options={userChoices} value={user} onChange={reset(setUser)} />
      <SearchableSelect label="状态" options={STATUSES} value={status} onChange={reset(setStatus)} />
      <span className="flex-1" />
      {logs.data?.today && <span className="tm-muted tm-num">今天 {logs.data.today.count.toLocaleString('zh-CN')} 次，失败 {logs.data.today.failed.toLocaleString('zh-CN')} 次</span>}
    </div>
    {logs.isPending ? <Loading /> : logs.isError ? <ErrorState error={logs.error} retry={() => { void logs.refetch() }} />
      : <section className="tm-panel ad-panel" aria-label="查询日志">
        <DataTable label="查询日志" columns={columns} rows={logs.data.items} rowKey={row => row.id} minWidth={1080} compact
          rowProps={row => ({ className: row.status === 'error' ? 'ad-row-error' : undefined })} empty={<Empty title="暂无查询记录" />} />
        <Pager total={logs.data.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} pageSizes={PAGE_SIZES} unit="条" />
      </section>}
  </Page>
}

// ------------------------------------------------------------------ MCP call logs

/** “编号 2”, “query 12 字”: only ids, numbers, lengths and file extensions are ever recorded. */
export function describeArguments(args: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(args ?? {}).map(([key, value]) => {
    if (Array.isArray(value)) return { key, value: value.join('、') }
    if (value && typeof value === 'object') {
      const shape = value as Record<string, unknown>
      if ('chars' in shape) return { key, value: `${shape.chars} 字` }
      if ('items' in shape) return { key, value: `${shape.items} 项` }
      if ('extension' in shape) return { key, value: String(shape.extension || '无扩展名') }
      if (Array.isArray(shape.keys)) return { key, value: `${shape.keys.length} 个字段` }
    }
    return { key, value: String(value) }
  })
}

export function McpLogsPage() {
  const [tool, setTool] = useState('')
  const [range, setRange] = useState<TimeRange>('all')
  const [user, setUser] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[1])
  const [tools, setTools] = useState<string[]>([])
  const since = useRangeStart(range)
  const { choices: userChoices } = useUserChoices()
  const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) })
  if (tool) params.set('tool', tool)
  if (since) params.set('since', since)
  if (user) params.set('user_id', user)
  if (status) params.set('status', status)
  const logs = useApi<McpLogPage>(`/admin/mcp-logs?${params.toString()}`, { poll: 15000 })
  const known = logs.data?.tools
  useEffect(() => { if (known) setTools(known) }, [known])
  const toolChoices = useMemo<SelectChoice[]>(() => [{ value: '', label: '全部' }, ...tools.map(name => ({ value: name, label: name }))], [tools])
  const reset = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(1) }

  const columns: Column<McpCallLog>[] = [
    { key: 'time', header: '时间', cell: row => <span className="tm-muted tm-num">{formatClock(row.created_at)}</span>, nowrap: true },
    { key: 'user', header: '用户', cell: row => row.username || '—', nowrap: true },
    { key: 'tool', header: '工具', cell: row => <span className="tm-mono">{row.tool}</span>, nowrap: true },
    { key: 'transport', header: '传输', cell: row => <span className="tm-muted">{row.transport === 'http' ? 'HTTP' : 'stdio'}</span>, nowrap: true },
    { key: 'status', header: '状态', cell: row => <>
      <StatusTag value={row.status} />
      {row.error && <span className="tm-table-sub ad-err ad-wrap">{row.error}</span>}
    </>, nowrap: true },
    { key: 'latency', header: '耗时', align: 'right', cell: row => <span className={row.status === 'error' ? 'ad-err tm-num' : 'tm-num'}>{formatDuration(row.latency_ms)}</span>, nowrap: true },
    { key: 'args', header: '参数', cell: row => <span className="ad-args">{describeArguments(row.arguments).map(item => <span key={item.key} className="ad-arg"><span className="tm-faint">{item.key}</span> {item.value}</span>)}</span> },
  ]

  return <Page side={<AdminSide />} title="MCP 调用日志">
    <div className="ad-filters">
      <SearchableSelect label="时间" options={TIME_RANGE_OPTIONS} value={range} onChange={reset(value => setRange(value as TimeRange))} />
      <SearchableSelect label="工具" options={toolChoices} value={tool} onChange={reset(setTool)} />
      <SearchableSelect label="用户" options={userChoices} value={user} onChange={reset(setUser)} />
      <SearchableSelect label="状态" options={STATUSES} value={status} onChange={reset(setStatus)} />
    </div>
    {logs.isPending ? <Loading /> : logs.isError ? <ErrorState error={logs.error} retry={() => { void logs.refetch() }} />
      : <section className="tm-panel ad-panel" aria-label="MCP 调用日志">
        <DataTable label="MCP 调用日志" columns={columns} rows={logs.data.items} rowKey={row => row.id} minWidth={900} compact empty={<Empty title="暂无 MCP 调用" />} />
        <Pager total={logs.data.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} pageSizes={PAGE_SIZES} unit="条" />
      </section>}
  </Page>
}

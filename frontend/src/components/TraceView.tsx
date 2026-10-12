import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SlidersHorizontal } from 'lucide-react'
import type { RetrievalConfig, TraceStage } from '../lib/types'
import { candidateLabel, comparisonUrl, configTags, formatMs, rankColumns, stageRows, traceTotals, type RankColumn } from '../lib/trace'
import { buttonClass, DataTable, Segmented } from './ui'

/** Rank of every chunk per column; lines break where a chunk is absent from a recorded column. */
function RankChart({ columns, topK, selectedId }: { columns: RankColumn[]; topK?: number; selectedId?: string | null }) {
  const rows = Math.max(...columns.map(column => column.candidates.length))
  const width = 600, left = 18, labelWidth = 150, top = 30, rowH = 26
  const gap = columns.length > 1 ? (width - left - labelWidth - 8) / (columns.length - 1) : 0
  const x = (index: number) => left + index * gap
  const y = (rank: number) => top + (rank - 1) * rowH
  const height = top + (rows - 1) * rowH + 18
  const last = columns[columns.length - 1]
  const finalSet = new Set(last.key === 'postprocess' ? last.candidates.map(c => c.id) : last.candidates.slice(0, topK ?? last.candidates.length).map(c => c.id))
  const ids = [...new Set(columns.flatMap(column => column.candidates.map(c => c.id)))]
  const rankOf = columns.map(column => new Map(column.candidates.map(c => [c.id, c.rank])))
  const kind = (id: string) => id === selectedId ? 'selected' : finalSet.has(id) ? 'final' : 'dropped'
  const order = { dropped: 0, final: 1, selected: 2 }
  const sorted = [...ids].sort((a, b) => order[kind(a)] - order[kind(b)])
  const prefinal = last.key === 'postprocess' && columns.length > 1 ? columns[columns.length - 2] : null
  const labels = [
    ...last.candidates.map(c => ({ c, col: columns.length - 1 })),
    ...(prefinal ? prefinal.candidates.filter(c => !finalSet.has(c.id) && c.rank > last.candidates.length).map(c => ({ c, col: columns.length - 2 })) : []),
  ]
  return <svg className="trace-rank" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`名次变化：${columns.map(column => column.label).join('、')}`}>
    {columns.map((column, index) => <g key={column.key}>
      <text x={x(index)} y={12} textAnchor="middle" className="trace-rank-col">{column.label}</text>
      <line x1={x(index)} x2={x(index)} y1={top - 8} y2={height - 10} className="trace-rank-axis" />
    </g>)}
    {topK && rows > topK && <g><line x1={left - 8} x2={width} y1={y(topK) + rowH / 2} y2={y(topK) + rowH / 2} className="trace-rank-cut" /><text x={width} y={y(topK) + rowH / 2 + 12} textAnchor="end" className="trace-rank-note">top {topK} 截止</text></g>}
    {sorted.map(id => {
      const k = kind(id)
      const points = columns.map((_, index) => rankOf[index].get(id))
      const segments = points.slice(1).map((rank, index) => points[index] !== undefined && rank !== undefined
        ? <line key={index} x1={x(index)} y1={y(points[index]!)} x2={x(index + 1)} y2={y(rank)} className={`trace-rank-line trace-rank-${k}`} /> : null)
      return <g key={id}>{segments}{points.map((rank, index) => rank === undefined ? null
        : <circle key={index} cx={x(index)} cy={y(rank)} r={k === 'selected' ? 5 : 4} className={`trace-rank-node trace-rank-${k}`} />)}</g>
    })}
    {labels.map(({ c, col }) => <text key={`${col}-${c.id}`} x={x(col) + 12} y={y(c.rank) + 4} className={`trace-rank-label trace-rank-label-${kind(c.id)}`}>{candidateLabel(c)}</text>)}
  </svg>
}

function CandidateTable({ columns, topK }: { columns: RankColumn[]; topK?: number }) {
  const [key, setKey] = useState(columns[columns.length - 1].key === 'postprocess' && columns.length > 1 ? columns[columns.length - 2].key : columns[columns.length - 1].key)
  const index = Math.max(0, columns.findIndex(column => column.key === key))
  const column = columns[index]
  const previous = index > 0 ? new Map(columns[index - 1].candidates.map(c => [c.id, c.rank])) : null
  const scoreName = column.key === 'rerank' ? '重排分' : column.key === 'fusion' ? 'RRF 分' : '分数'
  return <section className="trace-section" aria-label="候选明细">
    <div className="trace-section-head"><h3>候选明细</h3><span className="flex-1" />
      <Segmented size="sm" label="候选阶段" value={column.key} onChange={setKey} items={columns.map(item => ({ value: item.key, label: item.label }))} /></div>
    <DataTable compact className="trace-table" rows={column.candidates} rowKey={c => c.id} rowProps={c => ({ dim: !!topK && c.rank > topK })} label={`${column.label}候选`}
      columns={[
        { key: 'rank', header: '名次', align: 'right', width: 48, cell: c => c.rank },
        { key: 'chunk', header: '分块', cell: c => <span className="break-all">{candidateLabel(c)}</span> },
        { key: 'score', header: scoreName, align: 'right', cell: c => c.score.toFixed(3) },
        ...(previous ? [{ key: 'delta', header: `较${columns[index - 1].label}`, align: 'right' as const, nowrap: true, cell: (c: { id: string; rank: number }) => {
          const before = previous.get(c.id)
          if (before === undefined) return <span className="tm-faint">新进入</span>
          const delta = before - c.rank
          return delta === 0 ? <span className="tm-faint">—</span> : <span className={delta > 0 ? 'trace-up' : 'trace-down'}>{delta > 0 ? `↑ ${delta}` : `↓ ${-delta}`}</span>
        } }] : []),
      ]} />
  </section>
}

/** The recall chain of one answer: totals, parameters, waterfall, stages, rank changes and candidates. */
export function TraceView({ stages, queries, config, selectedId, kbId, question, canCompare = false }: {
  stages: TraceStage[]; queries?: string[]; config?: RetrievalConfig | null; selectedId?: string | null
  kbId?: string; question?: string; canCompare?: boolean
}) {
  const rows = useMemo(() => stageRows(stages), [stages])
  const columns = useMemo(() => rankColumns(stages), [stages])
  const totals = traceTotals(stages)
  const tags = configTags(config)
  const topK = config?.top_k
  if (!stages.length) return <p className="tm-faint">这条回答没有记录召回链路。</p>
  return <div className="trace">
    <header className="trace-summary">
      <div className="min-w-0">
        <p className="trace-total tm-num">{formatMs(totals.ms)}</p>
        <p className="tm-muted tm-num">{stages.length} 个阶段{totals.corpus !== undefined && totals.kept !== undefined && `，从 ${totals.corpus.toLocaleString('zh-CN')} 个分块中保留 ${totals.kept} 个`}</p>
      </div>
      {canCompare && <Link className={buttonClass('secondary', 'sm')} to={comparisonUrl(kbId, question, config)}><SlidersHorizontal size={13} aria-hidden="true" />用这组参数去检索对比</Link>}
    </header>
    {tags.length > 0 && <ul className="trace-tags" aria-label="检索参数">{tags.map(tag => <li key={tag.label} className="tm-tag">{tag.label} <strong>{tag.value}</strong></li>)}</ul>}
    {queries && queries.length > 1 && <p className="tm-muted text-xs">查询改写：{queries.join(' / ')}</p>}
    <div className="trace-waterfall" role="img" aria-label={`耗时分布：${rows.map(row => `${row.label} ${formatMs(row.ms)}`).join('，')}`}>
      {rows.map((row, index) => <span key={index} style={{ flexGrow: Math.max(row.share, 0.0001), background: row.color }} />)}
    </div>
    <div className="tm-table-wrap">
      <table className="tm-table tm-table-compact trace-stages">
        <thead><tr><th>阶段</th><th className="tm-right">输入</th><th className="tm-right">输出</th><th className="tm-right">耗时</th><th className="tm-right">占比</th><th>说明</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index} className="trace-stage" data-stage={row.stage.stage}>
          <td className="tm-nowrap"><span className="trace-swatch" style={{ background: row.color }} aria-hidden="true" />{row.label}</td>
          <td className="tm-right">{row.input ?? '—'}</td><td className="tm-right">{row.output ?? '—'}</td>
          <td className="tm-right tm-nowrap">{formatMs(row.ms)}</td><td className="tm-right tm-faint">{(row.share * 100).toFixed(1)}%</td>
          <td className="tm-muted trace-note">{row.note}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {columns.length > 0 && <>
      <section className="trace-section" aria-label="名次变化"><div className="trace-section-head"><h3>名次变化</h3></div><RankChart columns={columns} topK={topK} selectedId={selectedId} /></section>
      <CandidateTable columns={columns} topK={topK} />
    </>}
  </div>
}

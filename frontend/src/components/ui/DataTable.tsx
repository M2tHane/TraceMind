import { useEffect, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, SearchX } from 'lucide-react'
import { Select } from '../Select'
import { Empty } from './legacy'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T, index: number) => ReactNode
  width?: number | string
  nowrap?: boolean
  className?: string
  headerClassName?: string
}
export interface HeaderGroup { label: ReactNode; span: number }
export interface TableSelection { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void; label: (key: string) => string }

const INTERACTIVE = 'a, button, input, select, textarea, label, [role="button"], [role="checkbox"]'

/**
 * Bordered table. Rows may be clicked anywhere; each clickable row must still render a real
 * <button> or <a> in its first cell for keyboard users (clicks on it are not handled twice).
 */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, selectedKey, rowProps, selection, headerGroups, minWidth, empty, loading = false, compact = false, label, className }: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  selectedKey?: string | null
  rowProps?: (row: T) => { dim?: boolean; className?: string }
  selection?: TableSelection
  headerGroups?: HeaderGroup[]
  minWidth?: number
  empty?: ReactNode
  /** Skeleton rows while the first page loads (shown after 300ms). */
  loading?: boolean
  compact?: boolean
  label?: string
  className?: string
}) {
  const keys = rows.map(rowKey)
  const allSelected = !!selection && keys.length > 0 && keys.every(key => selection.selected.has(key))
  const someSelected = !!selection && keys.some(key => selection.selected.has(key))
  function toggleAll(): void {
    if (!selection) return
    const next = new Set(selection.selected)
    for (const key of keys) { if (allSelected) next.delete(key); else next.add(key) }
    selection.onChange(next)
  }
  function toggle(key: string): void {
    if (!selection) return
    const next = new Set(selection.selected)
    if (next.has(key)) next.delete(key); else next.add(key)
    selection.onChange(next)
  }
  function rowClick(event: MouseEvent<HTMLTableRowElement>, row: T): void {
    if (!onRowClick || (event.target as HTMLElement).closest(INTERACTIVE)) return
    // Focus the row's own control so dialogs opened from it return focus here.
    event.currentTarget.querySelector<HTMLElement>('td button, td a')?.focus()
    onRowClick(row)
  }
  const span = columns.length + (selection ? 1 : 0)
  return <div className={clsx('tm-table-wrap', className)}>
    <table className={clsx('tm-table', compact && 'tm-table-compact')} style={minWidth ? { minWidth } : undefined} aria-label={label}>
      <thead>
        {headerGroups && <tr className="tm-table-groups">{selection && <th aria-hidden="true" />}{headerGroups.map((group, index) => <th key={index} colSpan={group.span} scope="colgroup">{group.label}</th>)}</tr>}
        <tr>
          {selection && <th style={{ width: 36 }}><input type="checkbox" aria-label="全选" checked={allSelected} ref={input => { if (input) input.indeterminate = someSelected && !allSelected }} onChange={toggleAll} /></th>}
          {columns.map(column => <th key={column.key} scope="col" style={column.width !== undefined ? { width: column.width } : undefined} className={column.headerClassName}>{column.header}</th>)}
        </tr>
      </thead>
      <tbody>
        {loading ? <SkeletonRows columns={span} /> : rows.length === 0 ? <tr className="tm-table-empty"><td colSpan={span}>{typeof empty === 'string' || empty === undefined ? <Empty title={empty ?? '暂无数据'} icon={empty?.startsWith('没有匹配') ? SearchX : undefined} /> : empty}</td></tr> : rows.map((row, index) => {
          const key = keys[index]
          const extra = rowProps?.(row)
          return <tr key={key} data-clickable={onRowClick ? 'true' : undefined} data-selected={selectedKey === key || undefined} data-dim={extra?.dim || undefined}
            className={extra?.className} onClick={event => rowClick(event, row)}>
            {selection && <td><input type="checkbox" aria-label={`选择 ${selection.label(key)}`} checked={selection.selected.has(key)} onChange={() => toggle(key)} /></td>}
            {columns.map(column => <td key={column.key} className={clsx(column.nowrap && 'tm-nowrap', column.className)}>{column.cell(row, index)}</td>)}
          </tr>
        })}
      </tbody>
    </table>
  </div>
}

function SkeletonRows({ columns }: { columns: number }) {
  const [shown, setShown] = useState(false)
  useEffect(() => { const timer = window.setTimeout(() => setShown(true), 300); return () => window.clearTimeout(timer) }, [])
  return <>{Array.from({ length: 5 }, (_, row) => <tr key={row} aria-hidden="true">
    {Array.from({ length: columns }, (_, cell) => <td key={cell}>{shown && <span className="tm-skel" style={{ width: `${40 + ((row * 7 + cell * 13) % 45)}%` }} />}</td>)}
  </tr>)}<tr className="sr-only"><td role="status">正在加载…</td></tr></>
}

/** Page numbers: all of them up to 7 pages, beyond that seven slots with the gaps as ellipses (1 2 3 4 5 … 40). */
export function pageWindow(page: number, pages: number): (number | 'gap')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  if (page <= 4) return [1, 2, 3, 4, 5, 'gap', pages]
  if (page >= pages - 3) return [1, 'gap', pages - 4, pages - 3, pages - 2, pages - 1, pages]
  return [1, 'gap', page - 1, page, page + 1, 'gap', pages]
}

/**
 * Pager at the bottom of a list card: “共 N 条 · 每页 10 条” on the left; previous, page numbers, next and “跳至 [ ] 页”
 * (Enter jumps) on the right. Hidden while everything fits on one page at the smallest page size.
 * `compact` is the narrow-column form: previous · 1 / 3 · next · 跳至.
 */
export function Pager({ total, page, pageSize, onPageChange, onPageSizeChange, pageSizes = [10, 20, 50], unit = '条', compact = false }: {
  total: number; page: number; pageSize: number; onPageChange: (page: number) => void; onPageSizeChange?: (size: number) => void; pageSizes?: number[]; unit?: string; compact?: boolean
}) {
  const [jump, setJump] = useState('')
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const smallest = onPageSizeChange ? Math.min(pageSize, ...pageSizes) : pageSize
  if (total <= smallest) return null
  const go = (next: number) => onPageChange(Math.min(pages, Math.max(1, next)))
  function submitJump(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return
    const value = Number.parseInt(jump, 10)
    if (Number.isFinite(value)) go(value)
    setJump('')
  }
  const jumpBox = <label className="tm-pg-jump">跳至<input type="text" inputMode="numeric" aria-label="跳转页码" value={jump} onChange={event => setJump(event.target.value.replace(/\D/g, ''))} onKeyDown={submitJump} />页</label>
  const prev = <button type="button" className="tm-pg" disabled={page <= 1} aria-label="上一页" onClick={() => go(page - 1)}><ChevronLeft size={14} aria-hidden="true" /></button>
  const next = <button type="button" className="tm-pg" disabled={page >= pages} aria-label="下一页" onClick={() => go(page + 1)}><ChevronRight size={14} aria-hidden="true" /></button>
  if (compact) return <nav className="tm-pager tm-pager-compact" aria-label="分页">{prev}<span className="tm-pg-of">{page} / {pages}</span>{next}{jumpBox}</nav>
  return <nav className="tm-pager" aria-label="分页">
    <span className="tm-pager-total">共 {total.toLocaleString('zh-CN')} {unit} · {onPageSizeChange
      ? <Select label="每页条数" className="tm-pg" value={String(pageSize)} onChange={value => { onPageSizeChange(Number(value)); onPageChange(1) }}
        options={pageSizes.map(size => ({ value: String(size), label: `每页 ${size} ${unit}` }))} />
      : `每页 ${pageSize} ${unit}`}</span>
    {pages > 1 && <>
      {prev}
      {pageWindow(page, pages).map((item, index) => item === 'gap' ? <span key={`gap-${index}`} className="tm-pg-gap" aria-hidden="true">…</span>
        : <button key={item} type="button" className="tm-pg" aria-current={item === page ? 'page' : undefined} aria-label={`第 ${item} 页`} onClick={() => go(item)}>{item}</button>)}
      {next}
      {jumpBox}
    </>}
  </nav>
}

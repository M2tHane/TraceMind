import { useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { Select } from '../Select'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T, index: number) => ReactNode
  align?: 'left' | 'right' | 'center'
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
export function DataTable<T>({ columns, rows, rowKey, onRowClick, selectedKey, rowProps, selection, headerGroups, minWidth, empty, compact = false, label, className }: {
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
          {selection && <th style={{ width: 36 }}><input type="checkbox" className="tm-check" aria-label="全选" checked={allSelected} ref={input => { if (input) input.indeterminate = someSelected && !allSelected }} onChange={toggleAll} /></th>}
          {columns.map(column => <th key={column.key} scope="col" style={column.width !== undefined ? { width: column.width } : undefined} className={clsx(column.align === 'right' && 'tm-right', column.align === 'center' && 'tm-center', column.headerClassName)}>{column.header}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? <tr className="tm-table-empty"><td colSpan={span}>{empty ?? '暂无数据'}</td></tr> : rows.map((row, index) => {
          const key = keys[index]
          const extra = rowProps?.(row)
          return <tr key={key} data-clickable={onRowClick ? 'true' : undefined} data-selected={selectedKey === key || undefined} data-dim={extra?.dim || undefined}
            className={extra?.className} onClick={event => rowClick(event, row)}>
            {selection && <td><input type="checkbox" className="tm-check" aria-label={`选择 ${selection.label(key)}`} checked={selection.selected.has(key)} onChange={() => toggle(key)} /></td>}
            {columns.map(column => <td key={column.key} className={clsx(column.align === 'right' && 'tm-right', column.align === 'center' && 'tm-center', column.nowrap && 'tm-nowrap', column.className)}>{column.cell(row, index)}</td>)}
          </tr>
        })}
      </tbody>
    </table>
  </div>
}

/** Page numbers with the middle collapsed: 1 2 3 … 107. */
export function pageWindow(page: number, pages: number): (number | 'gap')[] {
  const wanted = new Set([1, pages, page - 1, page, page + 1])
  if (page <= 2) wanted.add(3)
  if (page >= pages - 1) wanted.add(pages - 2)
  const list = [...wanted].filter(value => value >= 1 && value <= pages).sort((a, b) => a - b)
  const out: (number | 'gap')[] = []
  list.forEach((value, index) => { if (index && value - list[index - 1] > 1) out.push('gap'); out.push(value) })
  return out
}

export function Pager({ total, page, pageSize, onPageChange, onPageSizeChange, pageSizes = [10, 20, 50], unit = '条' }: {
  total: number; page: number; pageSize: number; onPageChange: (page: number) => void; onPageSizeChange?: (size: number) => void; pageSizes?: number[]; unit?: string
}) {
  const [jump, setJump] = useState('')
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total ? (page - 1) * pageSize + 1 : 0
  const last = Math.min(total, page * pageSize)
  const go = (next: number) => onPageChange(Math.min(pages, Math.max(1, next)))
  function submitJump(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return
    const value = Number.parseInt(jump, 10)
    if (Number.isFinite(value)) go(value)
    setJump('')
  }
  return <nav className="tm-pager" aria-label="分页">
    <span className="tm-num">共 {total.toLocaleString('zh-CN')} {unit}{total > 0 && `，第 ${first.toLocaleString('zh-CN')}–${last.toLocaleString('zh-CN')} ${unit}`}</span>
    <span className="flex-1" />
    {(pages > 1 || onPageSizeChange) && <>
      <button type="button" className="tm-pg" disabled={page <= 1} onClick={() => go(page - 1)}>上一页</button>
      {pageWindow(page, pages).map((item, index) => item === 'gap' ? <span key={`gap-${index}`} className="tm-faint" aria-hidden="true">…</span>
        : <button key={item} type="button" className="tm-pg" aria-current={item === page ? 'page' : undefined} aria-label={`第 ${item} 页`} onClick={() => go(item)}>{item}</button>)}
      <button type="button" className="tm-pg" disabled={page >= pages} onClick={() => go(page + 1)}>下一页</button>
      <label className="inline-flex items-center gap-1.5 ml-2">跳至<input className="tm-pg" type="text" inputMode="numeric" aria-label="跳转页码" value={jump} onChange={event => setJump(event.target.value.replace(/\D/g, ''))} onKeyDown={submitJump} />页</label>
      {onPageSizeChange && <Select label="每页条数" className="tm-pg ml-2" value={String(pageSize)} onChange={value => { onPageSizeChange(Number(value)); onPageChange(1) }}
        options={pageSizes.map(size => ({ value: String(size), label: `每页 ${size} ${unit}` }))} />}
    </>}
  </nav>
}

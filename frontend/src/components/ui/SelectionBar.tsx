import type { ReactNode } from 'react'

/** Ink bar shown above a table while rows are ticked: “已选 N 条”, the bulk actions, then “取消选择”. */
export function SelectionBar({ count, unit = '条', onClear, children }: { count: number; unit?: string; onClear: () => void; children?: ReactNode }) {
  return <div className="tm-selbar" role="region" aria-label="批量操作">
    <span className="tm-num">已选 {count} {unit}</span>
    <span className="flex-1" />
    {children}
    <button type="button" className="tm-btn tm-btn-sm" onClick={onClear}>取消选择</button>
  </div>
}

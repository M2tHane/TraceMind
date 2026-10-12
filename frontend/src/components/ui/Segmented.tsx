import type { ReactNode } from 'react'
import clsx from 'clsx'

export interface SegmentedItem<T extends string> { value: T; label: ReactNode; count?: number; disabled?: boolean }

/** Grey segmented filter; the selected item is white with a hairline. */
export function Segmented<T extends string>({ items, value, onChange, label, size = 'md', block = false, className }: {
  items: SegmentedItem<T>[]; value: T; onChange: (value: T) => void; label: string; size?: 'md' | 'sm'; block?: boolean; className?: string
}) {
  return <div role="group" aria-label={label} className={clsx('tm-seg', size === 'sm' && 'tm-seg-sm', block && 'tm-seg-block', className)}>
    {items.map(item => <button key={item.value} type="button" aria-pressed={item.value === value} disabled={item.disabled} onClick={() => onChange(item.value)}>
      {item.label}{item.count !== undefined && <span className="tm-seg-count">{item.count.toLocaleString('zh-CN')}</span>}
    </button>)}
  </div>
}

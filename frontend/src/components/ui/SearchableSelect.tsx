import { useCallback, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react'
import clsx from 'clsx'
import { buttonClass } from './Button'

export interface SelectChoice { value: string; label: string; group?: string; hint?: ReactNode; suffix?: ReactNode }

const SEARCH_THRESHOLD = 8

function Marked({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>
}

type Common = {
  label: string
  options: SelectChoice[]
  trigger?: ReactNode
  triggerClassName?: string
  size?: 'md' | 'sm'
  allLabel?: string
  searchLabel?: string
  disabled?: boolean
  align?: 'start' | 'end'
  width?: number
  onOpenChange?: (open: boolean) => void
  /** Expose the trigger as a combobox (for pickers that replace a native select). */
  combobox?: boolean
}
type Single = Common & { multiple?: false; value: string; onChange: (value: string) => void }
type Multi = Common & { multiple: true; value: string[]; onChange: (value: string[]) => void }

/**
 * Filter dropdown on a Radix Popover. More than eight options adds a search box whose matches are
 * marked; groups render as grey headings; multi-select applies on “应用”.
 */
export function SearchableSelect(props: Single | Multi) {
  const { label, options, trigger, triggerClassName, size = 'md', allLabel = '全部', searchLabel, disabled, align = 'start', width = 280, onOpenChange, combobox = false } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<string[]>([])
  const list = useRef<HTMLDivElement>(null)
  // Inside a dialog or drawer the list renders within it: Popover and Dialog ship separate copies of Radix's focus and
  // dismiss layers, so a list portalled to <body> would be outside the dialog's focus trap and ignore pointer events.
  const [host, setHost] = useState<HTMLElement | undefined>()
  const triggerRef = useCallback((node: HTMLButtonElement | null) => { if (node) setHost(node.closest<HTMLElement>('[role="dialog"]') ?? undefined) }, [])
  const id = useId()
  const searchable = options.length > SEARCH_THRESHOLD
  const visible = useMemo(() => query ? options.filter(option => option.label.toLowerCase().includes(query.toLowerCase())) : options, [options, query])
  const groups = useMemo(() => {
    const map = new Map<string, SelectChoice[]>()
    for (const option of visible) map.set(option.group ?? '', [...(map.get(option.group ?? '') ?? []), option])
    return [...map.entries()]
  }, [visible])
  const selected = props.multiple ? draft : [props.value]
  const current = props.multiple ? props.value : [props.value]
  const summary = props.multiple
    ? current.length === 0 ? allLabel : current.length === 1 ? options.find(option => option.value === current[0])?.label ?? '已选 1' : `已选 ${current.length}`
    : options.find(option => option.value === props.value)?.label ?? allLabel

  function openChange(next: boolean): void {
    setOpen(next)
    onOpenChange?.(next)
    if (next) { setQuery(''); if (props.multiple) setDraft(props.value) }
  }
  function choose(value: string): void {
    if (props.multiple) { setDraft(items => items.includes(value) ? items.filter(item => item !== value) : [...items, value]); return }
    props.onChange(value)
    setOpen(false)
  }
  function moveFocus(event: KeyboardEvent<HTMLElement>): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    if (!items.length) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1)
    items[next].focus()
  }

  return <Popover.Root open={open} onOpenChange={openChange}>
    <Popover.Trigger asChild disabled={disabled}>
      <button ref={triggerRef} type="button" className={clsx(buttonClass('secondary', size), 'tm-btn-filter', triggerClassName)} aria-haspopup="listbox" role={combobox ? 'combobox' : undefined} aria-label={trigger || combobox ? label : undefined}>
        {trigger ?? <>{label}<span className="tm-btn-value">{summary}</span></>}
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
    </Popover.Trigger>
    <Popover.Portal container={host}>
      <Popover.Content className="tm-pop" style={{ width }} align={align} sideOffset={6} collisionPadding={12}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}
        onOpenAutoFocus={event => { if (!searchable) { event.preventDefault(); list.current?.querySelector<HTMLElement>('[aria-selected="true"], [role="option"]')?.focus() } }}>
        {searchable && <label className="tm-search"><Search size={13} aria-hidden="true" />
          <input type="text" value={query} onChange={event => setQuery(event.target.value)} aria-label={searchLabel ?? `搜索${label}`} aria-controls={id} onKeyDown={moveFocus} />
        </label>}
        <div ref={list} id={id} role="listbox" aria-label={label} aria-multiselectable={props.multiple || undefined} className="tm-pop-list" onKeyDown={moveFocus}>
          {visible.length === 0 && <p className="tm-pop-empty">没有匹配的选项</p>}
          {groups.map(([group, items]) => <div key={group} role={group ? 'group' : undefined} aria-label={group || undefined}>
            {group && <div className="tm-pop-group">{group}</div>}
            {items.map(option => {
              const on = selected.includes(option.value)
              return <button key={option.value} type="button" role="option" aria-selected={on} data-multi={props.multiple || undefined} className="tm-opt" onClick={() => choose(option.value)}>
                {props.multiple && <span className="tm-opt-box" aria-hidden="true">{on && <Check size={11} strokeWidth={3} />}</span>}
                <span className="tm-opt-label"><Marked text={option.label} query={query} /></span>
                {option.suffix}
                {option.hint && <span className="tm-opt-hint">{option.hint}</span>}
                {!props.multiple && on && <Check size={13} className="ml-auto shrink-0" aria-hidden="true" />}
              </button>
            })}
          </div>)}
        </div>
        {props.multiple && <div className="tm-pop-footer">
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setDraft([])}>清除</button>
          <span className="flex-1" />
          <button type="button" className={buttonClass('primary', 'sm')} onClick={() => { props.onChange(draft); setOpen(false) }}>应用</button>
        </div>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

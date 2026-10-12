import { useRef } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { buttonClass } from './Button'

function ToggleIcon({ side, expanded }: { side: 'left' | 'right'; expanded: boolean }) {
  const divider = side === 'left' ? 'M9 4v16' : 'M15 4v16'
  const arrow = side === 'left' ? (expanded ? 'M15.5 10l-2 2 2 2' : 'M13.5 10l2 2-2 2') : (expanded ? 'M8.5 10l2 2-2 2' : 'M10.5 10l-2 2 2 2')
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d={divider} /><path d={arrow} />
  </svg>
}

export function PanelToggle({ side, expanded, onToggle, name }: { side: 'left' | 'right'; expanded: boolean; onToggle: () => void; name: string }) {
  const label = `${expanded ? '收起' : '展开'}${name}`
  return <button type="button" className={buttonClass('secondary', 'md', 'tm-panel-toggle')} aria-expanded={expanded} aria-label={label} title={label} onClick={onToggle}>
    <ToggleIcon side={side} expanded={expanded} />
  </button>
}

/** 56px title row of a full-height pane. A left pane's toggle sits first, a right pane's last. */
export function PanelHeader({ children, toggle, className }: {
  children?: ReactNode; className?: string
  toggle?: { side: 'left' | 'right'; expanded: boolean; onToggle: () => void; name: string }
}) {
  return <div className={clsx('tm-panel-header', className)}>
    {toggle?.side === 'left' && <PanelToggle {...toggle} />}
    {children}
    {toggle?.side === 'right' && <PanelToggle {...toggle} />}
  </div>
}

/** A collapsed pane: a 52px strip holding only its toggle, at the same spot as when expanded. */
export function CollapsedPanel({ side, onToggle, name, className }: { side: 'left' | 'right'; onToggle: () => void; name: string; className?: string }) {
  return <aside className={clsx('tm-panel-collapsed', className)} aria-label={`${name}已收起`}>
    <div className="tm-panel-header"><PanelToggle side={side} expanded={false} onToggle={onToggle} name={name} /></div>
  </aside>
}

/**
 * 9px drag strip on a pane edge. `edge="right"` sits on a left pane (dragging right widens it),
 * `edge="left"` on a right pane. Arrow keys step 16px.
 */
export function ResizeHandle({ edge, value, min, max, onChange, label }: {
  edge: 'left' | 'right'; value: number; min: number; max: number; onChange: (width: number) => void; label: string
}) {
  const start = useRef<{ x: number; width: number } | null>(null)
  const direction = edge === 'right' ? 1 : -1
  const clamp = (width: number) => Math.round(Math.min(max, Math.max(min, width)))
  function down(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.dataset.dragging = 'true'
    start.current = { x: event.clientX, width: value }
    document.body.classList.add('tm-resizing')
  }
  function move(event: PointerEvent<HTMLDivElement>): void {
    if (start.current) onChange(clamp(start.current.width + direction * (event.clientX - start.current.x)))
  }
  function up(event: PointerEvent<HTMLDivElement>): void {
    if (!start.current) return
    start.current = null
    delete event.currentTarget.dataset.dragging
    document.body.classList.remove('tm-resizing')
  }
  function key(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    onChange(clamp(value + (event.key === 'ArrowRight' ? 16 : -16) * direction))
  }
  return <div className="tm-resize" style={edge === 'right' ? { right: -5 } : { left: -5 }} role="separator" aria-orientation="vertical" aria-label={label}
    aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} />
}

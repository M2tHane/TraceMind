import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Modal } from '../ui'

/**
 * “有未保存的修改” guard. The app uses <BrowserRouter> (no useBlocker), so editors register here while dirty and every
 * in-app way out — sidebar, module tabs, breadcrumbs, sign-out, switching the edited object — asks first.
 * Closing or reloading the tab falls back to the browser's own beforeunload prompt.
 */
interface Entry { id: number; save: () => Promise<boolean> }
let entries: Entry[] = []
let nextId = 1
let ask: ((proceed: () => void) => void) | null = null

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!entries.length) return
  event.preventDefault()
  event.returnValue = ''
}

/** Register an editor while it has unsaved changes. `save` resolves true once the changes are stored. */
export function useUnsavedChanges(dirty: boolean, save: () => Promise<boolean>): void {
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!dirty) return
    const entry: Entry = { id: nextId++, save: () => saveRef.current() }
    entries = [...entries, entry]
    if (entries.length === 1) window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      entries = entries.filter(item => item.id !== entry.id)
      if (!entries.length) window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [dirty])
}

/** Run `proceed` now if nothing is unsaved; otherwise ask first. Returns whether it ran. */
export function confirmLeave(proceed: () => void): boolean {
  if (!entries.length || !ask) { proceed(); return true }
  ask(proceed)
  return false
}

let navigateTo: ((href: string) => void) | null = null

/**
 * onClick for links and exits. Returns true when the default action may go ahead; otherwise the click is held and
 * the dialog decides. Modified clicks (new tab, new window) are never held.
 */
export function guardNavigation(event: MouseEvent<HTMLElement>, proceed?: () => void): boolean {
  if (!entries.length || !ask || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return true
  event.preventDefault()
  const href = event.currentTarget.getAttribute('href')
  ask(proceed ?? (() => { if (href) navigateTo?.(href) }))
  return false
}

/** Mounted once in the workspace: the shared confirmation dialog. */
export function UnsavedChangesDialog() {
  const navigate = useNavigate()
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    ask = proceed => setPending(() => proceed)
    navigateTo = href => navigate(href)
    return () => { ask = null; navigateTo = null }
  }, [navigate])
  function leave(): void {
    const proceed = pending
    entries = []
    window.removeEventListener('beforeunload', onBeforeUnload)
    setPending(null)
    proceed?.()
  }
  async function saveAndLeave(): Promise<void> {
    setSaving(true)
    const results = await Promise.all(entries.map(entry => entry.save().catch(() => false)))
    setSaving(false)
    if (results.every(Boolean)) leave()
  }
  return <Modal open={!!pending} onOpenChange={open => { if (!open && !saving) setPending(null) }} title="有未保存的修改" preventClose={saving}>
    <div className="dialog-body">
      <p className="m-0">离开后，这些修改会丢失。</p>
    </div>
    <div className="dialog-foot">
      <Button variant="danger" disabled={saving} onClick={leave}>放弃并离开</Button>
      <span className="flex-1" />
      <Button variant="secondary" disabled={saving} onClick={() => setPending(null)}>继续编辑</Button>
      <Button busy={saving} onClick={() => { void saveAndLeave() }}>保存并离开</Button>
    </div>
  </Modal>
}

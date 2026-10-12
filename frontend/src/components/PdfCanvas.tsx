import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, ExternalLink, Minus, Plus, RotateCcw } from 'lucide-react'

interface PdfCanvasProps {
  documentId: string
  page?: number | null
  filename: string
  /** Mark the shown page as holding the selected chunk. The parser gives page anchors only, so the whole page is framed. */
  highlight?: { label: string } | null
  /** Called with the page now shown and the page count (after loading and on every navigation). */
  onPageChange?: (page: number, total: number) => void
  /** Content for the right end of the toolbar. */
  toolbarEnd?: ReactNode
  showOpenLink?: boolean
}

function boundPage(page: number, total: number): number {
  return Math.min(Math.max(Number.isFinite(page) ? Math.trunc(page) : 1, 1), Math.max(total, 1))
}

export function PdfCanvas({ documentId, page = 1, filename, highlight = null, onPageChange, toolbarEnd, showOpenLink = true }: PdfCanvasProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(0)
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [accessibleText, setAccessibleText] = useState('')
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const fileUrl = `/api/documents/${encodeURIComponent(documentId)}/file`

  useEffect(() => {
    let cancelled = false
    let task: PDFDocumentLoadingTask | undefined
    setPdf(null)
    setLoading(true)
    setError(null)
    setZoom(1)
    setAccessibleText('')
    async function load(): Promise<void> {
      try {
        const library = await import('pdfjs-dist')
        if (cancelled) return
        library.GlobalWorkerOptions.workerSrc = workerUrl
        task = library.getDocument({ url: fileUrl })
        const document = await task.promise
        if (!cancelled) setPdf(document)
      } catch (caught) {
        if (!cancelled) {
          setError('PDF 加载失败。请重试，或打开原文件。')
          console.warn('PDF load failed:', caught instanceof Error ? caught.name : 'UnknownError')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (task) void task.destroy().catch(caught => {
        console.warn('PDF cleanup failed:', caught instanceof Error ? caught.name : 'UnknownError')
      })
    }
  }, [fileUrl, retry])

  const notify = useRef(onPageChange)
  useEffect(() => { notify.current = onPageChange })
  // The requested page (or page 1) is applied once the PDF is known; the parent hears the page actually shown.
  useEffect(() => {
    if (!pdf) return
    const next = boundPage(page ?? 1, pdf.numPages)
    setCurrentPage(next)
    notify.current?.(next, pdf.numPages)
  }, [page, documentId, pdf])

  useEffect(() => { setPageInput(String(currentPage)) }, [currentPage])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const resize = () => setWidth(viewport.clientWidth)
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const host = canvasHostRef.current
    if (!pdf || !host || width <= 0) return
    let cancelled = false
    let task: RenderTask | undefined
    // A fresh canvas avoids reusing a surface while a cancelled render settles.
    const canvas = document.createElement('canvas')
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', `${filename}，第 ${currentPage} 页，共 ${pdf.numPages} 页`)
    canvas.dataset.pdfPage = String(currentPage)
    canvas.dataset.page = String(currentPage)
    canvas.dataset.rendered = 'false'
    setRendering(true)
    setError(null)
    setAccessibleText('')
    async function render(): Promise<void> {
      try {
        const pdfPage = await pdf!.getPage(currentPage)
        if (cancelled) return
        const original = pdfPage.getViewport({ scale: 1 })
        const scale = Math.max(48, width - 48) / original.width * zoom
        const viewport = pdfPage.getViewport({ scale })
        const ratio = Math.min(window.devicePixelRatio || 1, 2,
          Math.sqrt(8_000_000 / (viewport.width * viewport.height)))
        canvas.width = Math.ceil(viewport.width * ratio)
        canvas.height = Math.ceil(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        canvas.style.display = 'block'
        canvas.style.background = '#fff'
        host!.replaceChildren(canvas)
        task = pdfPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
        await task.promise
        if (cancelled) return
        canvas.dataset.rendered = 'true'
        setRendering(false)
        const text = await pdfPage.getTextContent()
        if (!cancelled) setAccessibleText(text.items.map(item => 'str' in item ? item.str : '').join(' '))
      } catch (caught) {
        if (cancelled || caught instanceof Error && caught.name === 'RenderingCancelledException') return
        setError('当前页无法显示。请重试，或打开原文件。')
        setRendering(false)
        console.warn('PDF render failed:', caught instanceof Error ? caught.name : 'UnknownError')
      }
    }
    void render()
    return () => {
      cancelled = true
      task?.cancel()
      canvas.remove()
    }
  }, [pdf, currentPage, width, zoom, filename])

  const changePage = (requested: number) => {
    const next = boundPage(requested, pdf?.numPages ?? 1)
    setCurrentPage(next)
    setPageInput(String(next))
    if (pdf) notify.current?.(next, pdf.numPages)
    viewportRef.current?.scrollTo({ top: 0, left: 0 })
  }
  const ready = !!pdf && !loading && !rendering && !error
  return <div className="pdf-viewer" data-pdf-state={error ? 'error' : ready ? 'ready' : 'loading'} aria-busy={!ready && !error}>
    <div className="pdf-toolbar">
      <button className="tm-btn tm-btn-icon" type="button" aria-label="上一页" disabled={!pdf || currentPage <= 1} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={16} /></button>
      <input className="tm-pg" aria-label="PDF 页码" type="text" inputMode="numeric" disabled={!pdf} value={pageInput}
        onChange={event => setPageInput(event.target.value.replace(/\D/g, ''))} onBlur={() => { if (pageInput) changePage(Number(pageInput)); else setPageInput(String(currentPage)) }}
        onKeyDown={event => { if (event.key === 'Enter') changePage(Number(pageInput)) }} />
      <span className="tm-muted tm-num whitespace-nowrap">/ {pdf?.numPages ?? '—'}</span>
      <button className="tm-btn tm-btn-icon" type="button" aria-label="下一页" disabled={!pdf || currentPage >= pdf.numPages} onClick={() => changePage(currentPage + 1)}><ChevronRight size={16} /></button>
      <span className="pdf-toolbar-sep" aria-hidden="true" />
      <button className="tm-btn tm-btn-icon" type="button" aria-label="缩小 PDF" disabled={!pdf || zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}><Minus size={15} /></button>
      <span className="tm-num pdf-zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button className="tm-btn tm-btn-icon" type="button" aria-label="放大 PDF" disabled={!pdf || zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))}><Plus size={15} /></button>
      <button className="tm-btn tm-btn-sm" type="button" disabled={!pdf} onClick={() => setZoom(1)} aria-label="适合页面宽度">适合宽度</button>
      <span className="flex-1" />
      {toolbarEnd}
      {showOpenLink && <a className="tm-textlink inline-flex items-center gap-1" href={`${fileUrl}#page=${currentPage}`} target="_blank" rel="noopener noreferrer">原文件<ExternalLink size={13} /></a>}
    </div>
    <div ref={viewportRef} className="pdf-stage">
      {(loading || rendering) && !error && <div role="status" className="pdf-status">{loading ? '正在加载 PDF…' : '正在显示页面…'}</div>}
      {error && <div role="alert" className="pdf-error"><span>{error}</span><button className="tm-btn tm-btn-sm" type="button" onClick={() => setRetry(value => value + 1)}><RotateCcw size={13} />重试</button></div>}
      <div className="pdf-pad">
        <div className="pdf-sheet">
          <div ref={canvasHostRef} />
          {highlight && ready && <><div className="pdf-hl" aria-hidden="true" /><span className="pdf-hl-label" aria-hidden="true">{highlight.label}</span></>}
        </div>
      </div>
      {accessibleText && <p className="sr-only">{accessibleText}</p>}
    </div>
  </div>
}

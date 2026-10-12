import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, ExternalLink, Minus, Plus, RotateCcw } from 'lucide-react'

interface PdfCanvasProps {
  documentId: string
  page?: number | null
  filename: string
}

function boundPage(page: number, total: number): number {
  return Math.min(Math.max(Number.isFinite(page) ? Math.trunc(page) : 1, 1), Math.max(total, 1))
}

export function PdfCanvas({ documentId, page = 1, filename }: PdfCanvasProps) {
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

  useEffect(() => {
    if (pdf) setCurrentPage(boundPage(page ?? 1, pdf.numPages))
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
        const scale = Math.max(48, width - 32) / original.width * zoom
        const viewport = pdfPage.getViewport({ scale })
        const ratio = Math.min(window.devicePixelRatio || 1, 2,
          Math.sqrt(8_000_000 / (viewport.width * viewport.height)))
        canvas.width = Math.ceil(viewport.width * ratio)
        canvas.height = Math.ceil(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        canvas.style.display = 'block'
        canvas.style.background = '#fff'
        canvas.style.margin = '0 auto'
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
    viewportRef.current?.scrollTo({ top: 0, left: 0 })
  }
  const ready = !!pdf && !loading && !rendering && !error
  return <div className="pdf-viewer" data-pdf-state={error ? 'error' : ready ? 'ready' : 'loading'} aria-busy={!ready && !error}>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-white px-3 py-2">
      <div className="flex min-w-0 items-center gap-1">
        <button className="icon-button" type="button" aria-label="上一页" disabled={!pdf || currentPage <= 1} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={17} /></button>
        <input aria-label="PDF 页码" type="number" inputMode="numeric" min={1} max={pdf?.numPages ?? 1} disabled={!pdf} value={pageInput}
          onChange={event => setPageInput(event.target.value)} onBlur={() => changePage(Number(pageInput))}
          onKeyDown={event => { if (event.key === 'Enter') changePage(Number(pageInput)) }}
          style={{ width: 54, padding: '5px 6px', textAlign: 'center', fontSize: 13 }} />
        <span className="whitespace-nowrap px-1 text-sm text-neutral-600">/ {pdf?.numPages ?? '—'}</span>
        <button className="icon-button" type="button" aria-label="下一页" disabled={!pdf || currentPage >= pdf.numPages} onClick={() => changePage(currentPage + 1)}><ChevronRight size={17} /></button>
      </div>
      <div className="flex items-center gap-1">
        <button className="icon-button" type="button" aria-label="缩小 PDF" disabled={!pdf || zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}><Minus size={16} /></button>
        <button className="btn btn-ghost" type="button" disabled={!pdf} onClick={() => setZoom(1)} aria-label="适合页面宽度">{Math.round(zoom * 100)}%</button>
        <button className="icon-button" type="button" aria-label="放大 PDF" disabled={!pdf || zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))}><Plus size={16} /></button>
        <a className="text-link px-2 text-sm" href={`${fileUrl}#page=${currentPage}`} target="_blank" rel="noopener noreferrer">原文件<ExternalLink size={14} /></a>
      </div>
    </div>
    <div ref={viewportRef} className="relative min-h-0 min-w-0 flex-1 overflow-auto" style={{ background: '#ededed' }}>
      {(loading || rendering) && !error && <div role="status" className="absolute inset-x-0 top-0 z-10 bg-white/95 px-4 py-3 text-sm text-neutral-600">{loading ? '正在加载 PDF…' : '正在显示页面…'}</div>}
      {error && <div role="alert" className="m-4 flex flex-wrap items-center gap-3 rounded border border-neutral-300 bg-white p-4 text-sm"><span>{error}</span><button className="btn btn-secondary" type="button" onClick={() => setRetry(value => value + 1)}><RotateCcw size={14} />重试</button></div>}
      <div ref={canvasHostRef} className="p-4" style={{ minWidth: '100%', width: 'max-content' }} />
      {accessibleText && <p className="sr-only">{accessibleText}</p>}
    </div>
  </div>
}

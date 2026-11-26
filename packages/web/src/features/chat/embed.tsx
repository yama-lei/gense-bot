// Workspace files a reply shows or points at: `![receipt](attachments/receipt.png)`, `![p. 3](report.pdf#page=3)`
// and `[contract](attachments/contract.pdf#page=3)`. Bytes come over the socket and are drawn from blob URLs.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { FileText, ImageOff } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useClient, type Client } from '../../app/client'
import { baseName } from '../../lib/format'
import { cn } from '../../lib/cn'

/** What a chat gives the Markdown inside it; without it (a shared page) workspace references stay text. */
export interface FileRefs {
  treeId: string
  open: (path: string, page?: number) => void
}
export const FileRefsContext = createContext<FileRefs | null>(null)

export interface WorkspaceRef {
  path: string
  page?: number
}

/** An href or src that names a workspace file rather than a web resource: no scheme, not an in-page anchor. */
export function workspaceRef(href: string | undefined): WorkspaceRef | null {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  const at = href.indexOf('#')
  const raw = at < 0 ? href : href.slice(0, at)
  let path = raw
  try {
    path = decodeURI(raw)
  } catch {
    /* Not percent-encoded; use it as written. */
  }
  path = path.replace(/^\.\//, '')
  if (!path) return null
  const page = Number(/(?:^|&)page=(\d+)/.exec(at < 0 ? '' : href.slice(at + 1))?.[1]) || undefined
  return { path, ...(page && { page }) }
}

/** The absolute path the file panel lists: relative paths are inside the conversation's workspace. */
export const absolutePath = (treeId: string, path: string) => (path.startsWith('/') ? path : `/data/sessions/${treeId}/${path}`)

export const isPdf = (path: string) => /\.pdf$/i.test(path)
export const isImage = (path: string) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path)

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Kept for the page's lifetime: the same picture is often shown again in a later turn or the panel.
const blobs = new Map<string, Promise<string>>()
const pdfs = new Map<string, Promise<PDFDocumentProxy>>()

export function fileUrl(client: Client, treeId: string, path: string, version = '') {
  const key = `${treeId}\0${path}\0${version}`
  let url = blobs.get(key)
  if (!url) {
    url = client.readFile(treeId, path).then((f) => URL.createObjectURL(f.blob))
    blobs.set(key, url)
    url.catch(() => blobs.delete(key))
  }
  return url
}

let pdfjs: Promise<typeof import('pdfjs-dist')> | undefined
function loadPdfjs() {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
  })
  return pdfjs
}

export function pdfDocument(client: Client, treeId: string, path: string, version = '') {
  const key = `${treeId}\0${path}\0${version}`
  let doc = pdfs.get(key)
  if (!doc) {
    doc = Promise.all([loadPdfjs(), client.readFile(treeId, path).then((f) => f.blob.arrayBuffer())]).then(([lib, data]) => lib.getDocument({ data: new Uint8Array(data) }).promise)
    pdfs.set(key, doc)
    doc.catch(() => pdfs.delete(key))
  }
  return doc
}

export function useLoaded<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ value?: T; error?: boolean }>({})
  useEffect(() => {
    let live = true
    setState({})
    load().then(
      (value) => live && setState({ value }),
      () => live && setState({ error: true }),
    )
    return () => {
      live = false
    }
  }, deps)
  return state
}

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One PDF page on a canvas, as wide as its box; drawn when it nears the viewport. */
export function PdfPage({ doc, page, className }: { doc: PDFDocumentProxy; page: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [ratio, setRatio] = useState<number>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let task: { cancel: () => void } | undefined
    let live = true
    const draw = () =>
      doc
        .getPage(page)
        .then((p) => {
          if (!live) return
          const base = p.getViewport({ scale: 1 })
          setRatio(base.width / base.height)
          const width = el.parentElement?.clientWidth || 640
          const viewport = p.getViewport({ scale: (width / base.width) * Math.min(devicePixelRatio || 1, 2) })
          el.width = Math.floor(viewport.width)
          el.height = Math.floor(viewport.height)
          const render = p.render({ canvas: el, viewport })
          task = render
          return render.promise
        })
        .catch((e: unknown) => {
          if (live && (e as { name?: string })?.name !== 'RenderingCancelledException') setFailed(true)
        })
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        seen.disconnect()
        void draw()
      },
      { rootMargin: '600px' },
    )
    seen.observe(el)
    return () => {
      live = false
      seen.disconnect()
      task?.cancel()
    }
  }, [doc, page])
  if (failed) return <Missing>第 {page} 页无法显示</Missing>
  return <canvas ref={canvas} className={cn('block h-auto w-full bg-white', className)} style={{ aspectRatio: ratio ?? 1 / Math.SQRT2 }} />
}

function Missing({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-sm text-muted-foreground">
      <ImageOff className="size-4 shrink-0" />
      {children}
    </span>
  )
}

/** `![alt](path)` for a workspace file: the image, or the PDF page, with its caption; a click opens it beside the chat. */
export function Embed({ src, alt }: { src?: string; alt?: string }) {
  const refs = useContext(FileRefsContext)
  const ref = workspaceRef(src)
  if (!ref) return <img src={src} alt={alt} loading="lazy" />
  const name = baseName(ref.path)
  if (!refs || (!isPdf(ref.path) && !isImage(ref.path)))
    return (
      <span className="text-muted-foreground">
        [{alt || name}
        {ref.page ? ` · 第 ${ref.page} 页` : ''}]
      </span>
    )
  const caption = alt || (ref.page ? `${name} · 第 ${ref.page} 页` : name)
  return (
    <span className="embed my-3 block">
      <button
        type="button"
        title={`打开 ${ref.path}`}
        onClick={() => refs.open(ref.path, ref.page)}
        className="block max-w-full cursor-zoom-in overflow-hidden rounded-xl border bg-muted/40 text-left transition-shadow hover:shadow-md"
      >
        {isPdf(ref.path) ? <PdfEmbed treeId={refs.treeId} path={ref.path} page={ref.page ?? 1} /> : <ImageEmbed treeId={refs.treeId} path={ref.path} alt={caption} />}
      </button>
      <span className="mt-1.5 block text-xs text-muted-foreground">{caption}</span>
    </span>
  )
}

function ImageEmbed({ treeId, path, alt }: { treeId: string; path: string; alt: string }) {
  const client = useClient()
  const { value: url, error } = useLoaded(() => fileUrl(client, treeId, path), [client, treeId, path])
  if (error) return <Missing>无法显示图片 {path}</Missing>
  if (!url) return <span className="block h-48 w-72 max-w-full animate-pulse bg-muted" />
  return <img src={url} alt={alt} className="!m-0 block max-h-[28rem] !rounded-none object-contain" />
}

function PdfEmbed({ treeId, path, page }: { treeId: string; path: string; page: number }) {
  const client = useClient()
  const { value: doc, error } = useLoaded(() => pdfDocument(client, treeId, path), [client, treeId, path])
  if (error) return <Missing>无法显示 PDF {path}</Missing>
  if (!doc) return <span className="block aspect-[1/1.414] w-80 max-w-full animate-pulse bg-muted" />
  if (page > doc.numPages) return <Missing>{baseName(path)} 只有 {doc.numPages} 页</Missing>
  return (
    <span className="block w-[28rem] max-w-full">
      <PdfPage doc={doc} page={page} />
    </span>
  )
}

/** `[text](path)` for a workspace file: a chip that opens the file (at its page) beside the chat. */
export function FileLink({ href, children }: { href: string; children: ReactNode }) {
  const refs = useContext(FileRefsContext)
  const ref = workspaceRef(href)!
  if (!refs) return <span className="underline decoration-dotted">{children}</span>
  return (
    <button
      type="button"
      title={`打开 ${ref.path}${ref.page ? ` 第 ${ref.page} 页` : ''}`}
      onClick={() => refs.open(ref.path, ref.page)}
      className="mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-md bg-muted px-1.5 align-baseline text-[0.9em] text-foreground hover:bg-hover"
    >
      <FileText className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
      <span className="truncate">{children}</span>
    </button>
  )
}

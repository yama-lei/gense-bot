// A conversation's files: what the assistant wrote or the user attached, and the Skills it can read.
import type { FileEntry, FilePreview } from '@gense/protocol'
import { ChevronLeft, ChevronRight, Download, FileText, Trash2 } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { report, useClient } from '../../app/client'
import { cn } from '../../lib/cn'
import { baseName, errorText, formatBytes, formatTime } from '../../lib/format'
import { Button } from '../../ui/button'
import { ConfirmDialog } from '../../ui/dialog'
import { Notice, Skeleton, Spinner } from '../../ui/feedback'
import { fileUrl, isImage, isPdf, PdfPage, pdfDocument, useLoaded } from './embed'

/** A file's path as the panel shows it: inside the workspace, or inside the Skills folder. */
function shortPath(f: FileEntry, treeId: string) {
  const at = f.path.indexOf(`/${treeId}/`)
  if (at >= 0) return f.path.slice(at + treeId.length + 2)
  return f.path.replace(/^\/data\/(skills\/)?/, '')
}

export function WorkspacePanel({ treeId, files, open, page, onOpen }: { treeId: string; files: FileEntry[] | undefined; open: string | null; page?: number; onOpen: (path: string | null) => void }) {
  // The file may be deleted by the assistant or the user while it is open.
  const current = open ? files?.find((f) => f.path === open) : undefined
  // Keyed by mtime so a rewrite by the assistant reloads the preview.
  if (current) return <Preview key={current.path + current.mtime} treeId={treeId} file={current} page={page} onBack={() => onOpen(null)} />
  if (!files)
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    )
  const own = files.filter((f) => !f.readOnly)
  const skills = files.filter((f) => f.readOnly)
  // Skills ship many files; grouped by Skill and folded, so the conversation's own files stay in view.
  const bySkill = new Map<string, FileEntry[]>()
  for (const f of skills) {
    const name = shortPath(f, treeId).split('/')[0]
    bySkill.set(name, [...(bySkill.get(name) ?? []), f])
  }
  const row = (f: FileEntry, label: string) => (
    <li key={f.path}>
      <button type="button" title={f.path} onClick={() => onOpen(f.path)} className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
      </button>
    </li>
  )
  return (
    <div className="flex flex-col gap-6 p-4">
      <section>
        <h3 className="text-sm font-medium">工作区</h3>
        <p className="mb-2 text-xs text-muted-foreground">本对话的文件，助手可以读写。</p>
        {own.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-4 text-sm text-muted-foreground">还没有文件。让助手"写成文件"，或者发送附件，它们会出现在这里。</p>
        ) : (
          <ul className="-mx-2">{own.map((f) => row(f, shortPath(f, treeId)))}</ul>
        )}
      </section>
      <details className="group/skills">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium">
          <ChevronRight className="size-4 text-muted-foreground transition-transform group-open/skills:rotate-90" />
          Skills
          <span className="text-xs font-normal text-muted-foreground">
            {bySkill.size} 个 · {skills.length} 个文件，只读
          </span>
        </summary>
        {skills.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed px-3 py-4 text-sm text-muted-foreground">没有启用的 Skill。</p>
        ) : (
          <div className="mt-2 flex flex-col">
            {[...bySkill].map(([name, list]) => (
              <details key={name} className="group/skill">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-1.5 text-sm hover:bg-hover">
                  <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/skill:rotate-90" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="text-xs text-muted-foreground">{list.length}</span>
                </summary>
                <ul className="ml-3">{list.map((f) => row(f, shortPath(f, treeId).slice(name.length + 1)))}</ul>
              </details>
            ))}
          </div>
        )}
      </details>
    </div>
  )
}

function Preview({ treeId, file, page, onBack }: { treeId: string; file: FileEntry; page?: number; onBack: () => void }) {
  const client = useClient()
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const visual = isImage(file.path) || isPdf(file.path)
  useEffect(() => {
    if (visual) return
    let live = true
    client.previewFile(treeId, file.path).then(
      (p) => live && setPreview(p),
      (e: unknown) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [client, treeId, file.path, visual])

  const remove = () => {
    setBusy(true)
    client.deleteFile(treeId, file.path).then(onBack, (e: unknown) => {
      setBusy(false)
      report(e)
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="返回文件列表" onClick={onBack}>
          <ChevronLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={file.path}>
            {baseName(file.path)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {formatBytes(file.size)} · {formatTime(file.mtime)}
            {file.readOnly && ' · 只读'}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="下载" onClick={() => void client.downloadFile(treeId, file.path).catch(report)}>
          <Download />
        </Button>
        {!file.readOnly && (
          <Button variant="ghost-destructive" size="icon-sm" aria-label="删除" disabled={busy} onClick={() => setConfirming(true)}>
            <Trash2 />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isPdf(file.path) ? (
          <PdfPages treeId={treeId} file={file} page={page} />
        ) : isImage(file.path) ? (
          <ImageView treeId={treeId} file={file} />
        ) : error ? (
          <Notice tone="error">{error}</Notice>
        ) : !preview ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> 正在读取…
          </div>
        ) : preview.binary ? (
          <Notice>这是二进制文件，不能预览，请下载查看。</Notice>
        ) : (
          <>
            <pre className="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">{preview.text}</pre>
            {preview.truncated && <p className="mt-3 text-xs text-muted-foreground">只显示了开头 {formatBytes(preview.text.length)}，完整内容请下载。</p>}
          </>
        )}
      </div>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={`删除 ${baseName(file.path)}？`} confirm="删除" onConfirm={remove}>
        删除后不能恢复，助手也读不到它了。
      </ConfirmDialog>
    </div>
  )
}

function ImageView({ treeId, file }: { treeId: string; file: FileEntry }) {
  const client = useClient()
  const { value: url, error } = useLoaded(() => fileUrl(client, treeId, file.path, String(file.mtime)), [client, treeId, file.path, file.mtime])
  if (error) return <Notice tone="error">读取图片失败，请下载查看。</Notice>
  if (!url) return <Skeleton className="aspect-[4/3] w-full" />
  return <img src={url} alt={baseName(file.path)} className="mx-auto block max-w-full rounded-lg border" />
}

/** Every page of a PDF, drawn as they scroll into view; `page` is scrolled to first. */
function PdfPages({ treeId, file, page }: { treeId: string; file: FileEntry; page?: number }) {
  const client = useClient()
  const { value: doc, error } = useLoaded(() => pdfDocument(client, treeId, file.path, String(file.mtime)), [client, treeId, file.path, file.mtime])
  if (error) return <Notice tone="error">无法打开这个 PDF，请下载查看。</Notice>
  if (!doc) return <Skeleton className="aspect-[1/1.414] w-full" />
  return <PdfDoc doc={doc} page={page} />
}

function PdfDoc({ doc, page }: { doc: PDFDocumentProxy; page?: number }) {
  const target = useRef<HTMLDivElement>(null)
  // Braces: newer browsers return a promise here, and React would call it as a cleanup.
  useEffect(() => {
    target.current?.scrollIntoView({ block: 'start' })
  }, [page])
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1)
  return (
    <div className="flex flex-col gap-4">
      {pages.map((n) => (
        <div key={n} ref={n === page ? target : undefined} className={cn('scroll-mt-2', n === page && 'rounded-sm ring-2 ring-accent ring-offset-4 ring-offset-background')}>
          <PdfPage doc={doc} page={n} className="rounded-sm border shadow-sm" />
          <div className="mt-1 text-center text-xs text-muted-foreground">
            {n} / {doc.numPages}
          </div>
        </div>
      ))}
    </div>
  )
}

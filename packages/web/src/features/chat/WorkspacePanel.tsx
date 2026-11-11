// A conversation's files: what the assistant wrote or the user attached, and the Skills it can read.
import type { FileEntry, FilePreview } from '@gense/protocol'
import { ChevronLeft, Download, FileText, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { report, useClient } from '../../app/client'
import { baseName, errorText, formatBytes, formatTime } from '../../lib/format'
import { Button } from '../../ui/button'
import { ConfirmDialog } from '../../ui/dialog'
import { Notice, Skeleton, Spinner } from '../../ui/feedback'

/** A file's path as the panel shows it: inside the workspace, or inside the Skills folder. */
function shortPath(f: FileEntry, treeId: string) {
  const at = f.path.indexOf(`/${treeId}/`)
  if (at >= 0) return f.path.slice(at + treeId.length + 2)
  return f.path.replace(/^\/data\/(skills\/)?/, '')
}

export function WorkspacePanel({ treeId, files, open, onOpen }: { treeId: string; files: FileEntry[] | undefined; open: string | null; onOpen: (path: string | null) => void }) {
  // The file may be deleted by the assistant or the user while it is open.
  const current = open ? files?.find((f) => f.path === open) : undefined
  // Keyed by mtime so a rewrite by the assistant reloads the preview.
  if (current) return <Preview key={current.path + current.mtime} treeId={treeId} file={current} onBack={() => onOpen(null)} />
  if (!files)
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    )
  const sections = [
    { label: '工作区', hint: '本对话的文件，助手可以读写。', empty: '还没有文件。让助手"写成文件"，或者发送附件，它们会出现在这里。', list: files.filter((f) => !f.readOnly) },
    { label: 'Skills', hint: '只读，来自已启用的 Skill。', empty: '没有启用的 Skill。', list: files.filter((f) => f.readOnly) },
  ]
  return (
    <div className="flex flex-col gap-6 p-4">
      {sections.map((s) => (
        <section key={s.label}>
          <h3 className="text-sm font-medium">{s.label}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{s.hint}</p>
          {s.list.length === 0 ? (
            <p className="rounded-xl border border-dashed px-3 py-4 text-sm text-muted-foreground">{s.empty}</p>
          ) : (
            <ul className="-mx-2">
              {s.list.map((f) => (
                <li key={f.path}>
                  <button type="button" title={f.path} onClick={() => onOpen(f.path)} className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{shortPath(f, treeId)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

function Preview({ treeId, file, onBack }: { treeId: string; file: FileEntry; onBack: () => void }) {
  const client = useClient()
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    client.previewFile(treeId, file.path).then(
      (p) => live && setPreview(p),
      (e: unknown) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [client, treeId, file.path])

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
        {error ? (
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

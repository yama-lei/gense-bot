// Projects (roadmap-7 A7–A11): conversations that belong together, with instructions and files the assistant sees in
// every one of them. The server keeps them; its `projects` message and each tree's `projectId` are the truth.
import type { FileEntry, Project, TreeMeta } from '@gense/protocol'
import { PROJECT_LIMITS, projectDir } from '@gense/protocol'
import { ArrowLeft, Download, Ellipsis, FileText, FolderClosed, FolderPlus, MessageCircle, Paperclip, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { MAX_UPLOAD, report, useClient, useHost, useProjects } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { errorText, formatBytes, formatTime } from '../../lib/format'
import { projectColors } from '../../lib/lab'
import { Link, navigate } from '../../lib/router'
import type { Outgoing } from '../../lib/types'
import { Button } from '../../ui/button'
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter } from '../../ui/dialog'
import { Empty, Notice, Skeleton, Spinner } from '../../ui/feedback'
import { Field, Input, Textarea } from '../../ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '../../ui/menu'
import { Composer } from '../chat/Composer'

const templates = [
  { name: '读书笔记', instructions: '这是我的读书笔记项目。回答时联系我之前读过的内容，结尾给出一个值得思考的问题。' },
  { name: '产品调研', instructions: '这是一个产品调研项目。结论先行，数据注明来源，对比尽量用表格。' },
  { name: '代码助手', instructions: '这是一个编程项目。默认使用 TypeScript，代码要能直接运行，先给方案再给实现。' },
]

function Swatch({ color, className }: { color: number; className?: string }) {
  return (
    <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl text-white', className)} style={{ background: projectColors[color] }}>
      <FolderClosed className="size-5" />
    </span>
  )
}

function ProjectDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (v: boolean) => void; project?: Project }) {
  const [name, setName] = useState(project?.name ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [color, setColor] = useState(project?.color ?? (useProjects()?.length ?? 0) % projectColors.length)
  const [saving, setSaving] = useState(false)
  const client = useClient()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || saving) return
    const fields = { name: name.trim(), instructions: instructions.trim(), color }
    if (project) {
      client.updateProject(project.id, fields)
      onOpenChange(false)
      return
    }
    setSaving(true)
    client.createProject(fields).then(
      (made) => {
        onOpenChange(false)
        navigate({ name: 'projects', id: made.id })
      },
      (e: unknown) => {
        setSaving(false)
        report(e)
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={project ? '项目设置' : '新建项目'} description="项目把相关的对话放在一起，并让它们共用一份指令。">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogBody className="flex flex-col gap-4">
            <Field label="名称">
              <Input autoFocus value={name} maxLength={PROJECT_LIMITS.name} onChange={(e) => setName(e.target.value)} placeholder="例如：毕业论文" />
            </Field>
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">颜色</span>
              <div role="radiogroup" aria-label="颜色" className="flex gap-2">
                {projectColors.map((c, i) => (
                  <button key={c} type="button" role="radio" aria-checked={color === i} aria-label={`颜色 ${i + 1}`} onClick={() => setColor(i)} className={cn('size-7 rounded-full ring-offset-2 ring-offset-popover', color === i && 'ring-2 ring-foreground')} style={{ background: c }} />
                ))}
              </div>
            </div>
            <Field label="项目指令" help="项目里的每个对话都会遵循它，改了以后下一条消息就生效。">
              <Textarea value={instructions} rows={6} maxLength={PROJECT_LIMITS.instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="这个项目是关于什么的？希望 Gense 怎样回答？" />
            </Field>
            {!project && (
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="text-xs text-muted-foreground">从模板开始：</span>
                {templates.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => {
                      setName(t.name)
                      setInstructions(t.instructions)
                    }}
                    className="rounded-full border px-2.5 py-0.5 hover:bg-hover"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || saving}>
              {saving && <Spinner />}
              {project ? '保存' : '创建项目'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ProjectList() {
  const projects = useProjects()
  const { trees } = useHost()
  const [creating, setCreating] = useState(false)
  const counts = new Map<string, number>()
  for (const t of trees ?? []) if (t.projectId) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1)

  return (
    <Page
      wide
      title="项目"
      description="把相关的对话放进一个项目，给它们一份共同的指令和资料。"
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <FolderPlus /> 新建项目
        </Button>
      }
    >
      {!projects ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Empty
          icon={<FolderClosed />}
          title="还没有项目"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> 新建项目
            </Button>
          }
        >
          论文、调研、一个长期的代码库——任何会聊很多次的事，都值得一个项目。
        </Empty>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const count = counts.get(p.id) ?? 0
            return (
              <li key={p.id}>
                <Link to={{ name: 'projects', id: p.id }} className="flex h-full min-h-36 flex-col gap-3 rounded-2xl border bg-card p-4 transition-[border-color,box-shadow] hover:border-input hover:shadow-float">
                  <Swatch color={p.color} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{p.instructions || '没有项目指令'}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MessageCircle className="size-3.5" /> {count} 个对话 · 创建于 {formatTime(p.createdAt)}
                  </span>
                </Link>
              </li>
            )
          })}
          <li>
            <button type="button" onClick={() => setCreating(true)} className="flex h-full min-h-36 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
              <Plus className="size-5" /> 新建项目
            </button>
          </li>
        </ul>
      )}
      {creating && <ProjectDialog open onOpenChange={setCreating} />}
    </Page>
  )
}

function ProjectDetail({ project }: { project: Project }) {
  const client = useClient()
  const { trees } = useHost()
  const [starting, setStarting] = useState(false)
  const [seed, setSeed] = useState<{ text: string; key: number }>()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const inside = (trees ?? []).filter((t) => t.projectId === project.id).sort((a, b) => b.updatedAt - a.updatedAt)
  const loose = (trees ?? []).filter((t) => !t.projectId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12)

  // The server adds the project's instructions and files to the prompt of every conversation in it.
  const start = (message: Outgoing) => {
    setStarting(true)
    client.start(message, { projectId: project.id }).then(
      (id) => navigate({ name: 'chat', id }),
      (e: unknown) => {
        setStarting(false)
        setSeed({ text: message.text, key: Date.now() })
        report(e)
      },
    )
  }

  return (
    <Page
      title={project.name}
      eyebrow={
        <>
          <Link to={{ name: 'projects' }} className="flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-3.5" /> 项目
          </Link>
        </>
      }
      actions={
        <>
          <Button onClick={() => setEditing(true)}>项目设置</Button>
          <Button variant="ghost-destructive" size="icon" aria-label="删除项目" onClick={() => setDeleting(true)}>
            <Trash2 />
          </Button>
        </>
      }
    >
      <Composer placeholder={`在「${project.name}」里开始新对话…`} onSend={start} busy={starting} seed={seed} draftKey={`project:${project.id}`} />

      <button type="button" onClick={() => setEditing(true)} className="mt-4 flex w-full items-start gap-3 rounded-2xl border bg-card p-4 text-left transition-colors hover:border-input">
        <Swatch color={project.color} className="size-9" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">项目指令</span>
          <span className="mt-0.5 line-clamp-3 text-sm whitespace-pre-wrap text-muted-foreground">{project.instructions || '还没有指令。点这里写下这个项目是关于什么的，Gense 会在项目的每个对话里遵循。'}</span>
        </span>
      </button>

      <ProjectFiles project={project} />

      <div className="mt-8 mb-2 flex items-center justify-between px-1">
        <h2 className="text-sm font-medium">对话 · {inside.length}</h2>
        {loose.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <Plus /> 加入已有对话
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>最近的对话</DropdownMenuLabel>
              {loose.map((t) => (
                <DropdownMenuItem key={t.id} onSelect={() => client.moveToProject(t.id, project.id)}>
                  <MessageCircle /> <span className="truncate">{t.title || '新对话'}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {inside.length === 0 ? (
        <Empty title="这个项目里还没有对话" icon={<MessageCircle />}>
          在上面发一条消息，或把已有的对话加进来。
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">
          {inside.map((t) => (
            <ChatRow key={t.id} tree={t} />
          ))}
        </ul>
      )}

      {editing && <ProjectDialog open onOpenChange={setEditing} project={project} />}
      {deleting && <DeleteProject project={project} chats={inside.length} onOpenChange={setDeleting} />}
    </Page>
  )
}

function DeleteProject({ project, chats, onOpenChange }: { project: Project; chats: number; onOpenChange: (v: boolean) => void }) {
  const client = useClient()
  const [busy, setBusy] = useState<'keep' | 'all' | null>(null)
  const remove = (deleteChats: boolean) => {
    setBusy(deleteChats ? 'all' : 'keep')
    client.deleteProject(project.id, deleteChats).then(
      () => navigate({ name: 'projects' }, { replace: true }),
      (e: unknown) => {
        setBusy(null)
        report(e)
      },
    )
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title={`删除项目「${project.name}」？`}
        description={chats > 0 ? `项目的指令、文件和只属于它的记忆会被删除。里面的 ${chats} 个对话怎么处理？` : '项目的指令、文件和只属于它的记忆会被删除，无法恢复。'}
        hideClose
        className="sm:max-w-md"
      >
        <DialogFooter className="border-t-0 pt-1 pb-4">
          <DialogClose asChild>
            <Button disabled={!!busy}>取消</Button>
          </DialogClose>
          {chats > 0 && (
            <Button disabled={!!busy} onClick={() => remove(false)}>
              {busy === 'keep' && <Spinner />}保留对话
            </Button>
          )}
          <Button variant="destructive" disabled={!!busy} onClick={() => remove(true)}>
            {busy === 'all' && <Spinner />}
            {chats > 0 ? '连同对话一起删除' : '删除项目'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The project's files: the assistant reads them, read-only, in every conversation of the project (A9). */
function ProjectFiles({ project }: { project: Project }) {
  const client = useClient()
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const dir = `${projectDir(project.id)}/`

  const load = useCallback(() => {
    setError(null)
    client.projectFiles(project.id).then(setFiles, (e: unknown) => setError(errorText(e)))
  }, [client, project.id])
  useEffect(load, [load])

  const add = async (picked: File[]) => {
    const big = picked.find((f) => f.size > MAX_UPLOAD)
    if (big) return report(new Error(`${big.name} 超过 20 MB`))
    if (picked.length === 0) return
    setUploading(picked.length)
    try {
      const ids = await Promise.all(picked.map((f) => client.upload(f).then((a) => a.id)))
      setFiles(await client.addProjectFiles(project.id, ids))
    } catch (e) {
      report(e)
    } finally {
      setUploading(0)
    }
  }

  const remove = (path: string) => {
    setFiles((all) => all?.filter((f) => f.path !== path) ?? null)
    client.deleteProjectFile(project.id, path).catch((e: unknown) => {
      report(e)
      load()
    })
  }

  const used = files?.reduce((n, f) => n + f.size, 0) ?? 0

  return (
    <section
      className={cn('mt-4 rounded-2xl border bg-card', dragging && 'ring-2 ring-accent')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void add([...e.dataTransfer.files])
      }}
    >
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">项目文件</span>
          <span className="block text-sm text-muted-foreground">Gense 在这个项目的每个对话里都能读到它们（只读）。</span>
        </span>
        <input ref={input} type="file" multiple hidden onChange={(e) => void add([...(e.target.files ?? [])]).finally(() => (e.target.value = ''))} />
        <Button size="sm" onClick={() => input.current?.click()} disabled={uploading > 0}>
          {uploading > 0 ? <Spinner /> : <Paperclip />} {uploading > 0 ? `上传 ${uploading} 个…` : '添加文件'}
        </Button>
      </div>
      {error ? (
        <Notice tone="error" className="mx-4 mb-4" action={<Button size="sm" onClick={load}>重试</Button>}>
          {error}
        </Notice>
      ) : !files ? (
        <div className="flex flex-col gap-2 px-4 pb-4">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : files.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">把论文、需求文档、代码或数据拖到这里。单个文件不超过 20 MB。</p>
      ) : (
        <>
          <ul className="divide-y border-t">
            {files.map((f) => (
              <li key={f.path} className="group flex items-center gap-3 px-4 py-2">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{f.path.replace(dir, '')}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(f.size)}</span>
                <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                  <Button variant="ghost" size="icon-sm" aria-label="下载" onClick={() => void client.readProjectFile(project.id, f.path).catch(report)}>
                    <Download />
                  </Button>
                  <Button variant="ghost-destructive" size="icon-sm" aria-label="删除" onClick={() => remove(f.path)}>
                    <Trash2 />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            {files.length} 个文件 · {formatBytes(used)} / {formatBytes(PROJECT_LIMITS.files)}
          </p>
        </>
      )}
    </section>
  )
}

function ChatRow({ tree }: { tree: TreeMeta }) {
  const client = useClient()
  return (
    <li className="group flex items-center hover:bg-hover">
      <Link to={{ name: 'chat', id: tree.id }} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4">
        <MessageCircle className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{tree.title || '新对话'}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatTime(tree.updatedAt)}</span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="更多" className="mx-2 text-muted-foreground">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => client.moveToProject(tree.id, null)}>
            <X /> 移出项目
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export default function ProjectsPage({ id }: { id?: string }) {
  const projects = useProjects()
  if (!id) return <ProjectList />
  if (!projects)
    return (
      <Page title="">
        <Skeleton className="h-28 rounded-2xl" />
      </Page>
    )
  const project = projects.find((p) => p.id === id)
  if (!project)
    return (
      <Page title="找不到这个项目">
        <Empty
          title="项目不存在"
          action={
            <Button asChild variant="primary">
              <Link to={{ name: 'projects' }}>查看全部项目</Link>
            </Button>
          }
        >
          它可能已经被删除了。
        </Empty>
      </Page>
    )
  return <ProjectDetail key={project.id} project={project} />
}

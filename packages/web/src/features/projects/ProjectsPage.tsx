// Projects: conversations that belong together, with instructions every new one starts from. Which conversation is
// in which project lives in this browser (lib/lab.ts); the instructions reach the model as the first message's
// command, which the server already understands.
import type { TreeMeta } from '@gense/protocol'
import { ArrowLeft, Ellipsis, FolderClosed, FolderPlus, MessageCircle, Plus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { report, useClient, useHost } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { formatTime } from '../../lib/format'
import { createProject, deleteProject, moveToProject, projectColors, projectOf, updateProject, useProjects, type Project } from '../../lib/lab'
import { Link, navigate } from '../../lib/router'
import type { Outgoing } from '../../lib/types'
import { PreviewBadge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '../../ui/dialog'
import { Empty } from '../../ui/feedback'
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
  const [color, setColor] = useState(project?.color ?? 0)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    if (project) updateProject(project.id, { name: name.trim(), instructions: instructions.trim(), color })
    else {
      const made = createProject(name.trim(), instructions.trim())
      updateProject(made.id, { color })
      navigate({ name: 'projects', id: made.id })
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={project ? '项目设置' : '新建项目'} description="项目把相关的对话放在一起，并让它们共用一份指令。">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogBody className="flex flex-col gap-4">
            <Field label="名称">
              <Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="例如：毕业论文" />
            </Field>
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">颜色</span>
              <div role="radiogroup" aria-label="颜色" className="flex gap-2">
                {projectColors.map((c, i) => (
                  <button key={c} type="button" role="radio" aria-checked={color === i} aria-label={`颜色 ${i + 1}`} onClick={() => setColor(i)} className={cn('size-7 rounded-full ring-offset-2 ring-offset-popover', color === i && 'ring-2 ring-foreground')} style={{ background: c }} />
                ))}
              </div>
            </div>
            <Field label="项目指令" help="项目里每个新对话的第一条消息都会带上它。">
              <Textarea value={instructions} rows={5} maxLength={4000} onChange={(e) => setInstructions(e.target.value)} placeholder="这个项目是关于什么的？希望 Gense 怎样回答？" />
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
            <Button type="submit" variant="primary" disabled={!name.trim()}>
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
  const alive = new Set((trees ?? []).map((t) => t.id))

  return (
    <Page
      wide
      title="项目"
      eyebrow={<PreviewBadge />}
      description="把相关的对话放进一个项目，给它们一份共同的指令。项目目前保存在这个浏览器里。"
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <FolderPlus /> 新建项目
        </Button>
      }
    >
      {projects.length === 0 ? (
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
            const count = p.treeIds.filter((id) => trees === null || alive.has(id)).length
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
  const all = useProjects()
  const [starting, setStarting] = useState(false)
  const [seed, setSeed] = useState<{ text: string; key: number }>()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const inside = project.treeIds.flatMap((id) => trees?.find((t) => t.id === id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)
  const loose = [...(trees ?? [])].filter((t) => !projectOf(all, t.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12)

  const start = (message: Outgoing) => {
    setStarting(true)
    // The project's instructions ride on the first message, unless it already carries a command of its own.
    const first: Outgoing = !message.command && project.instructions ? { ...message, command: { id: `project:${project.id}`, label: project.name, prompt: `这个对话属于项目「${project.name}」。项目指令：\n${project.instructions}` } } : message
    client.start(first).then(
      (id) => {
        moveToProject(id, project.id)
        navigate({ name: 'chat', id })
      },
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
          <PreviewBadge />
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
          <span className="mt-0.5 line-clamp-3 text-sm whitespace-pre-wrap text-muted-foreground">{project.instructions || '还没有指令。点这里写下这个项目是关于什么的，Gense 会在每个新对话里遵循。'}</span>
        </span>
      </button>

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
                <DropdownMenuItem key={t.id} onSelect={() => moveToProject(t.id, project.id)}>
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
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除项目「${project.name}」？`}
        confirm="删除项目"
        onConfirm={() => {
          deleteProject(project.id)
          navigate({ name: 'projects' }, { replace: true })
        }}
      >
        项目里的对话不会删除，只是不再属于任何项目。
      </ConfirmDialog>
    </Page>
  )
}

function ChatRow({ tree }: { tree: TreeMeta }) {
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
          <DropdownMenuItem onSelect={() => moveToProject(tree.id, null)}>
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
          它可能已经删除，或者保存在另一个浏览器里。
        </Empty>
      </Page>
    )
  return <ProjectDetail key={project.id} project={project} />
}

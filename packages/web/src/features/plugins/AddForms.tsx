// Adding things from the plugins page: Skills from Git or a zip, and MCP presets that need a value first (B4).
import { fillTemplate, type DiscoverInstall, type DiscoverItem, type SkillInfo, type SkillSource } from '@gense/protocol'
import { Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { MAX_UPLOAD, useClient } from '../../app/client'
import { errorText } from '../../lib/format'
import { Button } from '../../ui/button'
import { DialogBody, DialogFooter } from '../../ui/dialog'
import { Notice } from '../../ui/feedback'
import { Field, Input } from '../../ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'

export function InstallForm({ initial = 'git', onDone }: { initial?: 'git' | 'zip'; onDone: () => void }) {
  const client = useClient()
  const input = useRef<HTMLInputElement>(null)
  const [from, setFrom] = useState<'git' | 'zip'>(initial)
  const [git, setGit] = useState('')
  const [ref, setRef] = useState('')
  const [path, setPath] = useState('')
  const [zip, setZip] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<SkillInfo[] | null>(null)
  const valid = from === 'git' ? /^(https?:\/\/|git@)\S+$/.test(git.trim()) : !!zip && zip.size <= MAX_UPLOAD

  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      const source: SkillSource =
        from === 'git' ? { git: git.trim(), ...(ref.trim() && { ref: ref.trim() }), ...(path.trim() && { path: path.trim() }) } : { upload: (await client.upload(zip!)).id }
      setAdded(await client.request<SkillInfo[]>({ t: 'skill.install', source }))
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  if (added)
    return (
      <>
        <DialogBody>
          <Notice title={added.length ? `已安装 ${added.length} 个 Skill` : '来源里没有找到 Skill'}>
            {added.length ? added.map((s) => s.name).join('、') : '需要至少一个带 SKILL.md 的文件夹。'}
          </Notice>
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onDone}>
            完成
          </Button>
        </DialogFooter>
      </>
    )

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        void install()
      }}
    >
      <DialogBody className="flex flex-col gap-4">
        <Tabs value={from} onValueChange={(v) => setFrom(v as 'git' | 'zip')}>
          <TabsList>
            <TabsTrigger value="git">Git 仓库</TabsTrigger>
            <TabsTrigger value="zip">上传 zip</TabsTrigger>
          </TabsList>
          <TabsContent value="git" className="mt-4 flex flex-col gap-4">
            <Field label="仓库地址">
              <Input value={git} autoFocus={from === 'git'} placeholder="https://github.com/anthropics/skills" onChange={(e) => setGit(e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="分支或标签（可选）">
                <Input value={ref} placeholder="main" onChange={(e) => setRef(e.target.value)} />
              </Field>
              <Field label="子目录（可选）">
                <Input value={path} placeholder="skills/pdf" onChange={(e) => setPath(e.target.value)} />
              </Field>
            </div>
          </TabsContent>
          <TabsContent value="zip" className="mt-4">
            <input ref={input} type="file" accept=".zip,.skill,application/zip" hidden onChange={(e) => setZip(e.target.files?.[0] ?? null)} />
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground hover:bg-hover"
            >
              <Upload className="size-5" />
              {zip ? <span className="text-foreground">{zip.name}</span> : '选择一个 zip 文件（不超过 20 MB）'}
            </button>
            {zip && zip.size > MAX_UPLOAD && <p className="mt-2 text-xs text-destructive">文件超过 20 MB。</p>}
          </TabsContent>
        </Tabs>
        <p className="text-xs text-muted-foreground">Skill 里的说明和脚本会被助手读取和执行，只安装你信任的来源。</p>
        {error && <Notice tone="error">{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? '安装中…' : '安装'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The values an MCP preset's address needs, such as Amap's key; resolves with them filled into the address. */
export function PresetForm({ item, onSubmit, onCancel }: { item: DiscoverItem; onSubmit: (url: string) => Promise<unknown>; onCancel: () => void }) {
  const install = item.install as Extract<DiscoverInstall, { mcp: string }>
  const fields = install.fields ?? []
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filled = fields.every((f) => values[f.key]?.trim())
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        onSubmit(fillTemplate(install.mcp, Object.fromEntries(fields.map((f) => [f.key, values[f.key]!.trim()])))).catch((e: unknown) => {
          setBusy(false)
          setError(errorText(e))
        })
      }}
    >
      <DialogBody className="flex flex-col gap-4">
        {fields.map((f, i) => (
          <Field key={f.key} label={f.label} {...(f.help && { help: f.help })}>
            <Input
              type="password"
              autoComplete="off"
              autoFocus={i === 0}
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </Field>
        ))}
        {item.homepage && (
          <a href={item.homepage} target="_blank" rel="noreferrer" className="self-start text-sm text-accent underline-offset-4 hover:underline">
            查看 {item.by} 的说明
          </a>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !filled}>
          {busy ? '连接中…' : '添加'}
        </Button>
      </DialogFooter>
    </form>
  )
}

import { parseDocument, stringify } from 'yaml'
import { resolve } from 'node:path'
import { archiveFiles, gitFiles, safePath, type SkillFiles } from './skills/sources.ts'
import { toBase64, fromBase64, UPLOADS_DIR } from '../agent/workspace.ts'
// Agent Skills (roadmap-3 R33: R19, R28, R29). A Skill is a folder with a SKILL.md: `name` and `description` front
// matter, then instructions the model reads with `read` when the task fits. Enabled shared Skills are written to
// /data/skills; a conversation's own Skills live in its workspace under skills/ and win on a name clash.
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { applySqliteMigrations } from '@earendil-works/chord/sqlite'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { SkillInfo, SkillSource, FilePreview } from '@gense/protocol'
import { SKILLS_DIR } from '../agent/workspace.ts'

export interface SkillDoc {
  name: string
  description: string
  body: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  'allowed-tools'?: string
}

export const builtinSkills: SkillDoc[] = [
  {
    name: '周报整理',
    description: '把零散的工作记录、聊天摘录或旧周报整理成结构清晰的周报，或改写成组会汇报提纲',
    body: `# 周报整理

1. 先弄清材料来源：用户附上的文件（在工作区的 attachments/ 下）、提到的文件，或直接贴在消息里的文字。需要时用 read 读取，不要编造进展。
2. 按下面的结构整理，每条一句话，写具体的结果和数字：
   - **本周完成**：已经完成并可以验证的事
   - **进行中**：当前进度与下一步
   - **问题与求助**：卡住的地方、需要导师或同事决定的事
   - **下周计划**：3–5 条，按优先级排列
3. 用户对周报格式有要求（例如三段式）时，以用户的要求为准。
4. 用户要求汇报提纲时，把同样的内容改成幻灯片式提纲：每页一个标题和不超过 4 条要点。
5. 内容较长时用 artifact_create 展示（插件开启时）；用户要求保存时用 write 写到工作区。`,
  },
  {
    name: '论文速读',
    description: '快速读一篇论文（PDF 或网页），提炼问题、方法、结果和局限，并给出是否值得精读的建议',
    body: `# 论文速读

1. 读取全文：附件用 read（较长时用 offset 分段读完）；网址用 web_fetch（网页插件开启时）。
2. 按以下结构输出，每部分 2–4 句：
   - **一句话总结**
   - **要解决的问题**：为什么重要，现有方法缺什么
   - **方法**：核心思路，关键公式或模块用通俗的话解释
   - **实验与结果**：数据集、对比基线、主要数字
   - **局限与疑问**：作者承认的和你发现的
   - **是否值得精读**：结合用户的研究方向（如果对话里提到过）给出建议
3. 引用论文原文时逐字摘录并注明页码或小节，让用户可以回到原文核对。
4. 术语第一次出现时给出英文原词。`,
  },
  {
    name: '邮件起草',
    description: '按场景起草得体的中文或英文邮件（请假、咨询导师、投稿、催办等），给出主题和正文',
    body: `# 邮件起草

1. 确认收件人身份、目的和需要对方做的事；信息不全时先问，最多问两个问题。
2. 结构：
   - **主题**：一眼能看出目的，例如“咨询：奖学金申请材料截止时间”
   - **称呼**：对老师用“X 老师您好”，英文用 “Dear Prof. X”
   - **正文**：第一段说明来意；第二段给出必要背景；最后一段明确请求和时间
   - **署名**：按用户给出的署名
3. 语气礼貌、简洁，不超过 250 字（英文不超过 180 词）。
4. 只起草，不发送。邮件插件开启时用 email_draft 展示草稿，否则把草稿完整写在回复里。`,
  },
]

/** Skill names: letters, digits, `-` and `_`, as used in `/` commands and folder names. */
export const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u

/** Reads SKILL.md: simple `key: value` front matter, then the body. Null when name or description is missing. */
export function parseSkill(raw: string, installed = false): SkillDoc | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw.replace(/^\uFEFF/, ''))
  if (!match) return null
  try {
    const yaml = parseDocument(match[1]!, { uniqueKeys: true })
    if (yaml.errors.length) return null
    const value = yaml.toJS({ maxAliasCount: 20 }) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const { name, description, license, compatibility, metadata } = value
    if (typeof name !== 'string' || !(installed ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/ : SKILL_NAME).test(name) || name.length > 64) return null
    if (typeof description !== 'string' || !description.trim() || description.length > 1024) return null
    if (license !== undefined && typeof license !== 'string') return null
    if (compatibility !== undefined && (typeof compatibility !== 'string' || !compatibility.length || compatibility.length > 500)) return null
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.values(metadata).some(v => typeof v !== 'string'))) return null
    if (value['allowed-tools'] !== undefined && typeof value['allowed-tools'] !== 'string') return null
    return { name, description, body: match[2]!.trim(), ...(license !== undefined && { license }), ...(compatibility !== undefined && { compatibility }), ...(metadata !== undefined && { metadata: metadata as Record<string, string> }), ...(value['allowed-tools'] !== undefined && { 'allowed-tools': value['allowed-tools'] as string }) }
  } catch { return null }
}

export const skillFile = ({ body, ...frontmatter }: SkillDoc) => `---\n${stringify(frontmatter)}---\n\n${body}\n`

/** The Skills in `dir`'s subfolders, with the path of each SKILL.md; folders without a valid one are skipped. */
export async function readSkills(env: ExecutionEnv, dir: string, ctx: Context): Promise<(SkillDoc & { path: string })[]> {
  const listed = await env.listDir(dir, ctx)
  if (!listed.ok) return []
  const out: (SkillDoc & { path: string })[] = []
  for (const info of listed.value.sort((a, b) => a.name.localeCompare(b.name))) {
    if (info.kind !== 'directory') continue
    const path = `${info.path}/SKILL.md`
    const raw = await env.readTextFile(path, ctx)
    const doc = raw.ok ? parseSkill(raw.value) : null
    if (doc) out.push({ ...doc, path })
  }
  return out
}

/** The system prompt's Skill list; a conversation's own Skills replace shared ones of the same name. */
export async function skillsSection(env: ExecutionEnv, ctx: Context) {
  const own = await readSkills(env, `${env.cwd}/skills`, ctx)
  const shared = (await readSkills(env, SKILLS_DIR, ctx)).filter((s) => !own.some((o) => o.name === s.name))
  const all = [...own, ...shared]
  if (!all.length) return undefined
  return [
    '可用的 Skills。任务符合某个 Skill 的描述，或用户用 /名称 要求使用它时，先用 read 读取它的 SKILL.md，再按说明完成任务；读取后在回答开头写一句“使用 Skill：名称”。',
    `你也可以为这个会话写新的 Skill：在工作区写 skills/<名称>/SKILL.md，开头是含 name 和 description 的 front matter；下一轮生效。`,
    ...all.map((s) => `- ${s.name}：${s.description}（${s.path}）`),
  ].join('\n')
}

const migrations = [{ version: 1, statements: ['CREATE TABLE skills (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL)'] }]

/** Which shared Skills one user has on. Built-in Skills are on until switched off. */
export class SkillStore {
  readonly #db: SqliteDatabase
  readonly #env: () => Promise<ExecutionEnv>
  readonly #switches = new Map<string, boolean>()
  readonly #installed = new Map<string, { doc: SkillDoc; source: 'upload' | 'git'; origin: string; files: Record<string, string> }>()
  readonly #temporaryRoot: string
  readonly #listeners = new Set<() => void>()

  private constructor(db: SqliteDatabase, env: () => Promise<ExecutionEnv>, temporaryRoot: string) {
    this.#temporaryRoot = temporaryRoot
    this.#db = db
    this.#env = env
  }

  /** `env` reaches /data; the enabled Skills are written to /data/skills now and after every switch. */
  static async open(db: SqliteDatabase, env: () => Promise<ExecutionEnv>, ctx: Context, temporaryRoot = resolve(import.meta.dirname, '../../../../data/skill-tmp')) {
    await applySqliteMigrations(db, migrations, { table: 'skill_migrations' })
    const store = new SkillStore(db, env, temporaryRoot)
    for (const row of await db.all<{ name: string; enabled: number }>('SELECT name, enabled FROM skills')) store.#switches.set(row.name, row.enabled === 1)
    await db.run('CREATE TABLE IF NOT EXISTS installed_skills (name TEXT PRIMARY KEY, data TEXT NOT NULL)')
    for (const row of await db.all<{ name: string; data: string }>('SELECT * FROM installed_skills')) store.#installed.set(row.name, JSON.parse(row.data))
    await store.#sync(ctx)
    return store
  }

  list(): SkillInfo[] {
    return [...builtinSkills.map((s): SkillInfo => ({ name: s.name, description: s.description, source: 'builtin', enabled: this.#switches.get(s.name) ?? true, files: ['SKILL.md'] })), ...[...this.#installed].map(([name, item]): SkillInfo => ({ name, description: item.doc.description, source: item.source, origin: item.origin, ...(item.doc.license && { license: item.doc.license }), enabled: this.#switches.get(name) ?? true, files: Object.keys(item.files).sort((a,b) => a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)) }))]
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  async set(name: string, enabled: boolean, ctx: Context = BACKGROUND_CONTEXT) {
    if (!this.list().some((s) => s.name === name)) throw new Error('未知 Skill')
    await this.#db.run('INSERT INTO skills (name, enabled) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled', name, enabled ? 1 : 0)
    this.#switches.set(name, enabled)
    await this.#sync(ctx)
    for (const l of this.#listeners) l()
  }

  get canInstall() { return true }

  async install(source: SkillSource, ctx: Context = BACKGROUND_CONTEXT): Promise<SkillInfo[]> {
    const env = await this.#env()
    let files: SkillFiles, origin: string, kind: 'upload' | 'git'
    if ('upload' in source) {
      if (!source.upload.startsWith(UPLOADS_DIR + '/') || source.upload.slice(UPLOADS_DIR.length + 1).includes('/')) throw new Error('上传 ID 无效')
      const read = await env.readBinaryFile(source.upload, ctx)
      if (!read.ok) throw read.error
      files = archiveFiles(read.value); origin = source.upload.split('/').at(-1)!; kind = 'upload'
    } else { files = await gitFiles(source, this.#temporaryRoot); origin = source.git; kind = 'git' }
    const candidates = Object.keys(files).filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
    const batch = new Map<string, { doc: SkillDoc; source: 'upload' | 'git'; origin: string; files: Record<string, string> }>()
    for (const path of candidates) {
      const doc = parseSkill(new TextDecoder('utf-8', { fatal: true }).decode(files[path]!), true)
      if (!doc) throw new Error('Skill front matter 无效：' + path)
      const prefix = path.slice(0, -'SKILL.md'.length)
      if (prefix && prefix.slice(0, -1).split('/').at(-1) !== doc.name) throw new Error('Skill 名称必须匹配目录')
      if (builtinSkills.some(s => s.name === doc.name) || batch.has(doc.name)) throw new Error('Skill 名称重复')
      const contained = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(prefix)).map(([p, b]) => [safePath(p.slice(prefix.length)), toBase64(b)]))
      batch.set(doc.name, { doc, source: kind, origin, files: contained })
    }
    if (!batch.size) throw new Error('没有找到 SKILL.md')
    await this.#db.transaction(async tx => {
      for (const [name, item] of batch) await tx.run('INSERT INTO installed_skills VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data', name, JSON.stringify(item))
    })
    for (const [name, item] of batch) this.#installed.set(name, item)
    await this.#sync(ctx)
    for (const l of this.#listeners) l()
    return this.list().filter(s => batch.has(s.name))
  }

  async remove(name: string, ctx: Context = BACKGROUND_CONTEXT) {
    if (!this.#installed.has(name)) throw new Error('不能删除内置或未知 Skill')
    await this.#db.transaction(async tx => { await tx.run('DELETE FROM installed_skills WHERE name = ?', name); await tx.run('DELETE FROM skills WHERE name = ?', name) })
    this.#installed.delete(name); this.#switches.delete(name)
    const env = await this.#env()
    const removed = await env.remove(`${SKILLS_DIR}/${name}`, { recursive: true, force: true }, ctx)
    if (!removed.ok) throw removed.error
    for (const l of this.#listeners) l()
  }

  async read(name: string, path: string): Promise<FilePreview> {
    safePath(path)
    const builtin = builtinSkills.find(s => s.name === name)
    const encoded = this.#installed.get(name)?.files[path]
    const bytes = builtin && path === 'SKILL.md' ? new TextEncoder().encode(skillFile(builtin)) : encoded !== undefined ? fromBase64(encoded) : undefined
    if (!bytes) throw new Error('Skill 文件不存在')
    const head = bytes.subarray(0, 64 * 1024)
    let text = '', binary = false
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(head); binary = text.includes('\0'); if (binary) text = '' } catch { binary = true }
    return { text, size: bytes.length, truncated: head.length < bytes.length, binary }
  }

  /** Makes /data/skills hold exactly the enabled Skills. */
  async #sync(ctx: Context) {
    const env = await this.#env()
    const enabled = new Set(this.list().filter((s) => s.enabled).map((s) => s.name))
    const listed = await env.listDir(SKILLS_DIR, ctx)
    for (const info of listed.ok ? listed.value : [])
      if (!enabled.has(info.name)) await env.remove(info.path, { recursive: true, force: true }, ctx)
    for (const [name, item] of this.#installed) {
      if (!enabled.has(name)) continue
      const removed = await env.remove(`${SKILLS_DIR}/${name}`, { recursive: true, force: true }, ctx)
      if (!removed.ok) throw removed.error
      for (const [path, bytes] of Object.entries(item.files)) {
        const written = await env.writeFile(`${SKILLS_DIR}/${name}/${path}`, fromBase64(bytes), ctx)
        if (!written.ok) throw written.error
      }
    }
    for (const s of builtinSkills) {
      if (!enabled.has(s.name)) continue
      const written = await env.writeFile(`${SKILLS_DIR}/${s.name}/SKILL.md`, skillFile(s), ctx)
      if (!written.ok) throw written.error
    }
  }
}

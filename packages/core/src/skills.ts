// Agent Skills (roadmap-3 R33: R19, R28, R29). A Skill is a folder with a SKILL.md: `name` and `description` front
// matter, then instructions the model reads with `read` when the task fits. Enabled shared Skills are written to
// /data/skills; a conversation's own Skills live in its workspace under skills/ and win on a name clash.
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { applySqliteMigrations } from '@earendil-works/chord/sqlite'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { SkillInfo } from './protocol.ts'
import { SKILLS_DIR } from './workspace.ts'

export interface SkillDoc {
  name: string
  description: string
  body: string
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
export function parseSkill(raw: string): SkillDoc | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^﻿/, ''))
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  const name = fields.name ?? ''
  const description = fields.description ?? ''
  if (!SKILL_NAME.test(name) || !description) return null
  return { name, description: description.slice(0, 1024), body: m[2]!.trim() }
}

export const skillFile = (s: SkillDoc) => `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`

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
  readonly #listeners = new Set<() => void>()

  private constructor(db: SqliteDatabase, env: () => Promise<ExecutionEnv>) {
    this.#db = db
    this.#env = env
  }

  /** `env` reaches /data; the enabled Skills are written to /data/skills now and after every switch. */
  static async open(db: SqliteDatabase, env: () => Promise<ExecutionEnv>, ctx: Context) {
    await applySqliteMigrations(db, migrations, { table: 'skill_migrations' })
    const store = new SkillStore(db, env)
    for (const row of await db.all<{ name: string; enabled: number }>('SELECT name, enabled FROM skills')) store.#switches.set(row.name, row.enabled === 1)
    await store.#sync(ctx)
    return store
  }

  list(): SkillInfo[] {
    return builtinSkills.map((s) => ({ name: s.name, description: s.description, source: 'builtin', enabled: this.#switches.get(s.name) ?? true }))
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  async set(name: string, enabled: boolean, ctx: Context = BACKGROUND_CONTEXT) {
    if (!builtinSkills.some((s) => s.name === name)) throw new Error('未知 Skill')
    await this.#db.run('INSERT INTO skills (name, enabled) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled', name, enabled ? 1 : 0)
    this.#switches.set(name, enabled)
    await this.#sync(ctx)
    for (const l of this.#listeners) l()
  }

  /** Makes /data/skills hold exactly the enabled Skills. */
  async #sync(ctx: Context) {
    const env = await this.#env()
    const enabled = new Set(this.list().filter((s) => s.enabled).map((s) => s.name))
    const listed = await env.listDir(SKILLS_DIR, ctx)
    for (const info of listed.ok ? listed.value : [])
      if (!enabled.has(info.name)) await env.remove(info.path, { recursive: true, force: true }, ctx)
    for (const s of builtinSkills) {
      if (!enabled.has(s.name)) continue
      const written = await env.writeFile(`${SKILLS_DIR}/${s.name}/SKILL.md`, skillFile(s), ctx)
      if (!written.ok) throw written.error
    }
  }
}

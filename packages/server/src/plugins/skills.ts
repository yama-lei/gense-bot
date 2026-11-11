import { parseDocument } from 'yaml'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

/** Built-in Skills ship as ordinary Skill folders in packages/server/skills (roadmap-6 A1). */
export const BUILTIN_SKILLS_DIR = resolve(import.meta.dirname, '../../skills')

interface SkillItem { doc: SkillDoc; source: 'builtin' | 'upload' | 'git'; origin?: string; files: Record<string, string> }

/** Every file under `dir`, by path relative to it. */
function readTree(dir: string, prefix = ''): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(out, readTree(dir, path))
    else if (entry.isFile()) out[path] = readFileSync(join(dir, path))
  }
  return out
}

/** The built-in Skills, held to the same naming rules as installed ones. */
export function loadBuiltinSkills(dir = BUILTIN_SKILLS_DIR): Map<string, SkillItem> {
  const out = new Map<string, SkillItem>()
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const files = readTree(join(dir, entry.name))
    const raw = files['SKILL.md']
    const doc = raw && parseSkill(new TextDecoder().decode(raw), true)
    if (!doc || doc.name !== entry.name) throw new Error(`内置 Skill ${entry.name} 的 SKILL.md 无效`)
    out.set(doc.name, { doc, source: 'builtin', files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, toBase64(b)])) })
  }
  return out
}

/** The plugin a Skill belongs to (`metadata.plugin`): always on, and that plugin's prompt points to it. */
const pluginOf = (doc: Pick<SkillDoc, 'metadata'>) => doc.metadata?.plugin

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
/** The list shows at most this much of a description (A11); the whole of it is in SKILL.md. */
export const SKILL_DESCRIPTION_CHARS = 250
const clipDescription = (d: string) => {
  const flat = d.replace(/\s+/g, ' ').trim()
  return flat.length > SKILL_DESCRIPTION_CHARS ? `${flat.slice(0, SKILL_DESCRIPTION_CHARS - 1).trimEnd()}…` : flat
}

export async function skillsSection(env: ExecutionEnv, ctx: Context) {
  const own = await readSkills(env, `${env.cwd}/skills`, ctx)
  const shared = (await readSkills(env, SKILLS_DIR, ctx)).filter((s) => !own.some((o) => o.name === s.name))
  const all = [...own, ...shared].filter((s) => !pluginOf(s))
  if (!all.length) return undefined
  return [
    "Skills are folders of instructions and scripts for particular tasks. When a task matches a Skill's description, or the user asks for one with /name, read its SKILL.md before anything else and follow it; it may point to more files. Tell the user in a few words which Skill you are using. Do not read Skills the task does not need.",
    'You can write a Skill for this conversation: `skills/<name>/SKILL.md` in the workspace, starting with front matter that has `name` and `description`. It is available from the next turn.',
    '',
    'Available Skills:',
    ...all.map((s) => `- ${s.name}: ${clipDescription(s.description)} (${s.path})`),
  ].join('\n')
}

/** Loaded once per process: the folders do not change while it runs. */
let builtinCache: Map<string, SkillItem> | undefined
export const builtinSkills = () => (builtinCache ??= loadBuiltinSkills())

const migrations = [{ version: 1, statements: ['CREATE TABLE skills (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL)'] }]

/** Which shared Skills one user has on. Built-in Skills are on until switched off. */
export class SkillStore {
  readonly #db: SqliteDatabase
  readonly #env: () => Promise<ExecutionEnv>
  readonly #switches = new Map<string, boolean>()
  readonly #builtin: Map<string, SkillItem>
  readonly #installed = new Map<string, SkillItem>()
  readonly #temporaryRoot: string
  readonly #listeners = new Set<() => void>()

  private constructor(db: SqliteDatabase, env: () => Promise<ExecutionEnv>, temporaryRoot: string, builtin: Map<string, SkillItem>) {
    this.#builtin = builtin
    this.#temporaryRoot = temporaryRoot
    this.#db = db
    this.#env = env
  }

  /** `env` reaches /data; the enabled Skills are written to /data/skills now and after every switch. */
  static async open(db: SqliteDatabase, env: () => Promise<ExecutionEnv>, ctx: Context, temporaryRoot = resolve(import.meta.dirname, '../../../../data/skill-tmp'), builtin = builtinSkills()) {
    await applySqliteMigrations(db, migrations, { table: 'skill_migrations' })
    const store = new SkillStore(db, env, temporaryRoot, builtin)
    for (const row of await db.all<{ name: string; enabled: number }>('SELECT name, enabled FROM skills')) store.#switches.set(row.name, row.enabled === 1)
    await db.run('CREATE TABLE IF NOT EXISTS installed_skills (name TEXT PRIMARY KEY, data TEXT NOT NULL)')
    for (const row of await db.all<{ name: string; data: string }>('SELECT * FROM installed_skills')) store.#installed.set(row.name, JSON.parse(row.data))
    await store.#sync(ctx)
    return store
  }

  list(): SkillInfo[] {
    return [...this.#builtin, ...this.#installed].map(([name, item]): SkillInfo => {
      const plugin = pluginOf(item.doc)
      return {
        name, description: item.doc.description, source: item.source,
        ...(item.origin && { origin: item.origin }), ...(item.doc.license && { license: item.doc.license }), ...(plugin && { plugin }),
        enabled: plugin ? true : this.#switches.get(name) ?? true,
        files: Object.keys(item.files).sort((a, b) => a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)),
      }
    })
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  async set(name: string, enabled: boolean, ctx: Context = BACKGROUND_CONTEXT) {
    const skill = this.list().find((s) => s.name === name)
    if (!skill) throw new Error('未知 Skill')
    if (skill.plugin) throw new Error('这个 Skill 随插件提供，不能单独关闭')
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
    const batch = new Map<string, SkillItem>()
    for (const path of candidates) {
      const doc = parseSkill(new TextDecoder('utf-8', { fatal: true }).decode(files[path]!), true)
      if (!doc) throw new Error('Skill front matter 无效：' + path)
      const prefix = path.slice(0, -'SKILL.md'.length)
      if (prefix && prefix.slice(0, -1).split('/').at(-1) !== doc.name) throw new Error('Skill 名称必须匹配目录')
      if (this.#builtin.has(doc.name) || batch.has(doc.name)) throw new Error('Skill 名称重复')
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
    const encoded = (this.#builtin.get(name) ?? this.#installed.get(name))?.files[path]
    const bytes = encoded !== undefined ? fromBase64(encoded) : undefined
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
    for (const [name, item] of [...this.#builtin, ...this.#installed]) {
      if (!enabled.has(name)) continue
      const removed = await env.remove(`${SKILLS_DIR}/${name}`, { recursive: true, force: true }, ctx)
      if (!removed.ok) throw removed.error
      for (const [path, bytes] of Object.entries(item.files)) {
        const written = await env.writeFile(`${SKILLS_DIR}/${name}/${path}`, fromBase64(bytes), ctx)
        if (!written.ok) throw written.error
      }
    }
  }
}

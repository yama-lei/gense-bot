import { unzipSync } from 'fflate'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const MAX_FILES = 2000
export const MAX_BYTES = 50 * 1024 * 1024
export type SkillFiles = Record<string, Uint8Array>

export function safePath(path: string, directory = false) {
  const value = directory ? path.replace(/\/$/, '') : path
  if (!value || value.startsWith('/') || /[\\\x00-\x1f:]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Skill 路径越界或无效')
  return value
}

/** Inspect central records before inflating, including Unix file types and uncompressed sizes. */
export function archiveFiles(bytes: Uint8Array): SkillFiles {
  if (bytes.length > MAX_BYTES) throw new Error('Skill archive 太大')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50) break
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw new Error('无效 ZIP')
  const count = view.getUint16(end + 10, true)
  if (count > MAX_FILES || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('ZIP 文件太多或分卷不支持')
  let at = view.getUint32(end + 16, true), total = 0
  const names = new Set<string>()
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error('无效 ZIP 目录')
    const length = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + length))
    safePath(name, name.endsWith('/'))
    const type = (view.getUint32(at + 38, true) >>> 16) & 0xf000
    if (type && type !== 0x8000 && type !== 0x4000) throw new Error('Skill 不允许符号链接或特殊文件')
    if (names.has(name)) throw new Error('ZIP 路径重复')
    names.add(name)
    total += view.getUint32(at + 24, true)
    if (total > MAX_BYTES) throw new Error('Skill 解压后太大')
    at += 46 + length + extra + comment
  }
  const files = unzipSync(bytes, { filter: entry => {
    if (!names.has(entry.name) || entry.originalSize > MAX_BYTES) throw new Error('ZIP 文件无效')
    return !entry.name.endsWith('/')
  } })
  if (Object.values(files).reduce((sum, b) => sum + b.length, 0) > MAX_BYTES) throw new Error('Skill 太大')
  return files
}

async function scan(root: string, includeGit = false): Promise<SkillFiles> {
  const files: SkillFiles = {}
  let total = 0, count = 0
  async function walk(dir: string, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!includeGit && entry.name === '.git') continue
      const relative = prefix + entry.name, path = join(dir, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Skill 不允许符号链接或特殊文件')
      safePath(relative)
      if (++count > (includeGit ? MAX_FILES * 4 : MAX_FILES)) throw new Error('Git 文件太多')
      total += info.isFile() ? info.size : 0
      if (total > (includeGit ? MAX_BYTES * 2 : MAX_BYTES)) throw new Error('Git 仓库太大')
      if (info.isDirectory()) await walk(path, relative + '/')
      else if (!includeGit) files[relative] = await readFile(path)
    }
  }
  await walk(root)
  return files
}

/** The host fetches without credentials, global Git config, hooks, submodules or interactive prompts. */
export async function gitFiles(source: { git: string; ref?: string; path?: string }, temporaryRoot: string): Promise<SkillFiles> {
  const url = new URL(source.git)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Git 地址必须是不带凭据的 HTTP(S) 地址')
  if (source.ref && (!/^[\w./-]+$/.test(source.ref) || source.ref.startsWith('-') || source.ref.includes('..'))) throw new Error('Git ref 无效')
  const selected = source.path ? safePath(source.path.replace(/\/$/, '')) : ''
  await mkdir(temporaryRoot, { recursive: true })
  const scratch = await mkdtemp(join(temporaryRoot, 'install-'))
  const checkout = join(scratch, 'repo')
  try {
    await new Promise<void>((accept, reject) => {
      const args = ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--single-branch', '--no-tags', ...(source.ref ? ['--branch', source.ref] : []), '--', url.href, checkout]
      const child = spawn('git', args, { cwd: scratch, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' }, stdio: ['ignore', 'ignore', 'pipe'] })
      let error = '', blocked: Error | undefined, checking = false
      child.stderr.on('data', b => { error = (error + String(b)).slice(-4000) })
      const timer = setTimeout(() => { blocked = new Error('Git 下载超时'); child.kill('SIGKILL') }, 60_000)
      const monitor = setInterval(() => {
        if (checking) return
        checking = true
        void scan(checkout, true).catch(e => { if (e.code !== 'ENOENT') { blocked = e; child.kill('SIGKILL') } }).finally(() => { checking = false })
      }, 100)
      child.once('error', reject)
      child.once('close', code => { clearTimeout(timer); clearInterval(monitor); if (blocked || code !== 0) reject(blocked ?? new Error('Git 下载失败：' + error)); else accept() })
    })
    await scan(checkout, true)
    const root = resolve(checkout, selected)
    return await scan(root)
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

// Nightly snapshots (ADR-0006). The host starts one job for app.sqlite and one for each user’s space.sqlite,
// in separate backup directories. VACUUM INTO writes a consistent, compacted copy while the server keeps running.
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface BackupOptions {
  /** Copies kept, newest first. */
  keep?: number
  /** Least time between copies. */
  everyMs?: number
}

const DAY = 24 * 3600_000
const NAME = /^gense-(\d{8}T\d{6}Z)\.sqlite$/

const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/** The copies in `dir`, newest first. */
export async function backups(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => NAME.test(n)).sort().reverse()
}

/** Writes one copy now and removes the oldest beyond `keep`. Returns its path. */
export async function backupNow(db: SqliteDatabase, dir: string, keep = 7) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, `gense-${stamp(new Date())}.sqlite`)
  // Written under a temporary name, so a crash never leaves a half copy that looks complete.
  const partial = `${path}.partial`
  await rm(partial, { force: true })
  await db.run('VACUUM INTO ?', partial)
  await rename(partial, path)
  for (const old of (await backups(dir)).slice(keep)) await rm(join(dir, old), { force: true })
  return path
}

/** Checks every hour and copies when the newest copy is older than `everyMs`, so a restart neither skips nor doubles one. */
export function startBackups(db: SqliteDatabase, dir: string, options: BackupOptions = {}) {
  const every = options.everyMs ?? DAY
  let running: Promise<unknown> | undefined
  const check = async () => {
    const [newest] = await backups(dir)
    const age = newest ? Date.now() - (await stat(join(dir, newest))).mtimeMs : Infinity
    if (age >= every) await backupNow(db, dir, options.keep)
  }
  const tick = () => {
    running ??= check()
      .catch((error) => console.error('备份失败：', error instanceof Error ? error.message : error))
      .finally(() => (running = undefined))
  }
  const timer = setInterval(tick, Math.min(every, 3600_000))
  timer.unref()
  tick()
  return {
    stop() {
      clearInterval(timer)
      return running
    },
  }
}

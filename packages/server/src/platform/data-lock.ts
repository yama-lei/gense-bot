// A kernel-backed SQLite lock survives PID namespaces and releases automatically after a crash.
// The dedicated file carries no application data and is excluded from database snapshots.
import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function lockData(dataDir: string) {
  await mkdir(dataDir, { recursive: true })
  const lock = new DatabaseSync(join(dataDir, '.host-lock.sqlite'))
  try { lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE') }
  catch { lock.close(); throw new Error('数据目录正在使用；迁移前请停止服务器') }
  let released = false
  return async () => { if (!released) { released = true; lock.close() } }
}

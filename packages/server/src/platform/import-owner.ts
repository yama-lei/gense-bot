// Offline, one-time migration. Keep TOKEN_ENCRYPTION_KEY unchanged so existing secrets still open.
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { access, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { lockData } from './data-lock.ts'
import { Auth } from './auth.ts'
import { openDatabase } from './server.ts'
import { userDir } from './spaces.ts'
import type { UserInfo } from '@gense/protocol'

const exists = (path: string) => access(path).then(() => true, () => false)
/** Requires a stopped host. Uses the legacy password when creating the account; existing accounts keep theirs. */
export async function importOwner(dataDir: string, email: string): Promise<UserInfo> {
  const unlock = await lockData(dataDir)
  try { return await moveOwner(dataDir, email) } finally { await unlock() }
}

async function moveOwner(dataDir: string, email: string): Promise<UserInfo> {
  const legacy = join(dataDir, 'gense.sqlite')
  if (!(await exists(legacy))) throw new Error('没有单所有者数据库 gense.sqlite（可能已迁移）')
  const app = await openDatabase(dataDir)
  try {
    const auth = await Auth.open(app)
    let user = await auth.find(email)
    const old = await openNodeSqliteDatabase(legacy)
    let password: string | undefined
    try {
      password = (await old.get<{ password: string }>('SELECT password FROM owner WHERE id = 1'))?.password
      await old.run('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { await old.close() }
    if (!user) {
      if (!password) throw new Error('旧账号没有密码；请先注册目标账号')
      // Registration validates the email and serializes first-admin selection. Replace the random bootstrap password
      // before returning; neither the password nor its hash is exposed to the caller.
      user = await auth.register(email, crypto.randomUUID())
      await app.run('UPDATE users SET password = ? WHERE id = ?', password, user.id)
    }
    const dir = userDir(dataDir, user.id)
    if (await exists(join(dir, 'space.sqlite')) || await exists(join(dir, 'files'))) throw new Error('目标用户已有空间，拒绝覆盖')
    await mkdir(dir, { recursive: true })
    const legacyFiles = join(dataDir, 'files')
    // Move the files first and roll them back if the database move fails.
    const moved = await exists(legacyFiles)
    if (moved) await rename(legacyFiles, join(dir, 'files'))
    try { await rename(legacy, join(dir, 'space.sqlite')) }
    catch (error) { if (moved) await rename(join(dir, 'files'), legacyFiles); throw error }
    if (!moved) await mkdir(join(dir, 'files'), { recursive: true })
    return user
  } finally { await app.close() }
}

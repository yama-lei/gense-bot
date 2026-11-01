// ADR-0005 decision 13: daily database copies that open as SQLite and hold the data, without doubling after a restart.
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { Auth } from '@gense/core'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { backupNow, backups, startBackups } from '../src/backup.ts'
import { openDatabase } from '../src/server.ts'
import { tempDir } from './helpers.ts'

test('a copy is a complete database, and only the newest copies are kept', async () => {
  const dataDir = await tempDir()
  const dir = join(dataDir, 'backups')
  const db = await openDatabase(dataDir)
  const auth = await Auth.open(db)
  await auth.setPassword('correct horse')
  const first = await backupNow(db, dir, 2)

  const copy = await openNodeSqliteDatabase(first)
  const restored = await Auth.open(copy)
  assert.ok(await restored.login('correct horse'), 'the copy holds the password')
  await copy.close()

  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1100))
    await backupNow(db, dir, 2)
  }
  const kept = await backups(dir)
  assert.equal(kept.length, 2)
  assert.ok(!kept.includes(first.split('/').at(-1)!), 'the oldest copy is removed')
  await db.close()
})

test('a restart within the interval does not copy again', async () => {
  const dataDir = await tempDir()
  const dir = join(dataDir, 'backups')
  const db = await openDatabase(dataDir)
  await startBackups(db, dir).stop()
  assert.equal((await backups(dir)).length, 1, 'the first start copies')
  await startBackups(db, dir).stop()
  assert.equal((await backups(dir)).length, 1, 'a second start within a day does not')
  await db.close()
})

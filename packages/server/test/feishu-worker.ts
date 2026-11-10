// Crash-recovery fixture. All files live in the parent test's repository-local temporary directory.
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { join } from 'node:path'
import { DATA_DIR, MountedEnv, fauxModels, UserSpace } from '../src/index.ts'
const [root, domain] = process.argv.slice(2)
if (!root || !domain) throw new Error('Missing fixture arguments')
const space = await UserSpace.open(await openNodeSqliteDatabase(join(root, 'feishu.sqlite')), {
  models: fauxModels(), secretKey: 'key',
  env: cwd => new MountedEnv(new NodeExecutionEnv({ cwd: root }), { mount: DATA_DIR, target: root, cwd }),
  feishu: { domain, publicUrl: 'https://gense.example' }, outboxRetryMs: 50,
})
process.on('message', message => {
  const request = message as { id: string }
  void space.db.get<{ delivered_at: number | null }>('SELECT delivered_at FROM outbox WHERE id = ?', request.id + ':final').then(row => process.send?.({ pending: !!row && row.delivered_at === null }))
})
process.send?.({ ready: true })

// Eagerly open every enabled user's runtime: external channels and durable work cannot wait for a browser login.
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { createHash } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { UserSpace } from '../agent/space.ts'
import { DATA_DIR } from '../agent/workspace.ts'
import { confinedEnv } from './fs/confined-env.ts'
import { MountedEnv } from './fs/mounted-env.ts'
import { Sandbox, SandboxedEnv } from './sandbox.ts'
import { startBackups } from './backup.ts'
import type { Auth } from './auth.ts'
import type { AppStore } from './app.ts'
import type { HostConfig } from './config.ts'

export const userDir = (dataDir: string, userId: string) => resolve(dataDir, 'users', userId)
export class Spaces {
  readonly #config: HostConfig
  readonly #auth: Auth
  readonly #app: AppStore
  readonly #opened = new Map<string, { space: UserSpace; sandbox?: Sandbox; backup?: ReturnType<typeof startBackups> }>()
  readonly #inactive = new Map<string, { db: import('@earendil-works/chord/sqlite').SqliteDatabase; backup: ReturnType<typeof startBackups> }>()
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #unsubscribe: () => void
  constructor(config: HostConfig, auth: Auth, app: AppStore) {
    this.#config = config; this.#auth = auth; this.#app = app
    this.#unsubscribe = app.subscribe(async () => { await Promise.all([...this.#opened.values()].map(r => r.space.accounts.refreshHost())) })
  }
  get(userId: string) { return this.#opened.get(userId)?.space }
  sandbox(userId: string) { return this.#opened.get(userId)?.sandbox }
  async start() { for (const user of await this.#auth.users()) await this.sync(user.id) }
  sync(userId: string): Promise<UserSpace | undefined> {
    const operation = (this.#queues.get(userId) ?? Promise.resolve()).then(async () => {
      const user = await this.#auth.user(userId), old = this.#opened.get(userId)
      if (!user || user.disabled) {
        if (old) {
          this.#opened.delete(userId)
          await old.backup?.stop()
          await old.space.close()
          await old.sandbox?.stop()
        }
        const path = join(userDir(this.#config.dataDir, userId), 'space.sqlite')
        if (user && this.#config.backups !== false && !this.#inactive.has(userId) && await access(path).then(() => true, () => false)) {
          const db = await openNodeSqliteDatabase(path)
          this.#inactive.set(userId, { db, backup: startBackups(db, join(this.#config.dataDir, 'backups', 'users', userId), this.#config.backups) })
        }
        return undefined
      }
      const inactive = this.#inactive.get(userId)
      if (inactive) { await inactive.backup.stop(); await inactive.db.close(); this.#inactive.delete(userId) }
      if (old) return old.space
      const config = this.#config, dir = userDir(config.dataDir, userId), files = join(dir, 'files')
      await mkdir(files, { recursive: true })
      const db = await openNodeSqliteDatabase(join(dir, 'space.sqlite'))
      let space: UserSpace | undefined
      const sandbox = config.sandbox ? new Sandbox({ ...config.sandbox, name: `gense-${createHash('sha256').update(resolve(config.dataDir)).digest('hex').slice(0, 8)}-${userId}`, root: files, image: () => String(space?.plugins.resolved('sandbox').image ?? 'slim') }) : undefined
      const env = (cwd: string) => sandbox
        ? new SandboxedEnv(confinedEnv(new NodeExecutionEnv({ cwd: files }), files), sandbox, { target: files, cwd })
        : new MountedEnv(confinedEnv(new NodeExecutionEnv({ cwd: files }), files), { mount: DATA_DIR, target: files, cwd })
      // Faux is only a development host provider; production shared providers come from app.sqlite.
      const development = config.models()
      const models = () => { const shared = this.#app.models(); const options = [...shared.options, ...development.options]; return { providers: [...shared.providers, ...development.providers], options, defaultModel: options[0] ?? null, kinds: { ...development.kinds, ...shared.kinds } } }
      try {
        space = await UserSpace.open(db, { userId, models, env, plugins: config.plugins, secretKey: config.secretKey, sandbox: !!sandbox, webhooks: true, skillTempDir: join(dir, 'skill-tmp'), mcp: { publicUrl: config.publicUrl, callbackPath: `/api/users/${userId}/mcp/callback` }, feishu: { ...config.feishu, publicUrl: config.publicUrl }, meterModels: (registry, source) => this.#app.meter(userId, registry, source), deepseekService: () => this.#app.deepseekService(), serviceUsage: (service, units) => this.#app.recordService(userId, service, units) })
        const backup = config.backups === false ? undefined : startBackups(db, join(config.dataDir, 'backups', 'users', userId), config.backups)
        this.#opened.set(userId, { space, sandbox, backup })
        await space.accounts.refreshHost()
        return space
      } catch (error) { await db.close().catch(() => {}); await sandbox?.stop(); throw error }
    })
    this.#queues.set(userId, operation.catch(() => {}))
    return operation
  }
  async close() {
    this.#unsubscribe()
    await Promise.all(this.#queues.values())
    for (const { space, sandbox, backup } of this.#opened.values()) { await backup?.stop(); await space.close(); await sandbox?.stop() }
    this.#opened.clear()
    for (const { db, backup } of this.#inactive.values()) { await backup.stop(); await db.close() }
    this.#inactive.clear()
    await this.#app.flush()
  }
}

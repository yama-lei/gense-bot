// One user's model credentials (roadmap-3 D11, R62): pi-ai's CredentialStore over the host tables, sealed with the
// host's TOKEN_ENCRYPTION_KEY. pi-ai owns the providers, their logins and token refresh; we only store and relay.
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { applySqliteMigrations } from '@earendil-works/chord/sqlite'
import type { AuthContext, AuthInteraction, AuthType, Credential, CredentialInfo, CredentialStore, MutableModels } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { ModelSetup } from './models.ts'
import { Sealer } from './plugins/store.ts'
import type { ModelInfo, ProviderState } from './protocol.ts'

const migrations = [
  {
    version: 1,
    statements: [
      'CREATE TABLE credentials (provider TEXT PRIMARY KEY, type TEXT NOT NULL, sealed TEXT NOT NULL)',
      'CREATE TABLE credential_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ],
  },
]

/** No ambient sources: a user's models never resolve from the host's environment variables or files. */
export const NO_AMBIENT_AUTH: AuthContext = { env: async () => undefined, fileExists: async () => false }

export class SealedCredentialStore implements CredentialStore {
  readonly #db: SqliteDatabase
  readonly #sealer: Sealer | undefined
  /** Per provider, the tail of its serialized writes. */
  readonly #locks = new Map<string, Promise<unknown>>()

  private constructor(db: SqliteDatabase, secretKey: string | undefined) {
    this.#db = db
    this.#sealer = secretKey ? new Sealer(secretKey) : undefined
  }

  static async open(db: SqliteDatabase, secretKey: string | undefined) {
    await applySqliteMigrations(db, migrations, { table: 'credential_migrations' })
    return new SealedCredentialStore(db, secretKey)
  }

  /** A credential that no longer opens (a changed key) reads as missing. */
  async read(providerId: string): Promise<Credential | undefined> {
    const row = await this.#db.get<{ sealed: string }>('SELECT sealed FROM credentials WHERE provider = ?', providerId)
    if (!row || !this.#sealer) return undefined
    return this.#sealer.open(row.sealed).then((t) => JSON.parse(t) as Credential, () => undefined)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = await this.#db.all<{ provider: string; type: string }>('SELECT provider, type FROM credentials ORDER BY provider')
    return rows.map((r) => ({ providerId: r.provider, type: r.type as Credential['type'] }))
  }

  #serial<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#locks.get(providerId) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => {})
    this.#locks.set(providerId, tail)
    void tail.then(() => this.#locks.get(providerId) === tail && this.#locks.delete(providerId))
    return run
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.#serial(providerId, async () => {
      const current = await this.read(providerId)
      const next = await fn(current)
      if (next === undefined) return current
      if (!this.#sealer) throw new Error('服务器没有配置 TOKEN_ENCRYPTION_KEY，不能保存模型凭据')
      await this.#db.run(
        'INSERT INTO credentials (provider, type, sealed) VALUES (?, ?, ?) ON CONFLICT (provider) DO UPDATE SET type = excluded.type, sealed = excluded.sealed',
        providerId,
        next.type,
        await this.#sealer.seal(JSON.stringify(next)),
      )
      return next
    })
  }

  delete(providerId: string) {
    return this.#serial(providerId, async () => {
      await this.#db.run('DELETE FROM credentials WHERE provider = ?', providerId)
    })
  }

  /** This user's stable installation id, which some logins send to the provider. */
  async deviceId() {
    const row = await this.#db.get<{ value: string }>("SELECT value FROM credential_meta WHERE key = 'deviceId'")
    if (row) return row.value
    const id = crypto.randomUUID()
    await this.#db.run("INSERT OR IGNORE INTO credential_meta (key, value) VALUES ('deviceId', ?)", id)
    return (await this.#db.get<{ value: string }>("SELECT value FROM credential_meta WHERE key = 'deviceId'"))!.value
  }
}

export interface AccountsOptions {
  /** The host's providers (the relay), usable by everyone and not listed as accounts. */
  host: ModelSetup
  secretKey: string | undefined
  /** OAuth logins need a callback the host can receive or a code pasted back; Workers hosts leave them off. */
  oauth: boolean
}

/** One user's models: the host's providers plus pi-ai's built-in ones signed in with the user's own credentials. */
export class ModelAccounts {
  readonly models: MutableModels
  readonly #store: SealedCredentialStore
  readonly #o: AccountsOptions
  readonly #deviceId: string
  readonly #listeners = new Set<() => void>()
  readonly #hostIds: Set<string>
  #configured: readonly CredentialInfo[]

  private constructor(store: SealedCredentialStore, options: AccountsOptions, deviceId: string, configured: readonly CredentialInfo[]) {
    this.#store = store
    this.#o = options
    this.#deviceId = deviceId
    this.#configured = configured
    this.#hostIds = new Set(options.host.providers.map((p) => p.id))
    this.models = builtinModels({ credentials: store, authContext: NO_AMBIENT_AUTH })
    for (const p of options.host.providers) this.models.setProvider(p)
  }

  static async open(db: SqliteDatabase, options: AccountsOptions) {
    const store = await SealedCredentialStore.open(db, options.secretKey)
    return new ModelAccounts(store, options, await store.deviceId(), await store.list())
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  async #changed() {
    this.#configured = await this.#store.list()
    for (const l of this.#listeners) l()
  }

  /** Providers a user can sign in to, in pi-ai's order. */
  providers(): ProviderState[] {
    const out: ProviderState[] = []
    for (const p of this.models.getProviders()) {
      if (this.#hostIds.has(p.id)) continue
      const apiKey = p.auth.apiKey?.login ? p.auth.apiKey.name : null
      const oauth = this.#o.oauth && p.auth.oauth ? (p.auth.oauth.loginLabel ?? p.auth.oauth.name) : null
      if (!apiKey && !oauth) continue
      const configured = this.#configured.find((c) => c.providerId === p.id)?.type ?? null
      out.push({ id: p.id, name: p.name, apiKey, oauth, configured })
    }
    return out
  }

  /** The host's models, then those of each signed-in provider. */
  async list(): Promise<ModelInfo[]> {
    const own = await Promise.all(
      this.#configured
        .filter((c) => !this.#hostIds.has(c.providerId))
        .map((c) => this.models.getAvailable(c.providerId).catch(() => [])),
    )
    return [...this.#o.host.options, ...own.flat().map((m) => ({ provider: m.provider, id: m.id, name: m.name }))]
  }

  async defaultModel() {
    return this.#o.host.defaultModel ?? (await this.list())[0] ?? null
  }

  async login(providerId: string, type: AuthType, interaction: AuthInteraction) {
    const state = this.providers().find((p) => p.id === providerId)
    if (!state || !(type === 'api_key' ? state.apiKey : state.oauth)) throw new Error('这个服务不支持这种登录方式')
    await this.models.login(providerId, type, interaction, { getDeviceId: () => this.#deviceId, agentName: 'gense' })
    await this.#changed()
  }

  async logout(providerId: string) {
    if (this.#hostIds.has(providerId)) throw new Error('不能退出服务器提供的模型')
    await this.models.logout(providerId)
    await this.#changed()
  }
}

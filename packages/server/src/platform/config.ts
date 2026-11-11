// Host settings from the environment (.env at the repo root; see .env.example).
import { fauxModels, pluginDefaultsFromEnv, type ModelSetup, type SpaceOptions } from '../index.ts'
import { resolve } from 'node:path'
import type { BackupOptions } from './backup.ts'

export interface HostConfig {
  /** Optional channel transport settings (also allow local integration platforms). */
  feishu?: Omit<import('../channels/feishu/index.ts').FeishuOptions, 'publicUrl'>
  publicUrl?: string
  dataDir: string
  port: number
  host: string
  /** Built front end; missing in dev, where Vite serves it. */
  webDir: string
  /** Development/test providers. Production shared models are registered in app.sqlite. */
  models: () => ModelSetup
  /** Plugin defaults from `.env`. */
  plugins: NonNullable<SpaceOptions['plugins']>
  /** TOKEN_ENCRYPTION_KEY: seals plugin secrets, model credentials and webhook secrets. */
  secretKey?: string
  /** Runs `bash` in a Docker container (D7); off with SANDBOX=0. */
  sandbox?: { memory?: string; cpus?: string; idleMs?: number }
  /** Daily copies of the database under `<dataDir>/backups`; off with BACKUPS=0. */
  backups?: BackupOptions | false
}

const root = resolve(import.meta.dirname, '../../../..')

export function configFromEnv(env = process.env): HostConfig {
  return {
    publicUrl: env.PUBLIC_URL || undefined,
    dataDir: resolve(root, env.DATA_DIR ?? 'data'),
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    webDir: resolve(root, 'packages/web/dist'),
    models: env.GENSE_FAUX === '1' ? fauxModels : () => ({ providers: [], options: [], defaultModel: null }),
    plugins: { defaults: pluginDefaultsFromEnv(env) },
    secretKey: env.TOKEN_ENCRYPTION_KEY || undefined,
    sandbox:
      env.SANDBOX === '0'
        ? undefined
        : {
            memory: env.SANDBOX_MEMORY || undefined,
            cpus: env.SANDBOX_CPUS || undefined,
            idleMs: env.SANDBOX_IDLE_MINUTES ? Number(env.SANDBOX_IDLE_MINUTES) * 60_000 : undefined,
          },
    backups: env.BACKUPS === '0' ? false : { keep: env.BACKUP_KEEP ? Number(env.BACKUP_KEEP) : undefined },
  }
}

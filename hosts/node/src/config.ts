// Host settings from the environment (.env at the repo root; see .env.example).
import { fauxModels, pluginDefaultsFromEnv, relayFromEnv, type ModelSetup, type SpaceOptions } from '@gense/core'
import { resolve } from 'node:path'

export interface HostConfig {
  dataDir: string
  port: number
  host: string
  /** Built front end; missing in dev, where Vite serves it. */
  webDir: string
  /** The host's own providers; a function so each user's Models gets its own instances. */
  models: () => ModelSetup
  /** Enables the admin endpoint for adding users over HTTP; the CLI does not need it. */
  adminToken?: string
  /** Plugin defaults from `.env`. */
  plugins: NonNullable<SpaceOptions['plugins']>
  /** TOKEN_ENCRYPTION_KEY: seals users' plugin secrets and model credentials. */
  secretKey?: string
  /** Runs `bash` in a Docker container per user (D7); off with SANDBOX=0. */
  sandbox?: { memory?: string; cpus?: string; idleMs?: number }
}

const root = resolve(import.meta.dirname, '../../..')

export function configFromEnv(env = process.env): HostConfig {
  return {
    dataDir: resolve(root, env.DATA_DIR ?? 'data'),
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    webDir: resolve(root, 'packages/web/dist'),
    models: env.GENSE_FAUX === '1' ? fauxModels : () => relayFromEnv(env),
    adminToken: env.ADMIN_TOKEN || undefined,
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
  }
}

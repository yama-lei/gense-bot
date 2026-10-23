// Host settings from the environment (.env at the repo root; see .env.example).
import { fauxModels, relayFromEnv, type ModelSetup } from '@gense/core'
import { resolve } from 'node:path'

export interface HostConfig {
  dataDir: string
  port: number
  host: string
  /** Built front end; missing in dev, where Vite serves it. */
  webDir: string
  /** A function so each user's Harness gets its own catalog (stage 3 adds per-user credentials). */
  models: () => ModelSetup
  /** Enables the admin endpoint for adding users over HTTP; the CLI does not need it. */
  adminToken?: string
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
  }
}

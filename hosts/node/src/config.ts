// Host settings from the environment (.env at the repo root; see .env.example).
import { relayModels, type ModelSetup } from '@gense/core'
import { resolve } from 'node:path'
import { fauxModels } from './faux.ts'

export interface HostConfig {
  dataDir: string
  port: number
  host: string
  /** Built front end; missing in dev, where Vite serves it. */
  webDir: string
  /** A function so each user's Harness gets its own catalog (stage 3 adds per-user credentials). */
  models: () => ModelSetup
}

const root = resolve(import.meta.dirname, '../../..')

export function configFromEnv(env = process.env): HostConfig {
  return {
    dataDir: resolve(root, env.DATA_DIR ?? 'data'),
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    webDir: resolve(root, 'packages/web/dist'),
    models: env.GENSE_FAUX === '1' ? fauxModels : () => relayFromEnv(env),
  }
}

function relayFromEnv(env: NodeJS.ProcessEnv) {
  const baseUrl = env.PROVIDER_BASE_URL
  const apiKey = env.PROVIDER_AUTH_TOKEN
  if (!baseUrl || !apiKey) throw new Error('PROVIDER_BASE_URL and PROVIDER_AUTH_TOKEN must be set (or GENSE_FAUX=1)')
  const ids = [env.DEFAULT_PROVIDER_MODEL, ...(env.PROVIDER_MODELS ?? '').split(',')].map((s) => s?.trim()).filter((s): s is string => !!s)
  return relayModels({ baseUrl, apiKey, modelIds: [...new Set(ids)] })
}

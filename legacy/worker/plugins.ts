import type { WorkerEnv } from './env'
import { pluginReadiness } from '../src/plugins/catalog'
import type { PluginValue } from '../src/types'

// Plugin settings on the server (docs/plans/roadmap-2.md "L0-5 插件配置"): what `.env` supplies
// when the user sets nothing, and which tools a plugin can offer with its resolved settings.

export type PluginConfig = Record<string, PluginValue>

/** Values the deployment supplies per plugin; the customize page only learns which keys exist. */
export function serverSettings(env: WorkerEnv): Record<string, Record<string, string | undefined>> {
  const openai = !!(env.OPENAI_BASE_URL && env.OPENAI_AUTH_TOKEN)
  return {
    web: { deepseekKey: env.DEEPSEEK_API_KEY || undefined, researchModel: openai ? env.DEFAULT_OPENAI_MODEL || undefined : undefined },
    image: { baseUrl: openai ? env.OPENAI_BASE_URL : undefined, apiKey: openai ? env.OPENAI_AUTH_TOKEN : undefined },
  }
}

/** Keys with a server value, per plugin. */
export function serverKeys(env: WorkerEnv): Record<string, string[]> {
  return Object.fromEntries(Object.entries(serverSettings(env)).map(([id, s]) => [id, Object.keys(s).filter((k) => s[k])]))
}

/** `pluginReadiness` from the catalog, with whether this deployment has an OpenAI endpoint. */
export const readiness = (id: string, config: PluginConfig, env: WorkerEnv) => pluginReadiness(id, config, !!(env.OPENAI_BASE_URL && env.OPENAI_AUTH_TOKEN))

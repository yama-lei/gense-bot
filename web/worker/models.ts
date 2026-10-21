import type { WorkerEnv } from './env'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { Effort, ModelOption, Provider } from '../src/types'

const EFFORTS: Effort[] = ['low', 'medium', 'high']

/** Strips trailing slashes and appends `/v1` when missing. */
export function v1(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return base.endsWith('/v1') ? base : `${base}/v1`
}

/** Providers whose endpoint is configured in `.env`. */
export function providers(env: WorkerEnv): Provider[] {
  const out: Provider[] = []
  if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN) out.push('anthropic')
  if (env.OPENAI_BASE_URL && env.OPENAI_AUTH_TOKEN) out.push('openai')
  return out
}

export function defaultModel(env: WorkerEnv): string | null {
  if (env.ANTHROPIC_BASE_URL && env.DEFAULT_ANTHROPIC_MODEL) return `anthropic:${env.DEFAULT_ANTHROPIC_MODEL}`
  if (env.OPENAI_BASE_URL && env.DEFAULT_OPENAI_MODEL) return `openai:${env.DEFAULT_OPENAI_MODEL}`
  return null
}

/** Splits a `provider:id` key; the id itself may contain colons. */
export function parseModelKey(key: string): { provider: Provider; id: string } | null {
  const i = key.indexOf(':')
  const provider = key.slice(0, i)
  if (i < 1 || (provider !== 'anthropic' && provider !== 'openai')) return null
  return { provider, id: key.slice(i + 1) }
}

export function languageModel(env: WorkerEnv, provider: Provider, id: string): LanguageModel {
  return provider === 'openai'
    ? createOpenAI({ baseURL: v1(env.OPENAI_BASE_URL), apiKey: env.OPENAI_AUTH_TOKEN })(id)
    : createAnthropic({ baseURL: v1(env.ANTHROPIC_BASE_URL), authToken: env.ANTHROPIC_AUTH_TOKEN })(id)
}

/** Maps the chosen effort to each provider's own parameter. */
export function effortOptions(provider: Provider, effort: Effort | undefined): Record<string, Record<string, string>> | undefined {
  if (!effort) return undefined
  return provider === 'openai' ? { openai: { reasoningEffort: effort } } : { anthropic: { effort } }
}

/** `GET /v1/models` on one endpoint, following Anthropic's cursor pagination. */
export async function listEndpointModels(env: WorkerEnv, provider: Provider): Promise<string[]> {
  const base = v1(provider === 'openai' ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL)
  const headers: Record<string, string> =
    provider === 'openai' ? { Authorization: `Bearer ${env.OPENAI_AUTH_TOKEN}` } : { Authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`, 'anthropic-version': '2023-06-01' }
  const ids: string[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${base}/models`)
    if (provider === 'anthropic') {
      url.searchParams.set('limit', '1000')
      if (after) url.searchParams.set('after_id', after)
    }
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`${provider} /v1/models: HTTP ${res.status}`)
    const body = (await res.json()) as { data?: { id: string }[]; has_more?: boolean; last_id?: string }
    ids.push(...(body.data ?? []).map((m) => m.id))
    if (!body.has_more || !body.last_id) break
    after = body.last_id
  }
  return ids
}

interface ModelsDevEntry {
  name?: string
  tool_call?: boolean
  reasoning_options?: { type: string; values?: string[] }[]
  limit?: { context?: number }
  modalities?: { input?: string[] }
}

/** Reduces models.dev `api.json` to the capabilities of the given endpoint models. */
export function pickCapabilities(api: unknown, provider: Provider, ids: string[]): Record<string, ModelOption['capabilities'] & { name?: string }> {
  const models = ((api as Record<string, { models?: Record<string, ModelsDevEntry> }>)[provider]?.models ?? {}) as Record<string, ModelsDevEntry>
  const out: Record<string, ModelOption['capabilities'] & { name?: string }> = {}
  for (const id of ids) {
    // Fall back to the id without a date suffix, e.g. `-20251001`.
    const entry = models[id] ?? models[id.replace(/-\d{8}$/, '')]
    if (!entry) continue
    const values = entry.reasoning_options?.find((o) => o.type === 'effort')?.values ?? []
    out[id] = {
      name: entry.name,
      toolCall: entry.tool_call !== false,
      efforts: EFFORTS.filter((e) => values.includes(e)),
      context: entry.limit?.context ?? 0,
      image: entry.modalities?.input?.includes('image') ?? false,
    }
  }
  return out
}

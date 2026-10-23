// The default model endpoint: an OpenAI-compatible relay configured by the host (.env PROVIDER_*; roadmap-3 D1).
import { createProvider, type Provider } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { ModelInfo } from './protocol.ts'

/** The host's own providers, which every user can use; users add pi-ai's built-in ones with their credentials (D11). */
export interface ModelSetup {
  providers: Provider[]
  /** The host providers' models the user can pick, in display order. */
  options: ModelInfo[]
  defaultModel: ModelInfo | null
}

export interface RelayConfig {
  baseUrl: string
  apiKey: string
  /** Offered models; the first is the default. */
  modelIds: string[]
}

export const RELAY_PROVIDER = 'relay'

export function relayModels(config: RelayConfig): ModelSetup {
  const provider = createProvider({
    id: RELAY_PROVIDER,
    name: 'Relay',
    baseUrl: config.baseUrl,
    auth: { apiKey: { name: 'relay', resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
    models: config.modelIds.map((id) => ({
      id,
      name: id,
      api: 'openai-responses',
      provider: RELAY_PROVIDER,
      baseUrl: config.baseUrl,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    })),
    api: openAIResponsesApi(),
  })
  const options = config.modelIds.map((id) => ({ provider: RELAY_PROVIDER, id, name: id }))
  return { providers: [provider], options, defaultModel: options[0] ?? null }
}

/** The relay from the host's environment: PROVIDER_BASE_URL, PROVIDER_AUTH_TOKEN, DEFAULT_PROVIDER_MODEL, PROVIDER_MODELS. */
export function relayFromEnv(env: Record<string, string | undefined>): ModelSetup {
  const baseUrl = env.PROVIDER_BASE_URL
  const apiKey = env.PROVIDER_AUTH_TOKEN
  if (!baseUrl || !apiKey) throw new Error('PROVIDER_BASE_URL and PROVIDER_AUTH_TOKEN must be set (or GENSE_FAUX=1)')
  const ids = [env.DEFAULT_PROVIDER_MODEL, ...(env.PROVIDER_MODELS ?? '').split(',')].map((s) => s?.trim()).filter((s): s is string => !!s)
  return relayModels({ baseUrl, apiKey, modelIds: [...new Set(ids)] })
}

// OpenAI-compatible shared model providers (ADR-0006); host metadata and sealed keys live in app.sqlite.
import { createProvider, type Provider } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { ModelInfo, ProviderKind } from '@gense/protocol'

/** The host's own providers, which every user can use; users add pi-ai's built-in ones with their credentials (D11). */
export interface ModelSetup {
  providers: Provider[]
  /** The host providers' models the user can pick, in display order. */
  options: ModelInfo[]
  defaultModel: ModelInfo | null
  kinds?: Record<string, ProviderKind>
}

export interface RelayConfig {
  providerId?: string
  name?: string
  baseUrl: string
  apiKey: string
  /** Offered models; the first is the default. */
  modelIds: string[]
}

export const RELAY_PROVIDER = 'relay'

export function relayModels(config: RelayConfig): ModelSetup {
  const providerId = config.providerId ?? RELAY_PROVIDER
  const provider = createProvider({
    id: providerId,
    name: config.name ?? 'Relay',
    baseUrl: config.baseUrl,
    auth: { apiKey: { name: 'relay', resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
    models: config.modelIds.map((id) => ({
      id,
      name: id,
      api: 'openai-responses',
      provider: providerId,
      baseUrl: config.baseUrl,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    })),
    api: openAIResponsesApi(),
  })
  const options = config.modelIds.map((id) => ({ provider: providerId, ...(config.name && { providerName: config.name }), id, name: id, source: 'shared' as const }))
  return { providers: [provider], options, defaultModel: options[0] ?? null, kinds: { [providerId]: 'openai' } }
}

/** The relay from the host's environment: PROVIDER_BASE_URL, PROVIDER_AUTH_TOKEN, DEFAULT_PROVIDER_MODEL, PROVIDER_MODELS. */
export function relayFromEnv(env: Record<string, string | undefined>): ModelSetup {
  const baseUrl = env.PROVIDER_BASE_URL
  const apiKey = env.PROVIDER_AUTH_TOKEN
  if (!baseUrl || !apiKey) throw new Error('PROVIDER_BASE_URL and PROVIDER_AUTH_TOKEN must be set (or GENSE_FAUX=1)')
  const ids = [env.DEFAULT_PROVIDER_MODEL, ...(env.PROVIDER_MODELS ?? '').split(',')].map((s) => s?.trim()).filter((s): s is string => !!s)
  return relayModels({ baseUrl, apiKey, modelIds: [...new Set(ids)] })
}

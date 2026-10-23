// The default model endpoint: an OpenAI-compatible relay configured by the host (.env PROVIDER_*; roadmap-3 D1).
import { createModels, createProvider, type Models } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { ModelInfo } from './protocol.ts'

export interface ModelSetup {
  models: Models
  /** Models the user can pick, in display order. */
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
  const models = createModels()
  models.setProvider(
    createProvider({
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
    }),
  )
  const options = config.modelIds.map((id) => ({ provider: RELAY_PROVIDER, id, name: id }))
  return { models, options, defaultModel: options[0] ?? null }
}

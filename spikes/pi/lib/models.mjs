// Registers our relay (OpenAI-compatible: Responses and Chat Completions) in pi-ai. Secrets come from the environment only.
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

const env = process.env
export const mk = (api, id) => ({
  id, name: id, api, provider: 'relay', baseUrl: env.PROVIDER_BASE_URL, reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000,
})

export const RELAY = { provider: 'relay', modelId: env.DEFAULT_PROVIDER_MODEL }
export const redact = (s) => String(s).split(env.PROVIDER_AUTH_TOKEN).join('***')

export function relayModels() {
  const models = createModels()
  models.setProvider(createProvider({
    id: 'relay', name: 'relay', baseUrl: env.PROVIDER_BASE_URL,
    auth: { apiKey: { name: 'relay', resolve: async () => ({ auth: { apiKey: env.PROVIDER_AUTH_TOKEN } }) } },
    models: [mk('openai-responses', RELAY.modelId)], api: openAIResponsesApi(),
  }))
  return models
}

// Registers our two relays in pi-ai. Secrets come from the environment only.
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'

const env = process.env
const mk = (api, provider, baseUrl, id) => ({
  id, name: id, api, provider, baseUrl, reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000,
})

export const ANTHROPIC = { provider: 'relay-anthropic', modelId: env.DEFAULT_ANTHROPIC_MODEL }
export const OPENAI = { provider: 'relay-openai', modelId: env.DEFAULT_OPENAI_MODEL }

export function relayModels() {
  const models = createModels()
  models.setProvider(createProvider({
    id: 'relay-openai', name: 'relay-openai', baseUrl: env.OPENAI_BASE_URL,
    auth: { apiKey: { name: 'relay', resolve: async () => ({ auth: { apiKey: env.OPENAI_AUTH_TOKEN } }) } },
    models: [mk('openai-responses', 'relay-openai', env.OPENAI_BASE_URL, OPENAI.modelId)], api: openAIResponsesApi(),
  }))
  models.setProvider(createProvider({
    id: 'relay-anthropic', name: 'relay-anthropic', baseUrl: env.ANTHROPIC_BASE_URL,
    auth: { apiKey: { name: 'relay', resolve: async () => ({ auth: { apiKey: env.ANTHROPIC_AUTH_TOKEN } }) } },
    models: [mk('anthropic-messages', 'relay-anthropic', env.ANTHROPIC_BASE_URL, ANTHROPIC.modelId)], api: anthropicMessagesApi(),
  }))
  return models
}

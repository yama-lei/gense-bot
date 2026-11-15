// DeepSeek providers and their Messages adapter (roadmap-7 C). App extensions are model capabilities, not IDs.
import { createProvider, type ProviderAuth, type ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { DEEPSEEK_APP_MODELS, DEEPSEEK_BASE_URL } from '@gense/protocol'
import type { ModelSetup } from './models.ts'

export const deepseekAppModel = (id: string) => (DEEPSEEK_APP_MODELS as readonly string[]).includes(id)
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro']

export function deepseekMessagesApi(): ProviderStreams { return anthropicMessagesApi() }

export function deepseekModels(config: { providerId?: string; name?: string; baseUrl?: string; modelIds?: string[]; apiKey?: string }): ModelSetup {
  const builtin = deepseekProvider()
  const providerId = config.providerId ?? builtin.id
  const baseUrl = (config.baseUrl || DEEPSEEK_BASE_URL).replace(/\/+$/, '') + '/anthropic'
  const ids = config.modelIds?.length ? config.modelIds : DEEPSEEK_MODELS
  const auth: ProviderAuth = config.apiKey
    ? { apiKey: { name: 'DeepSeek', resolve: async () => ({ auth: { apiKey: config.apiKey! } }) } }
    : builtin.auth
  const provider = createProvider({
    id: providerId, name: config.name ?? builtin.name, baseUrl, auth,
    models: ids.map(id => {
      const known = builtin.getModels().find(m => m.id === id)
      return {
        id, name: known?.name ?? id, provider: providerId, api: 'anthropic-messages' as const, baseUrl,
        reasoning: true, input: known?.input ?? ['text' as const],
        cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: known?.contextWindow ?? 1_000_000, maxTokens: known?.maxTokens ?? 128_000,
        compat: { supportsEagerToolInputStreaming: false, supportsCacheControlOnTools: false, allowEmptySignature: true },
      }
    }),
    api: deepseekMessagesApi(),
  })
  const options = provider.getModels().map(m => ({ provider: providerId, providerName: provider.name, id: m.id, name: m.name, source: config.apiKey ? 'shared' as const : 'byok' as const }))
  return { providers: [provider], options, defaultModel: options[0] ?? null, kinds: { [providerId]: 'deepseek' } }
}

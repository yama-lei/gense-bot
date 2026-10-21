import type { WorkerEnv } from './env'
import { Think, type ChatResponseResult, type TurnConfig, type TurnContext } from '@cloudflare/think'
import { getAgentByName } from 'agents'
import type { Effort, TurnMetadata } from '../src/types'
import { defaultModel, effortOptions, languageModel, parseModelKey } from './models'
import { enabledTools, pluginTools } from './tools'

const BASE_PROMPT = `你是 GenseBot，一个私人助手。回答简洁、准确；不确定时直说。
需要展示较长的提纲、报告或代码时，用 artifact_create 工具展示，而不是直接贴在回复里。`

/**
 * One conversation (architecture "Agent 拓扑"). A top-level Durable Object created by the
 * owner's UserHub, which also forwards every request to it after the Worker checked Access.
 */
export class Chat extends Think<WorkerEnv> {
  // Circuit breakers (spec "兜底限制"): bound tool loops and stuck streams.
  maxSteps = 20
  chatStreamStallTimeoutMs = 120_000
  chatRecovery = true as const

  /** Called once by the hub right after creating this chat. */
  bind(owner: string, id: string) {
    this.ctx.storage.kv.put('owner', owner)
    this.ctx.storage.kv.put('id', id)
  }

  private hub() {
    const owner = this.ctx.storage.kv.get<string>('owner')
    if (!owner) throw new Error('chat is not bound to a user')
    return getAgentByName(this.env.UserHub, owner)
  }

  getModel() {
    const key = parseModelKey(defaultModel(this.env) ?? '')
    if (!key) throw new Error('未配置模型端点')
    return languageModel(this.env, key.provider, key.id)
  }

  getSystemPrompt() {
    return BASE_PROMPT
  }

  // All plugin tools are registered; beforeTurn narrows them to the enabled ones.
  getTools() {
    return enabledTools(Object.keys(pluginTools))
  }

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const settings = await (await this.hub()).turnSettings()
    const kv = this.ctx.storage.kv
    // Continuations and recovered turns carry no body; reuse the last choice.
    const body = ctx.body ?? {}
    const requested = typeof body.model === 'string' ? body.model : (kv.get<string>('model') ?? defaultModel(this.env) ?? '')
    const key = parseModelKey(requested)
    const option = key && settings.models.find((m) => m.provider === key.provider && m.id === key.id)
    // Accept only models the endpoints list; the default is always allowed so a model-list outage does not block chat.
    if (!key || (!option && requested !== defaultModel(this.env))) throw new Error(`模型不可用：${requested}`)
    const caps = option?.capabilities
    const wanted = body.effort === 'low' || body.effort === 'medium' || body.effort === 'high' ? (body.effort as Effort) : kv.get<Effort>('effort')
    const effort = wanted && caps?.efforts.includes(wanted) ? wanted : undefined
    kv.put('model', requested)
    if (wanted) kv.put('effort', wanted)

    const tools = Object.keys(enabledTools(settings.enabledPlugins))
    const system = [
      ctx.system,
      `回复语言：${settings.language}。`,
      settings.memories.length ? `关于用户（用户在设置里写下的记忆）：\n${settings.memories.map((m) => `- ${m}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const metadata: TurnMetadata = { model: requested, effort: wanted ?? 'medium', createdAt: Date.now() }

    return {
      model: languageModel(this.env, key.provider, key.id),
      system,
      // Hides Think's built-in workspace tools; a model without tool calling gets none.
      activeTools: caps?.toolCall === false ? [] : tools,
      providerOptions: effortOptions(key.provider, effort),
      messageMetadata: ({ part }) => (part.type === 'start' ? { ...metadata } : undefined),
    }
  }

  async onChatResponse(result: ChatResponseResult) {
    if (result.status === 'aborted') return
    const id = this.ctx.storage.kv.get<string>('id')
    if (!id) return
    try {
      await (await this.hub()).recordTurn(id, this.ctx.storage.kv.get<string>('model') ?? '')
    } catch (e) {
      // The list order is a derived projection; a failed push only leaves it stale.
      console.warn('recordTurn failed', e)
    }
  }
}

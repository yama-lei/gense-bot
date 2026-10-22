// V1: can pi-ai talk to our OpenAI-/Anthropic-compatible relays? Prints no secrets.
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'

const env = process.env
const mk = (api, provider, baseUrl, id) => ({
  id, name: id, api, provider, baseUrl, reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000,
})
const oaiModel = mk('openai-responses', 'relay-openai', env.OPENAI_BASE_URL, env.DEFAULT_OPENAI_MODEL)
const antModel = mk('anthropic-messages', 'relay-anthropic', env.ANTHROPIC_BASE_URL, env.DEFAULT_ANTHROPIC_MODEL)

const models = createModels()
models.setProvider(createProvider({
  id: 'relay-openai', name: 'relay-openai', baseUrl: env.OPENAI_BASE_URL,
  auth: { apiKey: { name: 'relay', resolve: async () => ({ auth: { apiKey: env.OPENAI_AUTH_TOKEN } }) } },
  models: [oaiModel], api: openAIResponsesApi(),
}))
models.setProvider(createProvider({
  id: 'relay-anthropic', name: 'relay-anthropic', baseUrl: env.ANTHROPIC_BASE_URL,
  auth: { apiKey: { name: 'relay', resolve: async () => ({ auth: { apiKey: env.ANTHROPIC_AUTH_TOKEN } }) } },
  models: [antModel], api: anthropicMessagesApi(),
}))

const weather = {
  name: 'get_weather', description: 'Get the weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}
const redact = (s) => String(s).split(env.OPENAI_AUTH_TOKEN).join('***').split(env.ANTHROPIC_AUTH_TOKEN).join('***')

async function run(label, model, context, options = {}) {
  const t0 = Date.now()
  try {
    const stream = models.stream(model, context, options)
    let deltas = 0
    for await (const ev of stream) if (ev.type === 'text_delta') deltas++
    const msg = await stream.result()
    const kinds = msg.content.map((c) => c.type)
    const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('').slice(0, 80)
    const calls = msg.content.filter((c) => c.type === 'toolCall').map((c) => `${c.name}(${JSON.stringify(c.arguments)})`)
    console.log(`PASS ${label} ${Date.now() - t0}ms stop=${msg.stopReason} deltas=${deltas} kinds=${kinds} usage=${JSON.stringify(msg.usage)} text=${JSON.stringify(text)} calls=${calls}`)
    return msg
  } catch (e) {
    console.log(`FAIL ${label}: ${redact(e?.message ?? e)}`)
  }
}

for (const [name, model] of [['openai-responses', oaiModel], ['anthropic-messages', antModel]]) {
  const ask = { messages: [{ role: 'user', content: '用一句话介绍你自己。', timestamp: Date.now() }] }
  await run(`${name} stream`, model, ask)
  const tool = { messages: [{ role: 'user', content: '北京天气怎么样？请调用工具查询。', timestamp: Date.now() }], tools: [weather] }
  const first = await run(`${name} tool-call`, model, tool)
  const call = first?.content.find((c) => c.type === 'toolCall')
  if (call) {
    const ctx = {
      ...tool,
      messages: [...tool.messages, first, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: '晴，22 度' }], isError: false, timestamp: Date.now() }],
    }
    await run(`${name} tool-result`, model, ctx)
  }
  await run(`${name} reasoning=high`, model, ask, { reasoning: 'high' })
}

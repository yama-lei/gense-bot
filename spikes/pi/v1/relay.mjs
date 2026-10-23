// V1: can pi-ai talk to our relay? Prints no secrets.
import { RELAY, redact, relayModels } from '../lib/models.mjs'

const models = relayModels()
const model = models.getModel(RELAY.provider, RELAY.modelId)

const weather = {
  name: 'get_weather', description: 'Get the weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}

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

{
  const name = 'openai-responses'
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

// V5: what does watch() push while a long answer streams, and how does frame size grow with history?
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai'

const faux = fauxProvider({ tokensPerSecond: 400 })
const models = createModels()
models.setProvider(faux.provider)
const model = faux.getModel()
const h = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx)
const root = await h.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } })

const watch = await root.watch(ctx)
let frames = 0, bytes = 0, maxFrame = 0, first = 0
watch.start(async (_value, ops) => {
  const n = JSON.stringify(ops).length
  frames++; bytes += n; maxFrame = Math.max(maxFrame, n); if (!first) first = n
})
const turn = async (i, chars) => {
  faux.setResponses([fauxAssistantMessage([fauxText('字'.repeat(chars))])])
  frames = 0; bytes = 0; maxFrame = 0; first = 0
  const t0 = Date.now()
  const sub = await root.submit({ type: 'input', content: `第 ${i} 轮` }, ctx)
  await sub.wait(ctx)
  await new Promise((r) => setTimeout(r, 300))
  console.log(`turn ${i}: ${chars} chars answer, ${Date.now() - t0}ms, frames=${frames}, total=${(bytes / 1024).toFixed(1)}KB, maxFrame=${(maxFrame / 1024).toFixed(1)}KB`)
}
await turn(1, 4000)
for (let i = 2; i <= 60; i++) faux.setResponses([fauxAssistantMessage([fauxText('字'.repeat(300))])]), await (await root.submit({ type: 'input', content: `填充 ${i}` }, ctx)).wait(ctx)
await turn(61, 4000)
await watch.stop()
const view = await root.viewState(ctx)
console.log('view entries', view.value.entries.length, 'snapshot', (JSON.stringify(view.value).length / 1024).toFixed(0) + 'KB')
view.dispose()
await h.close(ctx)

// Developer mode's trace (web lib/trace.ts) over the view a real host streams to the browser: model requests, tool
// runs, and the system prompt and tools each request saw, replayed from pi's `pi.system` entries.
import type { TreeMeta } from '@gense/protocol'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { toTrace, systemPromptText } from '../../web/src/lib/trace.ts'
import { Client, login, tempDir } from './host-helpers.ts'

const PASSWORD = 'correct horse'
let server: Awaited<ReturnType<typeof startServer>>

before(async () => {
  server = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir() }), port: 0 })
  await server.auth.register('owner@example.com', PASSWORD)
})
after(() => server.close())

test('the trace lists each model request and tool run with the context it saw', async () => {
  const { cookie } = await login(server.url, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })

  await client.request({ t: 'send', treeId: tree.id, text: '你好', requestId: 'a' })
  await client.until(() => client.views.get(tree.id)?.entries.some((e) => e.kind === 'pi.assistant'), 10_000, 'first answer')
  await client.request({ t: 'send', treeId: tree.id, text: '[工具 write] {"path":"note.md","content":"hi"}', requestId: 'b' })
  await client.until(() => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.assistant').length === 3, 10_000, 'tool answer')
  await client.until(() => !(client.views.get(tree.id)!.docs['pi.live'] as { run?: unknown } | undefined)?.run, 10_000, 'idle')

  const view = client.views.get(tree.id)!
  const trace = toTrace(view as Parameters<typeof toTrace>[0])
  assert.deepEqual(
    trace.turns.map((t) => t.label),
    ['你好', '[工具 write] {"path":"note.md","content":"hi"}'],
  )
  // The turns carry the transcript's ids: the user entries that opened them.
  assert.deepEqual(trace.turns.map((t) => t.id), view.entries.filter((e) => e.kind === 'pi.user').map((e) => String(e.id)))

  const [first, second] = trace.turns
  const firstCalls = first!.steps.filter((s) => s.kind === 'model')
  assert.equal(firstCalls.length, 1)
  const call = firstCalls[0]!
  assert.equal(call.model, 'faux-1')
  assert.ok(call.durationMs !== undefined && call.usage, 'timing and usage come with the call')
  // The first request saw the whole prompt and the tool list.
  assert.ok(first!.steps.some((s) => s.kind === 'system' && s.baseline))
  assert.ok(call.context.sections.some(([key]) => key === 'assistant'))
  assert.match(systemPromptText(call.context), /<assistant>/)
  assert.ok(call.context.tools.some((t) => t.name === 'write' && t.parameters))
  assert.equal(call.context.messages, 1)

  const kinds = second!.steps.filter((s) => s.kind !== 'system').map((s) => s.kind)
  assert.deepEqual(kinds, ['model', 'tool', 'model'])
  const tool = second!.steps.find((s) => s.kind === 'tool')!
  assert.equal(tool.kind === 'tool' && tool.name, 'write')
  assert.deepEqual(tool.kind === 'tool' && tool.input, { path: 'note.md', content: 'hi' })
  assert.equal(tool.kind === 'tool' && tool.isError, false)
  const [ask, answer] = second!.steps.filter((s) => s.kind === 'model')
  assert.ok(ask!.kind === 'model' && ask.output.some((p) => p.type === 'toolCall' && p.name === 'write'))
  // The answer after the tool saw everything before it: two user messages, two answers and the tool result.
  assert.equal(answer!.kind === 'model' && answer.context.messages, 5)
  assert.equal(answer!.kind === 'model' && answer.n, 3)

  assert.equal(trace.totals.calls, 3)
  assert.equal(trace.totals.tools, 1)
  client.close()
})

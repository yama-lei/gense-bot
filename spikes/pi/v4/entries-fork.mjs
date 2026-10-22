// V4 (custom entry kinds), V3 (fork prompt cache), restart persistence, on SQLite via the real relay.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { AssistantEntry, createRegistry, defineEntry, defineExtension, section, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { rmSync } from 'node:fs'
import { ANTHROPIC, relayModels } from '../lib/models.mjs'

const File = '/tmp/pi-spike-v4.sqlite'
for (const f of [File, File + '-wal', File + '-shm']) rmSync(f, { force: true })

const Event = defineEntry('app.event')
const Note = defineEntry('app.note')
const filler = Array.from({ length: 220 }, (_, i) => `Rule ${i}: always answer briefly and keep the user's language.`).join('\n')
const registry = createRegistry()
registry.install(defineExtension({ name: 'brief', sections: [section('rules', () => filler, { tag: false })] }))

const open = async () => Harness.open(await openNodeSqliteStorage(File), { models: relayModels(), registry }, ctx)
const kinds = async (c) => (await c.entries({ order: 'ascending' }, 100, undefined, ctx)).items.map((e) => e.kind)
const ask = async (c, content, extra = {}) => {
  const sub = await c.submit({ type: 'input', content, ...extra }, ctx)
  const done = await sub.wait(ctx)
  return done
}
const say = (ok, label, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${detail}`)

let h = await open()
const root = await h.root(ctx, { agent: { model: ANTHROPIC } })

// V4a: an input recorded as a custom kind still starts a run and is answered.
const r1 = await ask(root, '[事件] 子 agent “调研A” 已汇报：结论是 42。请用一句话复述。', {
  entry: { kind: Event.kind ?? 'app.event', data: { source: { kind: 'agent', id: 'a1' }, type: 'report' } },
})
const k1 = await kinds(root)
say(r1.status === 'done' && k1.includes('app.event'), 'V4a input with custom entry kind', JSON.stringify(k1))

// V4b: a passive write is appended at once and never starts a run.
const before = (await kinds(root)).length
await root.submit({ type: 'write', entry: { kind: 'app.note', data: { text: '用户打开了文件' } } }, ctx)
const k2 = await kinds(root)
say(k2.length === before + 1 && k2.at(-1) === 'app.note', 'V4b passive write, no run', JSON.stringify(k2.slice(-2)))

// V4c: the model does not see kind/data of the write (only entries with `model` contribute).
const view = await root.context(ctx)
const sawNote = view.messages.some((m) => JSON.stringify(m).includes('用户打开了文件'))
say(!sawNote, 'V4c passive write invisible to model')

// V3: fork at the first assistant answer; compare cache usage of root vs fork on the same prefix.
const first = (await root.entries({ order: 'ascending' }, 100, undefined, ctx)).items.find((e) => AssistantEntry.is(e))
const fork = await root.fork(first.id, { ownership: { kind: 'ownerless' } }, ctx)
const usage = async (c) => {
  const items = (await c.entries({ order: 'descending' }, 20, undefined, ctx)).items
  const a = items.find((e) => AssistantEntry.is(e))
  return a?.model?.[0]?.usage
}
await ask(root, '再说一句话。')
const u1 = await usage(root)
await ask(fork, '另一个问题：1+1 等于几？')
const u2 = await usage(fork)
console.log('root usage', JSON.stringify(u1))
console.log('fork usage', JSON.stringify(u2))
say((u2?.cacheRead ?? 0) > 0, 'V3 fork hits prompt cache of shared prefix', `cacheRead=${u2?.cacheRead}`)
say(JSON.stringify(await kinds(fork)).includes('app.event'), 'fork carries entries up to fork point', JSON.stringify(await kinds(fork)))
say(!(await kinds(fork)).includes('app.note'), 'fork excludes later entries')

// Restart: reopen the same file, history and conversations are still there.
await h.close(ctx)
h = await open()
const root2 = await h.root(ctx)
say(root2.id === root.id && (await kinds(root2)).length >= k2.length, 'reopen keeps root and history', `id=${root2.id === root.id}`)
const fork2 = await h.conversation(fork.id, ctx)
say(!!fork2, 'reopen keeps the fork')
await h.close(ctx)

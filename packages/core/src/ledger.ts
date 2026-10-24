// What each branch has read (roadmap-3 D6: R43–R45). Branches of a tree share one directory, so a file can change
// between a branch reading it and writing it. Each conversation keeps a ledger, path → hash of the content it last
// read or wrote; `write`, `edit` and `delete` refuse an existing file the ledger does not know, or one whose content
// no longer matches. A change by another branch, the user's file panel or `bash` shows up as a different hash.
//
// The file tools also stay inside the tree's directory; the shared Skills and the sandbox's /tmp are read-only. `bash` is not limited (D7).
import type { Context } from '@earendil-works/chord/context'
import { defineDoc, defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { createEditTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { Type } from 'typebox'
import { createDocumentReadTool } from './documents.ts'
import { MountedEnv } from './fs/mounted-env.ts'
import { isUnder, normalizePath } from './fs/paths.ts'
import { SKILLS_DIR } from './workspace.ts'

export const LedgerDoc = defineDoc<{ files: Record<string, string> }>({
  kind: 'app.ledger',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  // A fork has seen what its parent saw.
  fork: 'current',
  initial: () => ({ files: {} }),
  checkpointWhen: () => true,
})

export const MUST_READ = '请先用 read 读取这个文件，再修改它'
export const CHANGED = '文件在你读过之后被修改了，请重新 read 后再改'

async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(hash).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The hash of the file at `path`, or null when there is no such file. */
async function hashOf(env: ExecutionEnv, path: string, ctx: Context) {
  const bytes = await env.readBinaryFile(path, ctx)
  if (bytes.ok) return digest(bytes.value)
  if (bytes.error.code === 'not_found') return null
  throw bytes.error
}

/** `path` as the tool sees it, absolute, after checking it stays where the tool may go. */
async function resolve(env: ExecutionEnv, path: string, write: boolean, ctx: Context) {
  const absolute = await env.absolutePath(path.startsWith('@') ? path.slice(1) : path, ctx)
  if (!absolute.ok) throw absolute.error
  // Symbolic links count where they lead; a path that does not exist yet counts as written.
  const real = await env.canonicalPath(absolute.value, ctx)
  const abs = normalizePath(real.ok ? real.value : absolute.value)
  const root = normalizePath(env.cwd)
  if (isUnder(abs, root) && abs !== root) return absolute.value
  const readable = [SKILLS_DIR, ...(env instanceof MountedEnv ? env.readOnlyMounts : [])]
  if (!write && readable.some((dir) => isUnder(abs, dir))) return absolute.value
  throw new Error(write ? `只能修改本会话工作区（${root}）里的文件` : `只能读取本会话工作区（${root}）和 ${readable.join('、')} 里的文件`)
}

const record = (api: ToolExecutionApi, path: string, hash: string | null, ctx: Context) =>
  api.commit(async (tx) => {
    const ledger = await tx.doc(LedgerDoc, api.conversationId)
    if (hash === null) delete ledger.files[path]
    else ledger.files[path] = hash
  }, ctx)

/**
 * Mutations by this process, one at a time per path, so the check and the write see the same file. Branches of a
 * tree share their host's process: one Durable Object, or the Node server.
 */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(path: string, fn: () => Promise<T>) {
  const run = (queues.get(path) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  queues.set(path, tail)
  void tail.then(() => queues.get(path) === tail && queues.delete(path))
  return run
}

/**
 * Runs `change` on `path` when this conversation may change it: a new file, or one whose content is what the ledger
 * holds. `expected` is the content the change writes, if known, so a call rerun after a crash finds its own write.
 * Afterwards the ledger holds the new content's hash, or none once the file is gone.
 */
function guarded<T>(api: ToolExecutionApi, env: ExecutionEnv, path: string, ctx: Context, change: () => Promise<T>, expected?: string) {
  return serialized(path, async () => {
    const current = await hashOf(env, path, ctx)
    const known = (await api.commit(async (tx) => (await tx.doc(LedgerDoc, api.conversationId)).files[path], ctx)) as string | undefined
    if (current !== (known ?? null)) {
      const rerun = expected !== undefined && current === (await digest(new TextEncoder().encode(expected)))
      if (!rerun) {
        if (current === null) throw new Error(`${CHANGED}（文件已被删除；read 确认后可以重新创建）`)
        throw new Error(known === undefined ? MUST_READ : CHANGED)
      }
    }
    const result = await change()
    await record(api, path, await hashOf(env, path, ctx), ctx)
    return result
  })
}

const envOf = (api: ToolExecutionApi) => {
  if (!api.env) throw new Error('这个会话没有工作区')
  return api.env
}

function readTool(): ToolRegistration {
  const read = createDocumentReadTool()
  return {
    ...read,
    async execute(args, api, ctx) {
      const env = envOf(api)
      const path = await resolve(env, (args as { path: string }).path, false, ctx)
      try {
        return await read.execute({ ...(args as object), path }, api, ctx)
      } finally {
        // The whole file's hash, even when only some lines were read; reading a deleted file lets it be created again.
        const hash = await hashOf(env, path, ctx).catch(() => undefined)
        if (hash !== undefined) await record(api, path, hash, ctx)
      }
    },
  }
}

function writeTool(): ToolRegistration {
  const write = createWriteTool() as unknown as ToolRegistration
  return {
    ...write,
    description: `${write.description} An existing file must be read first.`,
    async execute(args, api, ctx) {
      const env = envOf(api)
      const { content } = args as { content: string }
      const path = await resolve(env, (args as { path: string }).path, true, ctx)
      return guarded(api, env, path, ctx, () => write.execute({ ...(args as object), path }, api, ctx), content)
    },
  }
}

function editTool(): ToolRegistration {
  const edit = createEditTool() as unknown as ToolRegistration
  return {
    ...edit,
    description: `${edit.description} The file must be read first.`,
    async execute(args, api, ctx) {
      const env = envOf(api)
      const path = await resolve(env, (args as { path: string }).path, true, ctx)
      return guarded(api, env, path, ctx, () => edit.execute({ ...(args as object), path }, api, ctx))
    },
  }
}

const deleteTool = defineTool({
  name: 'delete',
  description: 'Delete a file in the workspace. The file must be read first.',
  parameters: Type.Object({ path: Type.String({ description: 'Path to the file to delete (relative or absolute)' }) }),
  async execute({ path: given }, api, ctx) {
    const env = envOf(api)
    const path = await resolve(env, given, true, ctx)
    const info = await env.fileInfo(path, ctx)
    if (!info.ok) throw info.error.code === 'not_found' ? new Error(`没有这个文件：${given}`) : info.error
    if (info.value.kind === 'directory') throw new Error('delete 只删除文件，不删除目录')
    return guarded(api, env, path, ctx, async () => {
      const removed = await env.remove(path, undefined, ctx)
      if (!removed.ok) throw removed.error
      return { output: [{ type: 'text', text: `Deleted ${given}` }] }
    })
  },
}) as unknown as ToolRegistration

/** The file tools: `read` (with documents), `write`, `edit` and `delete`, behind the ledger and the directory check. */
export const fileTools = (): ToolRegistration[] => [readTool(), writeTool(), editTool(), deleteTool]

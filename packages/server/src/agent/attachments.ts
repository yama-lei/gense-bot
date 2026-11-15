// C6: prepare model-readable text alongside attachments; failed optional OCR never prevents a message.
import type { Context } from '@earendil-works/chord/context'
import type { Model } from '@earendil-works/pi-ai'
import type { ParsedAttachment } from '@gense/protocol'
import { createHash } from 'node:crypto'
import { documentKind, extractDocument } from './documents.ts'
import { recognizeFile } from './deepseek-services.ts'
import { treeDir } from './workspace.ts'
import type { UserSpace } from './space.ts'

type Attached = { path: string; mimeType: string; bytes: Uint8Array }
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }) => { if (!r.ok) throw r.error; return r.value }
const locks = new WeakMap<UserSpace, Map<string, Promise<unknown>>>()

async function serial<T>(space: UserSpace, path: string, work: () => Promise<T>): Promise<T> {
  let queue = locks.get(space)
  if (!queue) { queue = new Map(); locks.set(space, queue) }
  const current = (queue.get(path) ?? Promise.resolve()).catch(() => {}).then(work)
  queue.set(path, current)
  try { return await current } finally { if (queue.get(path) === current) queue.delete(path) }
}

export async function parsedAttachments(space: UserSpace, treeId: string, files: Attached[], model: Model<any> | undefined, ctx: Context): Promise<(string | ParsedAttachment)[]> {
  if (!model) return files.map(file => file.path)
  await space.db.run('CREATE TABLE IF NOT EXISTS attachment_parses (path TEXT PRIMARY KEY, digest TEXT NOT NULL, how TEXT NOT NULL, pages INTEGER)')
  const env = await space.workspace.env(treeDir(treeId))
  return Promise.all(files.map(file => serial(space, file.path, async () => {
    const ext = file.path.split('.').at(-1)?.toLowerCase() ?? ''
    const kind = documentKind(file.path)
    const image = /^(png|jpe?g|gif|webp|bmp|tiff?)$/.test(ext)
    const needsImageText = image && (!model?.input.includes('image') || !/^(png|jpe?g|gif|webp)$/.test(ext))
    if (!kind && !/^(doc|ppt)$/.test(ext) && !needsImageText) return file.path
    const digest = createHash('sha256').update(file.bytes).digest('hex'), textPath = file.path + '.txt'
    try {
      const cached = await space.db.get<{ digest: string; how: 'text' | 'ocr'; pages: number | null }>('SELECT digest, how, pages FROM attachment_parses WHERE path = ?', file.path)
      if (cached?.digest === digest && unwrap(await env.exists(textPath, ctx))) return { path: file.path, textPath, how: cached.how, ...(cached.pages && { pages: cached.pages }) }
      let text: string | undefined, how: 'text' | 'ocr' = 'text', pages: number | undefined
      if (kind) {
        try {
          text = await extractDocument(kind, file.bytes)
          if (kind === 'pdf' && text.replace(/^##.*$/gm, '').replace(/\s/g, '').length < 32) text = undefined
        } catch { /* Unsupported or scanned documents can use OCR. */ }
      }
      if (text === undefined) {
        const service = await space.options.deepseekService?.()
        if (!service) return file.path
        const result = await recognizeFile(service, file.bytes, file.path.split('/').at(-1)!)
        await space.options.serviceUsage?.('ocr', result.pages)
        text = result.text; pages = result.pages; how = 'ocr'
      }
      if (!text.trim()) return file.path
      unwrap(await env.writeFile(textPath, text, ctx))
      await space.db.run('INSERT INTO attachment_parses VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET digest = excluded.digest, how = excluded.how, pages = excluded.pages', file.path, digest, how, pages ?? null)
      return { path: file.path, textPath, how, ...(pages && { pages }) }
    } catch { return file.path }
  })))
}

// Image plugin (R33): an OpenAI-compatible `/images/generations` endpoint. The image is saved in the tree's workspace
// under images/, and the view loads it from there; the transcript keeps only its path.
import { getOrThrow } from '@earendil-works/pi-durable/env'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import type { PluginValue } from '../catalog.ts'

const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']

/** `/v1` appended unless the address already ends in a version. */
const v1 = (url: string) => (/\/v\d+\/?$/.test(url) ? url.replace(/\/$/, '') : `${url.replace(/\/$/, '')}/v1`)

/** The format from the file signature; endpoints may ignore the requested output format. */
function sniff(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return { mimeType: 'image/png', ext: 'png' }
  if (b[0] === 0xff && b[1] === 0xd8) return { mimeType: 'image/jpeg', ext: 'jpg' }
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mimeType: 'image/webp', ext: 'webp' }
  return { mimeType: 'application/octet-stream', ext: 'bin' }
}

export async function generateImage(config: Record<string, PluginValue>, prompt: string, size: string | undefined, signal?: AbortSignal) {
  const body: Record<string, unknown> = { model: config.model, prompt, n: 1 }
  const s = size && SIZES.includes(size) ? size : String(config.size ?? 'auto')
  if (s !== 'auto') body.size = s
  if (config.quality && config.quality !== 'auto') body.quality = config.quality
  const res = await fetch(`${v1(String(config.baseUrl))}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal && { signal }),
  })
  type Body = { data?: { b64_json?: string; url?: string; revised_prompt?: string }[]; error?: { message?: string } }
  const json = (await res.json().catch(() => null)) as Body | null
  if (!res.ok) {
    const detail = json?.error?.message ?? res.statusText
    const reason: Record<number, string> = { 400: '请求被拒绝（可能是内容不符合使用政策）', 401: 'API Key 无效', 403: '端点没有开通生图', 404: '端点没有这个模型', 429: '请求太频繁或额度用尽' }
    // Settings problems do not go away on retry; the user has to fix them.
    const fix = [401, 403, 404].includes(res.status) ? '请告诉用户到“定制”页检查图片插件的设置，不要重试。' : ''
    throw new Error(`生成图片失败：${reason[res.status] ?? `HTTP ${res.status}`}。${detail}${fix}`)
  }
  const item = json?.data?.[0]
  let bytes: Uint8Array
  if (item?.b64_json) bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0))
  else if (item?.url) {
    const img = await fetch(item.url, { ...(signal && { signal }) })
    if (!img.ok) throw new Error(`下载生成的图片失败：HTTP ${img.status}`)
    bytes = new Uint8Array(await img.arrayBuffer())
  } else throw new Error('生成图片失败：端点没有返回图片')
  return { bytes, ...sniff(bytes), ...(item.revised_prompt && { revisedPrompt: item.revised_prompt }) }
}

export function imageExtension(config: () => Record<string, PluginValue>) {
  return defineExtension({
    name: 'image',
    tools: [
      defineTool({
        name: 'image_generate',
        description: '按描述生成一张图片，显示给用户，并保存到工作区的 images/ 下。描述要具体：主体、风格、构图、色调。',
        parameters: Type.Object({
          prompt: Type.String({ description: '图片描述' }),
          size: Type.Optional(Type.Union(SIZES.map((s) => Type.Literal(s)), { description: '尺寸，默认按用户设置' })),
        }),
        async execute({ prompt, size }, api, context) {
          const env = api.env
          if (!env) throw new Error('没有工作区，不能保存图片')
          const image = await generateImage(config(), prompt, size, context.abortSignal)
          const path = `images/${api.callId.replace(/[^\w-]/g, '').slice(-12) || Date.now()}.${image.ext}`
          getOrThrow(await env.writeFile(path, image.bytes, context))
          const abs = getOrThrow(await env.absolutePath(path, context))
          return {
            output: [{ type: 'text', text: `图片已生成并显示给用户，保存在 ${abs}。` }],
            details: {
              prompt,
              ...(image.revisedPrompt && { revisedPrompt: image.revisedPrompt }),
              images: [{ id: api.callId, path: abs, mediaType: image.mimeType }],
            },
          }
        },
      }),
    ],
  })
}

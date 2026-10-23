import { v1 } from './models'
import type { PluginConfig } from './plugins'

// Image plugin backend (docs/plans/roadmap-2.md "L1 图片"): an OpenAI-compatible
// `/images/generations` endpoint, set in the plugin's settings.

export interface GeneratedImage {
  bytes: Uint8Array
  mediaType: string
  revisedPrompt?: string
}

const sizes = ['auto', '1024x1024', '1536x1024', '1024x1536']

/** One image for `prompt`; `size` overrides the configured default. */
export async function generateImage(config: PluginConfig, prompt: string, size: string | undefined, signal?: AbortSignal): Promise<GeneratedImage> {
  const body: Record<string, unknown> = { model: config.model, prompt, n: 1 }
  const s = size && sizes.includes(size) ? size : String(config.size ?? 'auto')
  if (s !== 'auto') body.size = s
  if (config.quality && config.quality !== 'auto') body.quality = config.quality
  const res = await fetch(`${v1(String(config.baseUrl))}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const json = (await res.json().catch(() => null)) as { data?: { b64_json?: string; url?: string; revised_prompt?: string }[]; error?: { message?: string } } | null
  if (!res.ok) {
    const detail = json?.error?.message ?? res.statusText
    const reason: Record<number, string> = { 400: '请求被拒绝（可能是内容不符合使用政策）', 401: 'API Key 无效', 403: '端点没有开通生图', 404: '端点没有这个模型', 429: '请求太频繁或额度用尽' }
    // Settings problems do not go away on retry; the user has to fix them.
    const fix = [401, 403, 404].includes(res.status) ? '请告诉用户到“定制”页检查图片插件的设置，不要重试。' : ''
    throw new Error(`生成图片失败：${reason[res.status] ?? `HTTP ${res.status}`}。${detail}${fix}`)
  }
  const item = json?.data?.[0]
  if (item?.b64_json) {
    const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0))
    return { bytes, mediaType: sniff(bytes), revisedPrompt: item.revised_prompt }
  }
  if (item?.url) {
    const img = await fetch(item.url, { signal })
    if (!img.ok) throw new Error(`下载生成的图片失败：HTTP ${img.status}`)
    const bytes = new Uint8Array(await img.arrayBuffer())
    return { bytes, mediaType: sniff(bytes), revisedPrompt: item.revised_prompt }
  }
  throw new Error('生成图片失败：端点没有返回图片')
}

/** The format from the file signature; endpoints may ignore the requested output format. */
function sniff(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return 'application/octet-stream'
}

export const imageExtension = (mediaType: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mediaType] ?? 'bin'

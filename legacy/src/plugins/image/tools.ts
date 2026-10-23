import type { PluginTool } from '../types'

export interface ImageInput {
  prompt: string
  size?: string
}

export interface GeneratedImage {
  id: string
  url: string
  mediaType: string
  fileId?: string
  fileName?: string
}

export interface ImageResult {
  prompt: string
  revisedPrompt?: string
  images: GeneratedImage[]
}

const dims: Record<string, [number, number]> = { '1536x1024': [1536, 1024], '1024x1536': [1024, 1536] }

/** A gradient with the prompt on it, standing in for a generated picture. */
function placeholder(prompt: string, size?: string): string {
  const [w, h] = dims[size ?? ''] ?? [1024, 1024]
  const hue = [...prompt].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  const text = prompt.replace(/[<&>"]/g, '').slice(0, 24)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 65% 38%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.72}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.12}" fill="#fff" opacity=".55"/><path d="M0 ${h * 0.78} Q ${w * 0.3} ${h * 0.55} ${w * 0.55} ${h * 0.72} T ${w} ${h * 0.62} V ${h} H 0 Z" fill="#000" opacity=".22"/><text x="50%" y="${h * 0.5}" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(w / 22)}" fill="#fff">${text}</text></svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

// Mock half of the image plugin: no endpoint, an SVG with the prompt instead.
export const imageTools: PluginTool[] = [
  {
    name: 'image_generate',
    plugin: 'image',
    description: '按描述生成图片',
    resourceUri: 'ui://image/view',
    sideEffect: false,
    execute: ({ prompt, size }: ImageInput) => {
      const id = Math.random().toString(36).slice(2, 10)
      const result: ImageResult = { prompt, images: [{ id, url: placeholder(prompt, size), mediaType: 'image/svg+xml' }] }
      return { content: `已生成 1 张图片（Mock）`, structuredContent: result }
    },
  },
]

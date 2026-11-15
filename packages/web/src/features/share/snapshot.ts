// Builds what a public link shows (roadmap-7 B1, Q3): questions, answers, generative UI and generated images. Thinking,
// tool calls, workspace files, MCP Apps and other plugin views stay out. The server stores the result as is.
import type { SharedBlock, SharedTurn, ShareSnapshot } from '@gense/protocol'
import { SHARE_LIMITS } from '@gense/protocol'
import type { GeneratedImage, ImageResult } from '../../plugins/contracts'
import type { ToolIndex } from '../../lib/tools'
import type { Turn } from '../../lib/types'

/** Views that read only their own input and result, so they draw the same on the public page. */
export const sharedViews = new Set(['ui://ui/render'])
const imageView = 'ui://image/view'

export type ReadImage = (path: string) => Promise<{ mimeType: string; base64: string }>

export async function buildSnapshot(title: string, turns: Turn[], tools: ToolIndex, readImage: ReadImage): Promise<ShareSnapshot> {
  const out: SharedTurn[] = []
  for (const turn of turns) {
    // A turn still waiting or one the user stopped before any answer has nothing to show.
    if (turn.status === 'queued' || (turn.brief !== undefined && !turn.assistantMessage)) continue
    const answer: SharedBlock[] = []
    for (const b of turn.blocks) {
      if (b.kind === 'text') {
        if (b.text.trim()) answer.push({ kind: 'text', text: b.text })
        continue
      }
      if (b.kind !== 'tool' || b.call.status !== 'succeeded') continue
      const uri = tools.get(b.call.name)?.resourceUri
      if (uri && sharedViews.has(uri)) {
        const r = b.call.result
        answer.push({ kind: 'view', uri, input: b.call.input, ...(r && { result: { content: r.content, ...(r.structuredContent !== undefined && { structuredContent: r.structuredContent }) } }) })
      } else if (uri === imageView) {
        const result = b.call.result?.structuredContent as ImageResult | undefined
        for (const img of result?.images ?? []) {
          const shown = await image(img, result?.prompt ?? '', readImage)
          if (shown) answer.push(shown)
        }
      }
    }
    if (!turn.userMessage.trim() && answer.length === 0) continue
    out.push({
      question: turn.userMessage,
      answer,
      ...(turn.sources.length > 0 && { sources: turn.sources.map((s) => ({ url: s.url, title: s.title })) }),
      createdAt: turn.createdAt,
    })
  }
  const snapshot = { title: (title || '对话').slice(0, SHARE_LIMITS.title), turns: out.slice(-SHARE_LIMITS.turns) }
  const size = new Blob([JSON.stringify(snapshot)]).size
  if (size > SHARE_LIMITS.bytes) throw new Error(`对话内容（含图片）有 ${(size / 1024 / 1024).toFixed(1)} MB，超过公开链接上限 ${SHARE_LIMITS.bytes / 1024 / 1024} MB`)
  return snapshot
}

/** An image inlined, or null when it is no longer in the workspace. */
async function image(img: GeneratedImage, prompt: string, readImage: ReadImage): Promise<SharedBlock | null> {
  const file = await readImage(img.path).catch(() => null)
  if (!file) return null
  return { kind: 'image', src: `data:${file.mimeType || img.mediaType};base64,${file.base64}`, alt: prompt }
}

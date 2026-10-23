import { IconArrowDown, IconCheck } from '../../components/Icons'
import { href } from '../../router'
import type { ViewProps } from '../types'
import type { ImageInput, ImageResult } from './tools'

const ratio: Record<string, string> = { '1536x1024': '3 / 2', '1024x1536': '2 / 3' }
const extension = (mediaType: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[mediaType] ?? 'png'

/** Generated images; a placeholder of the requested shape while the call runs. */
export function ImageView({ toolInput, toolResult }: ViewProps<ImageInput, ImageResult>) {
  const result = toolResult?.structuredContent
  if (!result) {
    return (
      <figure className="image-gen">
        <div className="image-pending" style={{ aspectRatio: ratio[toolInput.size ?? ''] ?? '1 / 1' }}>
          <span className="spinner" /> 正在生成图片…
        </div>
        <figcaption className="muted small ellipsis">{toolInput.prompt}</figcaption>
      </figure>
    )
  }
  return (
    <>
      {result.images.map((img) => (
        <figure key={img.id} className="image-gen">
          <a href={img.url} target="_blank" rel="noreferrer" title="查看原图">
            <img src={img.url} alt={result.prompt} loading="lazy" />
          </a>
          <figcaption className="image-meta">
            <span className="muted small ellipsis" title={result.revisedPrompt ?? result.prompt}>
              {result.prompt}
            </span>
            {img.fileId && (
              <a className="pill-btn small" href={href({ name: 'files', tab: 'artifact', id: img.fileId })}>
                <IconCheck width={14} height={14} /> 已存到 Drive
              </a>
            )}
            <a className="pill-btn small" href={img.url} download={img.fileName ?? `image-${img.id}.${extension(img.mediaType)}`}>
              <IconArrowDown width={14} height={14} /> 下载
            </a>
          </figcaption>
        </figure>
      ))}
    </>
  )
}

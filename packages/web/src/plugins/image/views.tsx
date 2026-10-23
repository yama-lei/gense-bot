import { useEffect, useState } from 'react'
import { IconArrowDown } from '../../components/Icons'
import type { ViewHost, ViewProps } from '../types'
import type { GeneratedImage, ImageInput, ImageResult } from '../contracts'

const ratio: Record<string, string> = { '1536x1024': '3 / 2', '1024x1536': '2 / 3' }

/** Generated images, loaded from the chat's workspace; a placeholder of the requested shape while the call runs. */
export function ImageView({ toolInput, toolResult, host }: ViewProps<ImageInput, ImageResult>) {
  const result = toolResult?.structuredContent
  if (!result?.images) {
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
        <Image key={img.id} img={img} prompt={result.prompt} title={result.revisedPrompt ?? result.prompt} host={host} ratio={ratio[toolInput.size ?? ''] ?? '1 / 1'} />
      ))}
    </>
  )
}

function Image({ img, prompt, title, host, ratio }: { img: GeneratedImage; prompt: string; title: string; host: ViewHost; ratio: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | undefined
    let live = true
    host.readFile(img.path).then(
      (blob) => {
        if (!live) return
        objectUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: img.mediaType }))
        setUrl(objectUrl)
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img.path])
  const name = img.path.slice(img.path.lastIndexOf('/') + 1)
  return (
    <figure className="image-gen">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title="查看原图">
          <img src={url} alt={prompt} />
        </a>
      ) : (
        <div className="image-pending" style={{ aspectRatio: ratio, animation: error ? 'none' : undefined }}>
          {error ? `图片读取失败：${error}` : '正在加载图片…'}
        </div>
      )}
      <figcaption className="image-meta">
        <span className="muted small ellipsis" title={title}>
          {prompt}
        </span>
        {url && (
          <a className="pill-btn small" href={url} download={name}>
            <IconArrowDown width={14} height={14} /> 下载
          </a>
        )}
      </figcaption>
    </figure>
  )
}

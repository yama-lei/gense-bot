import { Download, ImageOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { baseName, errorText } from '../../lib/format'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/feedback'
import type { GeneratedImage, ImageInput, ImageResult } from '../contracts'
import type { ViewHost, ViewProps } from '../types'

const ratios: Record<string, string> = { '1536x1024': '3 / 2', '1024x1536': '2 / 3' }
const frame = 'grid w-full place-items-center gap-2 rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground'

/** Generated images, loaded from the chat's workspace; a placeholder of the requested shape while the call runs. */
export function ImageView({ toolInput, toolResult, host }: ViewProps<ImageInput, ImageResult>) {
  const result = toolResult?.structuredContent
  const ratio = ratios[toolInput?.size ?? ''] ?? '1 / 1'
  if (!result?.images) {
    return (
      <figure className="max-w-md">
        <div className={`${frame} animate-pulse`} style={{ aspectRatio: ratio }}>
          <span className="inline-flex items-center gap-2">
            <Spinner /> 正在生成图片…
          </span>
        </div>
        <figcaption className="mt-1.5 truncate text-xs text-muted-foreground">{toolInput?.prompt}</figcaption>
      </figure>
    )
  }
  return (
    <div className="flex flex-wrap gap-3">
      {result.images.map((img) => (
        <Image key={img.id} img={img} prompt={result.prompt} title={result.revisedPrompt ?? result.prompt} host={host} ratio={ratio} />
      ))}
    </div>
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
      (e: unknown) => live && setError(errorText(e)),
    )
    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img.path])
  return (
    <figure className="w-full max-w-md">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title="查看原图" className="block overflow-hidden rounded-xl border">
          <img src={url} alt={prompt} className="block w-full" />
        </a>
      ) : (
        <div className={`${frame} ${error ? '' : 'animate-pulse'}`} style={{ aspectRatio: ratio }}>
          {error ? (
            <span className="inline-flex items-center gap-2">
              <ImageOff className="size-4" /> 图片读取失败：{error}
            </span>
          ) : (
            '正在加载图片…'
          )}
        </div>
      )}
      <figcaption className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={title}>
          {prompt}
        </span>
        {url && (
          <Button size="sm" variant="ghost" asChild className="h-7 px-2 text-xs">
            <a href={url} download={baseName(img.path)}>
              <Download className="size-3.5" /> 下载
            </a>
          </Button>
        )}
      </figcaption>
    </figure>
  )
}

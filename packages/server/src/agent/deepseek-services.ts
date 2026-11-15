// Standalone DeepSeek services. Credentials are supplied by the host's encrypted shared-provider store.
export interface DeepSeekService { provider: string; key: string; baseUrl: string }

export async function deepseekServiceRequest(service: DeepSeekService, path: string, body: FormData | Record<string, unknown>, signal?: AbortSignal) {
  const form = body instanceof FormData
  return fetch(`${service.baseUrl.replace(/\/+$/, '')}/v1/tools/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${service.key}`, ...(!form && { 'content-type': 'application/json' }) },
    body: form ? body : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  })
}

/** Remove OCR location wrappers but preserve the text they surround. */
export function cleanOcr(text: string) {
  return text.replace(/<(?:｜|\|)box(?:｜|\|)>[\s\S]*?<(?:｜|\|)\/box(?:｜|\|)>/g, '').replace(/<(?:｜|\|)\/?ref(?:｜|\|)>/g, '').trim()
}

export async function recognizeFile(service: DeepSeekService, bytes: Uint8Array, name: string): Promise<{ text: string; pages: number }> {
  const body = new FormData()
  body.append('purpose', 'text_recognition')
  body.append('file', new Blob([new Uint8Array(bytes)]), name)
  const response = await deepseekServiceRequest(service, 'ocr', body)
  const result = await response.json() as { error?: unknown; page_count?: number; pages?: { text?: string; finish_reason?: string }[] }
  if (!response.ok || result.error || !Number.isInteger(result.page_count) || !result.page_count || result.page_count > 1000 || !Array.isArray(result.pages) || result.pages.length !== result.page_count || result.pages.some(p => typeof p.text !== 'string')) throw new Error('OCR 未能完成')
  return { text: result.pages.map(p => cleanOcr(p.text!)).join('\n\n'), pages: result.page_count }
}

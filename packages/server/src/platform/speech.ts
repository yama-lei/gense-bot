// C7: authenticated host proxy for DeepSeek speech. Shared credentials never leave the host.
import { ASR_MAX_SECONDS, TTS_MAX_CHARS, type SpeechText, type TtsRequest } from '@gense/protocol'
import { deepseekServiceRequest } from '../agent/deepseek-services.ts'
import { json, readJson, sameOrigin } from './http.ts'
import type { AppStore } from './app.ts'

export const ASR_MAX_BYTES = 8 * 1024 * 1024
export const ttsCharacters = (text: string) => [...text].reduce((n, character) => n + (/\p{Script=Han}/u.test(character) ? 2 : 1), 0)
class SpeechError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
const invalidAudio = () => new SpeechError(400, '录音须为 16-bit PCM WAV 或 Ogg Opus')

/** Read the container duration before making a billed request; the provider still validates the codec itself. */
export function audioDuration(bytes: Uint8Array, mime: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (start: number, length: number) => new TextDecoder().decode(bytes.subarray(start, start + length))
  if (mime === 'audio/wav') {
    if (bytes.length < 12 || tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE') throw invalidAudio()
    let byteRate = 0, data = 0
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = view.getUint32(offset + 4, true), start = offset + 8
      if (start + size > bytes.length) throw invalidAudio()
      if (tag(offset, 4) === 'fmt ') {
        if (size < 16 || view.getUint16(start, true) !== 1 || ![1, 2].includes(view.getUint16(start + 2, true)) || view.getUint16(start + 14, true) !== 16 || ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(view.getUint32(start + 4, true))) throw invalidAudio()
        byteRate = view.getUint32(start + 8, true)
        if (byteRate !== view.getUint32(start + 4, true) * view.getUint16(start + 2, true) * 2) throw invalidAudio()
      } else if (tag(offset, 4) === 'data') data += size
      offset = start + size + (size % 2)
    }
    if (!byteRate || !data) throw invalidAudio()
    return data / byteRate
  }
  if (mime !== 'audio/ogg' || tag(0, 4) !== 'OggS') throw invalidAudio()
  let offset = 0, last = 0n, preSkip = 0, opus = false
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || tag(offset, 4) !== 'OggS' || bytes[offset + 4] !== 0) throw invalidAudio()
    const segments = bytes[offset + 26]!, start = offset + 27 + segments
    if (start > bytes.length) throw invalidAudio()
    const size = bytes.subarray(offset + 27, start).reduce((n, value) => n + value, 0)
    if (start + size > bytes.length) throw invalidAudio()
    if (!opus) {
      if (size < 19 || tag(start, 8) !== 'OpusHead' || ![1, 2].includes(bytes[start + 9]!)) throw invalidAudio()
      preSkip = view.getUint16(start + 10, true); opus = true
    }
    const granule = view.getBigInt64(offset + 6, true)
    if (granule >= 0n) last = granule
    offset = start + size
  }
  const seconds = (Number(last) - preSkip) / 48000
  if (!opus || !Number.isFinite(seconds) || seconds <= 0) throw invalidAudio()
  return seconds
}

export class SpeechApi {
  readonly #app: AppStore
  readonly #limits = new Map<string, { start: number; count: number }>()
  constructor(app: AppStore) { this.#app = app }
  async handle(userId: string, request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/api/speech' && request.method === 'GET') {
      const available = !!await this.#app.deepseekService()
      return json(200, { asr: available, tts: available })
    }
    if (request.method !== 'POST' || !['/api/speech/asr', '/api/speech/tts'].includes(path)) return json(404, { error: 'not found' })
    if (!sameOrigin(request)) return json(403, { error: '来源不匹配' })
    const now = Date.now(), prior = this.#limits.get(userId)
    const limit = prior && now - prior.start < 60_000 ? prior : { start: now, count: 0 }
    if (++limit.count > 20) return json(429, { error: '语音请求太频繁，请稍后再试' })
    this.#limits.set(userId, limit)
    // Remove expired principals so a long-lived host does not retain one entry for every past user.
    for (const [id, value] of this.#limits) if (now - value.start >= 60_000) this.#limits.delete(id)
    const service = await this.#app.deepseekService()
    if (!service) return json(503, { error: '服务器没有配置 DeepSeek 语音服务' })
    try {
      if (path.endsWith('/asr')) {
        const mime = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
        if (!['audio/wav', 'audio/ogg'].includes(mime)) throw new SpeechError(415, '录音格式不支持')
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.byteLength > ASR_MAX_BYTES) throw new SpeechError(413, '录音超过 8 MiB')
        const duration = audioDuration(bytes, mime)
        if (duration > ASR_MAX_SECONDS) throw new SpeechError(413, `录音不能超过 ${ASR_MAX_SECONDS} 秒`)
        const form = new FormData()
        form.append('file', new Blob([bytes], { type: mime }), mime === 'audio/wav' ? 'speech.wav' : 'speech.ogg')
        const upstream = await deepseekServiceRequest(service, 'asr', form, request.signal)
        if (!upstream.ok) throw new SpeechError(502, '听写服务暂时不可用')
        const result = await upstream.json() as { text?: unknown; duration_ms?: unknown }
        if (typeof result.text !== 'string' || typeof result.duration_ms !== 'number' || !Number.isFinite(result.duration_ms) || result.duration_ms < 0 || result.duration_ms > ASR_MAX_SECONDS * 1000) throw new SpeechError(502, '听写服务返回无效结果')
        await this.#app.recordService(userId, 'asr', Math.ceil(result.duration_ms / 1000))
        const body: SpeechText = { text: result.text, durationMs: result.duration_ms }
        return json(200, body)
      }
      const body = await readJson(request) as unknown as TtsRequest
      if (typeof body.text !== 'string' || !body.text.trim() || (body.voice !== undefined && !['stella', 'tide'].includes(body.voice))) throw new SpeechError(400, '朗读参数无效')
      if ([...body.text].length > TTS_MAX_CHARS || ttsCharacters(body.text) > 10000) throw new SpeechError(413, `朗读文本不能超过 ${TTS_MAX_CHARS} 字符`)
      const upstream = await deepseekServiceRequest(service, 'tts', { text: body.text, voice_id: body.voice ?? 'stella', format: 'wav', filter_markdown: true }, request.signal, 30 * 60_000)
      if (!upstream.ok || !upstream.body || !upstream.headers.get('content-type')?.includes('audio/')) throw new SpeechError(502, '朗读服务暂时不可用')
      await this.#app.recordService(userId, 'tts', ttsCharacters(body.text))
      return new Response(upstream.body, { headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' } })
    } catch (error) {
      return json(error instanceof SpeechError ? error.status : error instanceof SyntaxError ? 400 : 502, { error: error instanceof SpeechError ? error.message : '语音服务暂时不可用' })
    }
  }
}

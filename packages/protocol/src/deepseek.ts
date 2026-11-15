// DeepSeek App API (roadmap-7 C; research in docs/research/deepseek-app-api.md). DeepSeek runs web search and link
// reading itself; the server records what it did as a NativeTrace so the web client can show the steps, the sources
// and a refusal the same way for every DeepSeek answer.

/** The DeepSeek model that has the App extensions (native web tools, safety check, title). Other DeepSeek models are plain. */
export const DEEPSEEK_APP_MODELS = ['deepseek-flash'] as const
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

// ── C2 / C3 native steps ──────────────────────────────────────────────────────

/** A page DeepSeek found or read; also what a citation points at. */
export interface NativeSource {
  url: string
  title: string
  site?: string
  /** The site's icon URL, as DeepSeek gives it. */
  icon?: string
  snippet?: string
  /** RFC 3339 when known. */
  publishedAt?: string
}

/**
 * One server-side tool step. `kind` is DeepSeek's (`deep_search` while thinking); `action` what this step did:
 * `search` (queries → results), `open_page` / `find_in_page` (a page during deep search), `read_link` (a link from
 * the user's message), `image_search`.
 */
export interface NativeStep {
  id: string
  kind: 'search' | 'deep_search' | 'read_link' | 'image_search' | 'deep_image_search'
  action: 'search' | 'open_page' | 'find_in_page' | 'read_link' | 'image_search'
  status: 'running' | 'done' | 'failed'
  queries?: string[]
  url?: string
  pattern?: string
  /** Search results, or the page read. */
  results?: NativeSource[]
  /** DeepSeek's error code when `failed` (`unavailable`, `url_not_accessible`, …). */
  error?: string
}

/**
 * What DeepSeek did for one assistant message. Persisted as an entry of kind NATIVE_KIND right after that
 * `pi.assistant` entry (the model never sees it), and streamed as `native` messages while the answer runs.
 */
export interface NativeTrace {
  steps: NativeStep[]
  /** The answer's citations, once each by URL, in the order they first appear. */
  citations: NativeSource[]
  /**
   * The safety check refused (C4). The assistant entry then has no text or thinking; the client shows its own
   * explanation. Not an error: retrying the same question gives the same result.
   */
  refusal?: boolean
}

export const NATIVE_KIND = 'app.native'

// ── C6 attachments parsed on the server ───────────────────────────────────────

/**
 * A file the model cannot read as is (scanned PDF, Office, an image for a model without vision) is turned into text
 * before the turn: the text is saved next to it as `<path>.txt` and the attachments note lists it as
 * `<path> -> <path>.txt (<how>, <pages> pages)`. The web client shows a "已解析" chip.
 */
export interface ParsedAttachment {
  path: string
  textPath: string
  how: 'text' | 'ocr'
  pages?: number
}

// ── C7 speech ─────────────────────────────────────────────────────────────────

/**
 * GET /api/speech (signed in): what the server can do; the client falls back to the browser's speech otherwise.
 * POST /api/speech/asr: body is the recording (`audio/wav` 16-bit PCM or `audio/ogg` Opus, ≤ 120 s, ≤ 8 MiB) → SpeechText.
 * POST /api/speech/tts: body is TtsRequest → `audio/wav`, streamed as it is synthesized.
 */
export interface SpeechCapabilities {
  asr: boolean
  tts: boolean
}
export interface SpeechText {
  text: string
  durationMs: number
}
export interface TtsRequest {
  /** Markdown is fine; it is read as plain text. At most TTS_MAX_CHARS characters. */
  text: string
  voice?: 'stella' | 'tide'
}
export const TTS_MAX_CHARS = 4000
export const ASR_MAX_SECONDS = 120

// ── C8 usage of services that are not tokens ──────────────────────────────────

/**
 * Services billed outside a model call. Web searches and page reads, native or through the web plugin, are not here:
 * they count once, in `UsageSummary.searches` / `fetches` of the provider that ran them.
 */
export type ServiceKind = 'ocr' | 'asr' | 'tts'

/** Billable units: pages for ocr, seconds for asr, characters for tts. */
export interface ServiceUsageSummary {
  userId: string
  email: string
  day: string
  service: ServiceKind
  calls: number
  units: number
}

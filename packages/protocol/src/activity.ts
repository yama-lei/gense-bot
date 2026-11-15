// What used to live only in the browser (roadmap-7 D): answer feedback, follow-up suggestions, inbox read state, the
// library, exports and the user's own usage. Kept per user on the server, so every device sees the same.

// ── D1 feedback ────────────────────────────────────────────────────────────────

export const FEEDBACK_REASONS = ['inaccurate', 'ignored', 'too-long', 'too-short', 'unsafe', 'other'] as const
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]

/** 👍 / 👎 on the answer of one turn; `turnId` is the id of the turn's opening entry, as the web client numbers turns. */
export interface Feedback {
  turnId: string
  value: 'up' | 'down'
  /** Only with `down`. */
  reasons?: FeedbackReason[]
  /** Only with `down`; at most 500 characters. */
  comment?: string
  /** `provider:model` that wrote the answer, recorded by the server for the admin summary. */
  model?: string
  updatedAt: number
}

/** GET /api/admin/feedback?from=YYYY-MM-DD&to=YYYY-MM-DD: one row per model and UTC day. */
export interface FeedbackSummary {
  day: string
  model: string
  up: number
  down: number
  reasons: Partial<Record<FeedbackReason, number>>
}

// ── D2 follow-up suggestions ──────────────────────────────────────────────────

/** Follow-ups for the answer of `turnId`, generated after it finished (2–3, each under 40 characters). */
export interface Suggestions {
  turnId: string
  items: string[]
}

// ── D4 library ────────────────────────────────────────────────────────────────

export type FileKind = 'doc' | 'image' | 'data' | 'code' | 'other'

const kindPatterns: [FileKind, RegExp][] = [
  ['doc', /\.(md|txt|pdf|docx?|rtf|html?|pptx?|odt|epub)$/i],
  ['image', /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic)$/i],
  ['data', /\.(csv|tsv|xlsx?|json|jsonl|ya?ml|xml|sqlite|parquet)$/i],
  ['code', /\.(tsx?|jsx?|mjs|py|go|rs|java|c|cc|cpp|h|hpp|sh|sql|css|scss|rb|php|swift|kt|toml|ipynb)$/i],
]

/** The library's file kinds; the server filters by the same rule. */
export const fileKind = (path: string): FileKind => kindPatterns.find(([, re]) => re.test(path))?.[0] ?? 'other'

/** A file in a conversation's workspace or a project; skills and other read-only mounts are not listed. */
export interface LibraryFile {
  path: string
  size: number
  mtime: number
  kind: FileKind
  /** Exactly one of the two is set. */
  treeId?: string
  projectId?: string
}

export interface LibraryPage {
  items: LibraryFile[]
  /** Pass back as `cursor` for the next page; absent on the last one. */
  next?: string
}

// ── D5 export ─────────────────────────────────────────────────────────────────

/**
 * A zip of everything the user has: a Markdown file per conversation (main branch), its workspace files, and
 * memories, projects (with their files) and preferences as JSON. Downloaded with GET /api/exports/:id (signed-in).
 */
export interface ExportInfo {
  id: string
  status: 'running' | 'ready' | 'failed'
  /** Bytes, once ready. */
  size?: number
  error?: string
  createdAt: number
  finishedAt?: number
}

// ── D6 usage ──────────────────────────────────────────────────────────────────
// GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD returns UsageSummary[] (accounts.ts) for the signed-in user only.

/** Inbox items the user has read, by the web client's item id; the newest 500 are kept. */
export const INBOX_READ_KEPT = 500

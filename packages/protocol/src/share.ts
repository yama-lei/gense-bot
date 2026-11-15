// Public share links and temporary chats (roadmap-7 B).
//
// A share is a snapshot the web client builds from what it shows (Q3: questions, answers, generative UI and images;
// no thinking, tool arguments, workspace files or MCP Apps) and the server stores as is. Anyone with the link reads it
// at `GET /api/share/:token` without signing in; the web page `/s/:token` renders it.

/** One piece of a shared answer, in the order it was written. */
export type SharedBlock =
  | { kind: 'text'; text: string }
  /** A built-in view (`ui://ui/render` and the like) drawn from its recorded input and result; it cannot call tools. */
  | { kind: 'view'; uri: string; input: unknown; result?: { content: string; structuredContent?: unknown } }
  /** An image the answer showed, inlined as a `data:image/...;base64,` URL. */
  | { kind: 'image'; src: string; alt: string }

export interface SharedTurn {
  /** The user's message as they typed it, without notes; empty for an Event. */
  question: string
  answer: SharedBlock[]
  sources?: { url: string; title: string }[]
  createdAt: number
}

export interface ShareSnapshot {
  title: string
  turns: SharedTurn[]
}

/** What `GET /api/share/:token` returns. */
export interface SharedPage extends ShareSnapshot {
  /** When the snapshot was taken (created or last updated). */
  updatedAt: number
}

/** A link the user made; listed on Settings → Data and in the share dialog. */
export interface ShareInfo {
  token: string
  treeId: string
  title: string
  turns: number
  createdAt: number
  updatedAt: number
}

export const SHARE_LIMITS = {
  /** Bytes of one snapshot as JSON, images included. */
  bytes: 8 * 1024 * 1024,
  turns: 500,
  title: 200,
} as const

export const sharePath = (token: string) => `/s/${token}`

/** How long a temporary chat lives after it was created, unless the user leaves it first (B6). */
export const TEMPORARY_TTL_MS = 24 * 60 * 60 * 1000

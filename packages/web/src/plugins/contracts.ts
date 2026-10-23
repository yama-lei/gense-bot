// Inputs and results of the tools that have views; the tools themselves run on the host.

export interface ArtifactInput {
  title: string
  type: 'markdown' | 'code'
  language?: string
  content: string
}

export interface DraftInput {
  to: string
  subject: string
  body: string
}

export interface ImageInput {
  prompt: string
  size?: string
}

/** An image the tool saved in the chat's workspace; `path` is absolute (`/data/...`). */
export interface GeneratedImage {
  id: string
  path: string
  mediaType: string
}

export interface ImageResult {
  prompt: string
  revisedPrompt?: string
  images: GeneratedImage[]
}

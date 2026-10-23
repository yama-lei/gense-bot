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

export interface GeneratedImage {
  id: string
  url: string
  mediaType: string
  fileId?: string
  fileName?: string
}

export interface ImageResult {
  prompt: string
  revisedPrompt?: string
  images: GeneratedImage[]
}

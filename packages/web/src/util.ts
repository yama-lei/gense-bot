/** Any uploaded file, and any file converted to text (roadmap-2 R7). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export function uid() {
  return Math.random().toString(36).slice(2, 10)
}

/** Locate a saved excerpt in the file's current text; falls back to ignoring whitespace. Null means the source changed. */
export function findQuote(text: string, quote: string): [number, number] | null {
  const i = text.indexOf(quote)
  if (i >= 0) return [i, i + quote.length]
  const map: number[] = []
  let flat = ''
  for (let k = 0; k < text.length; k++) {
    if (!/\s/.test(text[k])) {
      map.push(k)
      flat += text[k]
    }
  }
  const q = quote.replace(/\s+/g, '')
  const j = q ? flat.indexOf(q) : -1
  return j < 0 ? null : [map[j], map[j + q.length - 1] + 1]
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

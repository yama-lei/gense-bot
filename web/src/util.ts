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

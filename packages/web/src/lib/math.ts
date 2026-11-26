// Models write maths in more ways than remark-math reads. `normalizeMath` rewrites model Markdown so every common
// form renders, without touching code: \( \) and \[ \] become dollars, a $$…$$ written inside a line becomes a display
// block in the same list item or quote, bare \begin{equation}-style environments get $$ around them, a single $ that is
// a price stays a dollar sign, and | inside maths in a table row stops splitting the cell.

const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/
const ENVS = 'equation|align|alignat|gather|multline|eqnarray|flalign'

export function normalizeMath(text: string) {
  if (!/[$\\]/.test(text)) return text
  return text
    .split(CODE)
    .map((part, i) => (i % 2 ? part : prose(part)))
    .join('')
}

function prose(text: string) {
  text = text
    // \[ … \] (not the \\[4pt] row spacing inside a matrix) keeps its line breaks, so its indentation survives.
    .replace(/(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g, (_, m: string) => `$$${m}$$`)
    // \( … \) may wrap, but not across a blank line.
    .replace(/(?<!\\)\\\(((?:(?!\n[ \t>]*\n)[\s\S])+?)(?<!\\)\\\)/g, (_, m: string) => `$${m.trim()}$`)
    .replace(/\\(begin|end)\{multline(\*?)\}/g, '\\$1{gather$2}')
  return prices(blocks(text.split('\n')).join('\n'))
}

/** The prefix a line's continuation needs to stay in its quote or list item, and the first line's own prefix. */
function container(line: string) {
  const m = /^([ \t]*(?:>[ \t]?)*)((?:[-*+]|\d{1,9}[.)])[ \t]+)?/.exec(line)!
  return { first: m[0], rest: m[1] + ' '.repeat(m[2]?.length ?? 0), body: line.slice(m[0].length) }
}

/** $$ blocks and display environments, line by line. */
function blocks(lines: string[]) {
  const out: string[] = []
  let open = false // inside a $$ … $$ block
  let env: string | undefined // inside a bare \begin{…} we opened a $$ for
  let table = false
  for (const line of lines) {
    const { first, rest, body } = container(line)
    const trimmed = body.trim()
    if (env) {
      out.push(line)
      if (trimmed.includes(`\\end{${env}`)) {
        out.push(rest + '$$')
        env = undefined
      }
      continue
    }
    if (open) {
      // `$$ see (1)`: the block closes and the line goes on as text.
      if (trimmed.startsWith('$$') && trimmed.length > 2 && !trimmed.endsWith('$$')) {
        out.push(rest + '$$', rest + trimmed.slice(2).trim())
        open = false
      } else if (trimmed.endsWith('$$')) {
        const before = trimmed.slice(0, -2)
        if (before.trim()) out.push(rest + before)
        out.push(rest + '$$')
        open = false
      } else out.push(line)
      continue
    }
    if (trimmed === '$$') {
      open = true
      out.push(line)
      continue
    }
    // A line opening a $$ block with maths after it: `$$ \begin{aligned}`.
    if (trimmed.startsWith('$$') && !trimmed.slice(2).includes('$$')) {
      out.push(first + '$$', rest + trimmed.slice(2).trim())
      open = true
      continue
    }
    const begin = new RegExp(`^\\\\begin\\{(${ENVS})(\\*?)\\}`).exec(trimmed)
    if (begin) {
      out.push(first + '$$', rest + trimmed)
      if (trimmed.includes(`\\end{${begin[1]}`)) out.push(rest + '$$')
      else env = begin[1]
      continue
    }
    table = /^\s*\|/.test(line) || (table && line.includes('|'))
    if (table) {
      out.push(pipes(line))
      continue
    }
    if (!body.includes('$$')) {
      out.push(line)
      continue
    }
    // $$…$$ inside a line: break it out into a display block in the same container.
    let prefix = first
    let rest_ = body
    for (let m = /\$\$([^$]+?)\$\$/.exec(rest_); m; m = /\$\$([^$]+?)\$\$/.exec(rest_)) {
      const before = rest_.slice(0, m.index).trimEnd()
      if (before) {
        out.push(prefix + before)
        prefix = rest
      }
      out.push(prefix + '$$', rest + m[1].trim(), rest + '$$')
      prefix = rest
      rest_ = rest_.slice(m.index + m[0].length).trimStart()
    }
    if (rest_) out.push(prefix + rest_)
  }
  if (env) out.push('$$')
  return out
}

/** Escapes | inside $…$ in a table row; KaTeX reads \| as ‖, so a bare | becomes \vert. */
function pipes(line: string) {
  return line.replace(/(?<![\\$])\$(?!\$)((?:\\.|[^$\\])+?)\$/g, (whole, m: string) =>
    m.includes('|') ? '$' + m.replace(/\\\|/g, '\\Vert ').replace(/\|/g, '\\vert ') + '$' : whole,
  )
}

const TEX = /[\\^_{}=]/

/**
 * Escapes a single $ that does not start maths. Maths starts with no space after its $, ends with no space before its
 * $ and no digit after it (Pandoc's rule) — unless what is between is plainly TeX, as in `$ \alpha $`.
 */
function prices(text: string) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      out += text.slice(i, i + 2)
      i += 2
      continue
    }
    if (c !== '$') {
      out += c
      i++
      continue
    }
    if (text[i + 1] === '$') {
      // $$ … $$: leave it whole.
      const end = text.indexOf('$$', i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop)
      i = stop
      continue
    }
    const close = closing(text, i)
    if (close < 0) {
      out += '\\$'
      i++
    } else {
      out += text.slice(i, close + 1)
      i = close + 1
    }
  }
  return out
}

function closing(text: string, open: number) {
  const paragraphEnd = text.slice(open).search(/\n[ \t>]*\n/)
  const limit = paragraphEnd < 0 ? text.length : open + paragraphEnd
  for (let j = open + 1; j < limit; j++) {
    if (text[j] === '\\') {
      j++
      continue
    }
    if (text[j] !== '$') continue
    if (text[j + 1] === '$') return -1
    const inner = text.slice(open + 1, j)
    if (!inner.trim()) return -1
    const strict = !/^\s/.test(inner) && !/\s$/.test(inner) && !/\d/.test(text[j + 1] ?? '')
    if (strict || TEX.test(inner)) return j
    return -1
  }
  return -1
}

/** Commands models take from LaTeX packages KaTeX lacks (physics, siunitx, bbm, amsmath labels). */
export const katexMacros: Record<string, string> = {
  '\\abs': '\\left\\lvert #1\\right\\rvert',
  '\\norm': '\\left\\lVert #1\\right\\rVert',
  '\\dv': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}',
  '\\pdv': '\\frac{\\partial #1}{\\partial #2}',
  '\\expval': '\\left\\langle #1\\right\\rangle',
  '\\eval': '\\left.#1\\right\\vert',
  '\\mathbbm': '\\mathbb{#1}',
  '\\SI': '#1\\,\\mathrm{#2}',
  '\\si': '\\mathrm{#1}',
  '\\unit': '\\mathrm{#1}',
  '\\num': '#1',
  '\\intertext': '\\text{#1}',
  '\\eqref': '(\\text{#1})',
  '\\ref': '\\text{#1}',
  // Takes its argument and draws nothing.
  '\\label': '\\vphantom{\\text{#1}}',
}

// POSIX path helpers without `node:path`, so core runs in Workers too.

/** Normalizes an absolute path: collapses `.`, `..` and repeated slashes; never goes above `/`. */
export function normalizePath(path: string) {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** `path` resolved against the absolute directory `cwd`. */
export const resolvePath = (cwd: string, path: string) => normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`)

export const dirname = (path: string) => normalizePath(`${path}/..`)

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Whether `path` is `root` or below it; both normalized. */
export const isUnder = (path: string, root: string) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`)

/** Like posix `path.join`: the result stays relative when the first part is, keeping its leading `..`. */
export function joinPaths(parts: string[]) {
  const joined = parts.filter(Boolean).join('/')
  if (joined.startsWith('/')) return normalizePath(joined)
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && out.length > 0 && out.at(-1) !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/') || '.'
}

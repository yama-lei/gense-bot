// Web plugin (roadmap-3 D1, R33): DeepSeek's search and fetch APIs. `deep_search` is an ordinary tool: several searches
// and the top pages' text in one result, for the model to read and cross-check itself, so it works with any model.
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import type { PluginValue } from './catalog.ts'

export interface WebSource {
  url: string
  title: string
  site: string
}

export interface SearchHit extends WebSource {
  summary: string
  date: string | null
}

const DEEPSEEK = 'https://api.deepseek.com'
const PAGE_CHARS = 12_000
const DEEP_PAGES = 4

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Search hits link to text fragments (`#:~:text=`) and carry tracking params; keep the page URL. */
function cleanUrl(url: string) {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^trk$/.test(k)) u.searchParams.delete(k)
    return u.toString()
  } catch {
    return url
  }
}

/** Where the DeepSeek tools API is and its key; `base` defaults to DeepSeek's own. */
export interface DeepSeek {
  key: string
  base?: string
  onUse?: (service: 'search' | 'fetch') => Promise<void>
}

async function deepseek<T>(api: DeepSeek, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${(api.base ?? DEEPSEEK).replace(/\/$/, '')}/v1/tools/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${api.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal && { signal }),
  })
  if (res.ok) return res.json() as Promise<T>
  const detail = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? res.statusText
  const reason: Record<number, string> = {
    401: '搜索服务的 API Key 无效，请在“定制”页检查网页插件的设置',
    402: '搜索服务余额不足',
    403: '该网页被安全策略拦截',
    404: '该网页没有可读取的内容',
    429: '搜索请求太频繁，请稍后再试',
    504: '网页响应超时',
  }
  throw new Error(`${reason[res.status] ?? `搜索服务出错（${res.status}）`}：${detail}`)
}

export async function webSearch(key: DeepSeek, query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
  type Result = { title: string; url: string; summary?: string; snippet?: string; site_name?: string | null; date?: string | null }
  const { results } = await deepseek<{ results: Result[] }>(key, 'search', { query, count }, signal)
  if (results.length) await key.onUse?.('search')
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const r of results) {
    const url = cleanUrl(r.url)
    if (seen.has(url)) continue
    seen.add(url)
    hits.push({ url, title: r.title || r.site_name || hostOf(url), site: r.site_name || hostOf(url), summary: r.summary || r.snippet || '', date: r.date ?? null })
  }
  return hits
}

export async function webFetch(key: DeepSeek, url: string, signal?: AbortSignal): Promise<{ title: string; content: string }> {
  const r = await deepseek<{ title?: string; content?: string }>(key, 'fetch', { url }, signal)
  if (r.content?.trim()) await key.onUse?.('fetch')
  return { title: r.title || hostOf(url), content: r.content ?? '' }
}

const hitsText = (hits: SearchHit[]) =>
  hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}${h.date ? ` (${h.date})` : ''}\n${h.summary}`).join('\n\n') || '没有搜索结果。'

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text)

/** The web plugin's extension; `config` reads the user's resolved settings at each call. */
export function webExtension(config: () => Record<string, PluginValue>, onUse?: DeepSeek['onUse']) {
  const key = (): DeepSeek => {
    const { deepseekKey, deepseekUrl } = config()
    if (typeof deepseekKey !== 'string' || !deepseekKey) throw new Error('网页插件没有配置 DeepSeek API Key')
    return { key: deepseekKey, ...(typeof deepseekUrl === 'string' && { base: deepseekUrl }), ...(onUse && { onUse }) }
  }
  const count = () => Number(config().searchCount ?? 8) || 8

  return defineExtension({
    name: 'web',
    tools: [
      defineTool({
        name: 'web_search',
        description: [
          'Search the public web. Returns titles, links and short snippets.',
          '- Use it for recent events, facts that may have changed since your training, and anything you are not sure of.',
          '- Snippets are short and can mislead: read a page with `web_fetch` before you rely on its details.',
          '- For a question that needs several sources cross-checked, use `deep_search` instead.',
        ].join('\n'),
        parameters: Type.Object({ query: Type.String({ description: 'A few keywords, in the language most good sources use' }) }),
        replay: 'safe',
        async execute({ query }, _api, context) {
          const hits = await webSearch(key(), query, count(), context.abortSignal)
          return { output: [{ type: 'text', text: hitsText(hits) }], details: { query, sources: hits.map(({ url, title, site }) => ({ url, title, site })) } }
        },
      }),
      defineTool({
        name: 'web_fetch',
        description: 'Read the main text of a web page: a URL the user gave or one a search returned. It does not run scripts or log in, so pages behind a login or built entirely by JavaScript may come back empty.',
        parameters: Type.Object({ url: Type.String({ description: 'The full URL, including https://' }) }),
        replay: 'safe',
        async execute({ url }, _api, context) {
          const page = await webFetch(key(), url, context.abortSignal)
          return {
            output: [{ type: 'text', text: `${page.title}\n${url}\n\n${clip(page.content, PAGE_CHARS * 2)}` }],
            details: { sources: [{ url: cleanUrl(url), title: page.title, site: hostOf(url) }] },
          }
        },
      }),
      defineTool({
        name: 'deep_search',
        description: 'Search with several queries at once and read the main text of the most relevant pages. Slower and much longer than `web_search`; use it for complex questions that need several sources cross-checked. Afterwards, write your own conclusion and cite the pages it rests on.',
        parameters: Type.Object({
          queries: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: '1 to 5 queries, each from a different angle' }),
        }),
        replay: 'safe',
        async execute({ queries }, api, context) {
          const k = key()
          const lists = await Promise.all(queries.map((q) => webSearch(k, q, count(), context.abortSignal).catch(() => [] as SearchHit[])))
          const seen = new Set<string>()
          const hits: SearchHit[] = []
          // Interleave the lists so every query's best hits come first.
          for (let i = 0; lists.some((l) => i < l.length); i++)
            for (const l of lists) {
              const h = l[i]
              if (h && !seen.has(h.url)) {
                seen.add(h.url)
                hits.push(h)
              }
            }
          api.output(`找到 ${hits.length} 个结果，正在读取前 ${Math.min(DEEP_PAGES, hits.length)} 个网页…\n`)
          const pages = await Promise.all(
            hits.slice(0, DEEP_PAGES).map((h) =>
              webFetch(k, h.url, context.abortSignal).then(
                (p) => `## ${p.title}\n${h.url}\n\n${clip(p.content, PAGE_CHARS)}`,
                (e: unknown) => `## ${h.title}\n${h.url}\n\n（读取失败：${e instanceof Error ? e.message : String(e)}）`,
              ),
            ),
          )
          const text = `# 搜索结果\n\n${hitsText(hits)}\n\n# 网页正文\n\n${pages.join('\n\n')}`
          return { output: [{ type: 'text', text }], details: { queries, sources: hits.map(({ url, title, site }) => ({ url, title, site })) } }
        },
      }),
    ],
    sections: [section('web', () => 'When your answer uses web pages, cite them right after the sentence that uses them, as [title](url). Cite only pages you read or a search returned; never make up a link.')],
  })
}

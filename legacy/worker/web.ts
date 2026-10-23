import type { WorkerEnv } from './env'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, stepCountIs } from 'ai'
import type { WebSource } from '../src/types'
import { v1 } from './models'

// Web plugin backends (docs/plans/roadmap-2.md "L1 网页插件"): DeepSeek's search and fetch
// REST APIs, and a research call that lets a GPT model search through the OpenAI endpoint.
// Keys and models come from the plugin's settings ("L0-5 插件配置").

const DEEPSEEK = 'https://api.deepseek.com/v1/tools'

export interface SearchHit extends WebSource {
  summary: string
  date: string | null
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Search hits link to text fragments (`#:~:text=`) and tracking params; keep the page URL. */
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

async function deepseek<T>(key: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${DEEPSEEK}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.ok) return res.json() as Promise<T>
  const detail = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? res.statusText
  const reason: Record<number, string> = { 401: '搜索服务的 API Key 无效，请在“定制”页检查网页插件的设置', 402: '搜索服务余额不足', 403: '该网页被安全策略拦截', 404: '该网页没有可读取的内容', 429: '搜索请求太频繁，请稍后再试', 504: '网页响应超时' }
  throw new Error(`${reason[res.status] ?? `搜索服务出错（${res.status}）`}：${detail}`)
}

export async function webSearch(key: string, query: string, count: number): Promise<SearchHit[]> {
  const { results } = await deepseek<{ results: { title: string; url: string; summary?: string; snippet?: string; site_name?: string | null; date?: string | null }[] }>(key, 'search', { query, count })
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

export async function webFetch(key: string, url: string): Promise<{ title: string; content: string }> {
  const r = await deepseek<{ title?: string; content?: string }>(key, 'fetch', { url })
  return { title: r.title || hostOf(url), content: r.content ?? '' }
}

/** A GPT model researches the question with the endpoint's built-in web search and answers with sources. */
export async function webResearch(env: WorkerEnv, model: string, question: string, signal?: AbortSignal): Promise<{ text: string; sources: WebSource[] }> {
  const openai = createOpenAI({ baseURL: v1(env.OPENAI_BASE_URL), apiKey: env.OPENAI_AUTH_TOKEN })
  const result = await generateText({
    model: openai.responses(model),
    tools: { web_search: openai.tools.webSearch({ searchContextSize: 'high' }) },
    stopWhen: stepCountIs(4),
    system: '你是检索研究员。多次搜索、打开关键网页，交叉核对后，写一份简明的研究结论：先给结论，再列要点，每个要点注明来源。只写有来源支持的内容；查不到就说查不到。',
    prompt: question,
    abortSignal: signal,
  })
  const seen = new Set<string>()
  const sources: WebSource[] = []
  for (const s of result.sources) {
    if (s.sourceType !== 'url') continue
    const url = cleanUrl(s.url)
    if (seen.has(url)) continue
    seen.add(url)
    sources.push({ url, title: s.title || hostOf(url), site: hostOf(url) })
  }
  return { text: result.text, sources }
}

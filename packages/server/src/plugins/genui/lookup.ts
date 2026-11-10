// Lookups the generative UI asks the server for through `tool.call` (docs/plans/openui.md): photos for SearchImage
// from Wikipedia and Wikimedia Commons, and street routes for Map from the public OSRM server. Ported from
// open-intelligent-ui's API routes (MIT, Thesys). Results stay in memory; a failure is retried next time.

const HEADERS = { 'User-Agent': 'gense (https://github.com/thesysdev/open-intelligent-ui port)' }
const SKIP = /\.svg|icon|logo|map|flag|seal|coat_of_arms|signature|diagram/i
const WIDTH = 960
const photoCache = new Map<string, string[]>()
const routeCache = new Map<string, [number, number][]>()

function remember<V>(cache: Map<string, V>, key: string, value: V, max: number) {
  if (cache.size >= max) cache.delete(cache.keys().next().value!)
  cache.set(key, value)
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) })
  // A missing article is an answer, not a failure.
  if (response.status === 404) return {}
  if (!response.ok) throw new Error(`${new URL(url).host} ${response.status}`)
  return response.json()
}

type Page = { index?: number; title?: string; thumbnail?: { source?: string }; imageinfo?: { thumburl?: string; url?: string; mime?: string }[] }

async function query(host: string, params: Record<string, string>): Promise<Page[]> {
  const data = await getJson(`https://${host}/w/api.php?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params })}`)
  // A rate limit comes back as 200 with an error body: throw, so "no photos" is not cached.
  if (data.error) throw new Error(`${host} error`)
  return ((data.query?.pages ?? []) as Page[]).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

/** Words that say what a photo shows; an article must share one with the query. CJK text counts by character pairs. */
function words(text: string) {
  const lower = text.toLowerCase()
  const latin = lower.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3 && !/\p{Script=Han}/u.test(w))
  const han = [...lower.matchAll(/\p{Script=Han}+/gu)].flatMap(([run]) => [...run].slice(0, -1).map((c, i) => c + run[i + 1]))
  return [...latin, ...han]
}

/** Up to four photo URLs for `q`: the article with that exact title, then a search, then Commons files. */
export async function findPhotos(q: string): Promise<string[]> {
  const key = q.replace(/\s+/g, ' ').trim()
  if (key.length < 2 || key.length > 200) throw new Error('query 要有 2 到 200 个字')
  const cached = photoCache.get(key)
  if (cached) return cached
  const images: string[] = []
  const add = (url: string | undefined) => {
    const full = url?.startsWith('//') ? `https:${url}` : url
    if (full?.startsWith('https://') && !SKIP.test(full) && !images.includes(full)) images.push(full)
  }
  const wiki = /\p{Script=Han}/u.test(key) ? 'zh.wikipedia.org' : 'en.wikipedia.org'
  const summary = await getJson(`https://${wiki}/api/rest_v1/page/summary/${encodeURIComponent(key.replace(/ /g, '_'))}`).catch(() => ({}))
  // The summary's thumbnail is small; the same file at the width the other results use.
  add(summary?.thumbnail?.source?.replace(/\/\d+px-/, `/${WIDTH}px-`))
  const wanted = new Set(words(key))
  const articles = await query(wiki, { generator: 'search', gsrsearch: key, gsrlimit: '6', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: String(WIDTH) })
  // Only articles about the query: a search for a dish should not return a restaurant chain's storefront.
  for (const page of articles) if (words(page.title ?? '').some((w) => wanted.has(w))) add(page.thumbnail?.source)
  // Then Commons files, dropping trailing words when a long description finds nothing.
  const terms = key.split(' ')
  for (const t of new Set([terms.join(' '), terms.slice(0, 3).join(' '), terms.slice(0, 2).join(' ')])) {
    if (images.length >= 3) break
    const files = await query('commons.wikimedia.org', { generator: 'search', gsrsearch: `${t} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '6', prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: String(WIDTH) })
    for (const page of files) {
      const info = page.imageinfo?.[0]
      if (info?.mime?.startsWith('image/')) add(info.thumburl ?? info.url)
    }
  }
  const found = images.slice(0, 4)
  if (found.length) remember(photoCache, key, found, 500)
  return found
}

const MAX_STOPS = 25

/** Street geometry as [lat, lng] points through 2–25 stops given as "lng,lat;lng,lat". A road overview, not directions. */
export async function streetRoute(coords: string): Promise<[number, number][]> {
  const points = coords.split(';').map((pair) => pair.split(',').map(Number))
  const valid =
    points.length >= 2 && points.length <= MAX_STOPS && points.every(([lng, lat, ...rest]) => !rest.length && Math.abs(lng!) <= 180 && Math.abs(lat!) <= 90)
  if (!valid) throw new Error(`coords 要有 2–${MAX_STOPS} 个 lng,lat`)
  const key = points.map((p) => p.join(',')).join(';')
  const cached = routeCache.get(key)
  if (cached) return cached
  const data = await getJson(`https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson&steps=false`)
  const line: [number, number][] = data.routes?.[0]?.geometry?.coordinates ?? []
  if (data.code !== 'Ok' || line.length < 2) throw new Error('没有找到街道路线')
  const route = line.map(([lng, lat]) => [lat, lng] as [number, number])
  remember(routeCache, key, route, 200)
  return route
}

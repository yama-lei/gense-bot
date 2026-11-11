const DAY = 86_400_000

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0)

/** "刚刚", "5 分钟前", "昨天 14:02", "3月2日". */
export function formatTime(t: number, now = Date.now()) {
  const diff = now - t
  if (diff >= 0 && diff < 60_000) return '刚刚'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(t)
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY)
  if (days === 0) return time
  if (days === 1) return `昨天 ${time}`
  if (days === -1) return `明天 ${time}`
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return `${d.toLocaleDateString('zh-CN', { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric' })} ${time}`
}

/** Which sidebar group a conversation updated at `t` belongs to. */
export function dayGroup(t: number, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return '7 天内'
  if (days < 30) return '30 天内'
  return '更早'
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

export function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** An http(s) URL as the browser may open it, or undefined. */
export function webUrl(value: unknown) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // No clipboard permission (insecure origin, no focus): the selection route still works.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

export const fileBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })

export const toBlob = (mimeType: string, base64: string) => new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mimeType })

export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: url, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

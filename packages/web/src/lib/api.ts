// JSON calls to the account and admin HTTP API (roadmap-6 D); everything else goes over the WebSocket.
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Sends `body` as JSON and resolves to the parsed reply; a non-2xx reply throws the server's `error` text. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      ...(init.body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
    })
  } catch {
    throw new ApiError('无法连接服务器', 0)
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new ApiError(data?.error ?? (res.status === 429 ? '尝试次数过多，请稍后再试' : `请求失败（${res.status}）`), res.status)
  return data as T
}

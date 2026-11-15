import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { accountApi, Auth, Connection, json, sameOrigin, signedIn } from '../index.ts'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isIP } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { startBackups } from './backup.ts'
import type { HostConfig } from './config.ts'
import { Spaces } from './spaces.ts'
import { lockData } from './data-lock.ts'
import { AppStore } from './app.ts'
import { ShareRateLimit, ShareStore } from './shares.ts'
import { readJson } from './http.ts'
import type { SharedProviderInput, UserPatch } from '@gense/protocol'
import { SpeechApi, ASR_MAX_BYTES } from './speech.ts'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_BODY = 64 * 1024
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

function clientIp(request: IncomingMessage, trustProxy: boolean | undefined) {
  const socket = request.socket.remoteAddress ?? 'unknown'
  if (!trustProxy) return socket
  const forwarded = request.headers['x-forwarded-for']
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').at(-1)?.trim()
  return last && isIP(last) ? last : socket
}

export const DB_FILE = 'app.sqlite'

export const openDatabase = (dataDir: string): Promise<SqliteDatabase> => openNodeSqliteDatabase(join(dataDir, DB_FILE))

/** The request as a web-standard Request, for the handlers in core. */
async function toRequest(req: IncomingMessage) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const proto = req.headers['x-forwarded-proto'] === 'https' || 'encrypted' in req.socket ? 'https' : 'http'
  const url = `${proto}://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
  if (req.method === 'GET' || req.method === 'HEAD') return new Request(url, { method: req.method, headers })
  let size = 0
  const chunks: Buffer[] = []
  const limit = new URL(url).pathname === '/api/speech/asr' ? ASR_MAX_BYTES : MAX_BODY
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) { req.resume(); throw Object.assign(new Error('请求太大'), { status: 413 }) }
    chunks.push(chunk)
  }
  return new Request(url, { method: req.method, headers, body: Buffer.concat(chunks) })
}

async function send(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res)
  else res.end()
}

export async function startServer(config: HostConfig) {
  const unlock = await lockData(config.dataDir)
  try { return await openServer(config, unlock) } catch (error) { await unlock(); throw error }
}

async function openServer(config: HostConfig, unlock: () => Promise<void>) {
  const db = await openDatabase(config.dataDir)
  let cleanup = async () => { await db.close() }
  try {
    const auth = await Auth.open(db)
    const app = await AppStore.open(db, config.secretKey)
    const speech = new SpeechApi(app)
    const shares = await ShareStore.open(db), shareLimit = new ShareRateLimit()
    const spaces = new Spaces(config, auth, app, shares)
    cleanup = async () => { await spaces.close(); await shares.flush(); await db.close() }
    await spaces.start()
    const backups = config.backups === false ? undefined : startBackups(db, join(config.dataDir, 'backups', 'app'), config.backups)
    cleanup = async () => { await backups?.stop(); await spaces.close(); await shares.flush(); await db.close() }

    async function staticFile(res: ServerResponse, path: string) {
      const sharedPage = /^\/s\/[^/]+\/?$/.test(path)
      const file = normalize(join(config.webDir, decodeURIComponent(path)))
      const inside = file.startsWith(config.webDir + sep)
      const found = !sharedPage && inside && (await stat(file).catch(() => undefined))?.isFile()
      // Client-side routes fall back to the app shell.
      const target = found ? file : join(config.webDir, 'index.html')
      const body = await readFile(target).catch(() => undefined)
      if (!body) return send(res, json(404, { error: '前端未构建：运行 npm run build，或用 npm run dev' }))
      const immutable = found && target.includes(`${sep}assets${sep}`)
      res.writeHead(200, {
        'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(sharedPage && { 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' }),
      })
      res.end(body)
    }

    const socketSessions = new Map<WebSocket, Request>()
    const expireSockets = async () => {
      await Promise.all([...socketSessions].map(async ([ws, request]) => {
        if (!(await signedIn(auth, request))) ws.close(4401, 'Session expired')
      }))
    }
    async function api(request: Request, ip: string): Promise<Response> {
      const url = new URL(request.url), path = url.pathname
      const shared = /^\/api\/share\/([^/]+)$/.exec(path)
      if (shared) {
        // Public snapshots do not inspect cookies or resolve a user runtime.
        const headers = { 'x-robots-tag': 'noindex' }
        if (request.method !== 'GET') return json(405, { error: 'GET only' }, { ...headers, allow: 'GET' })
        if (!shareLimit.allow(ip)) return json(429, { error: '访问过于频繁，请稍后再试' }, { ...headers, 'retry-after': '60' })
        const page = await shares.page(shared[1]!)
        return page ? json(200, page, headers) : json(404, { error: '分享链接不存在或已撤销' }, headers)
      }
      const userRoute = /^\/api\/users\/([^/]+)\/(.*)$/.exec(path)
      const hook = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(path)
      const user = await signedIn(auth, request)
      if (path === '/api/speech' || path.startsWith('/api/speech/')) {
        if (!user) return json(401, { error: '未登录' })
        return speech.handle(user.id, request)
      }
      if (path === '/api/usage' && request.method === 'GET') {
        if (!user) return json(401, { error: '未登录' })
        try { return json(200, await app.usage(url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined, user.id)) }
        catch (error) { return json(400, { error: error instanceof Error ? error.message : String(error) }) }
      }
      // Webhook secrets authenticate external callers. A browser session may only target its own space.
      if (hook) {
        if (user && user.id !== hook[1]) return json(403, { error: '无权访问' })
        const owner = await auth.user(hook[1]!)
        const space = owner && !owner.disabled ? spaces.get(owner.id) : undefined
        return space ? space.handleWebhook(hook[2]!, request) : json(404, { error: 'not found' })
      }
      if (userRoute) {
        if (!user) return json(401, { error: '未登录' })
        if (user.id !== userRoute[1]) return json(403, { error: '无权访问' })
        const space = await spaces.sync(user.id)
        if (!space) return json(403, { error: '账号已停用' })
        if (userRoute[2] === 'mcp/callback' && request.method === 'GET') {
          try { await space.mcp.callback(url); return new Response('MCP 授权完成，可以关闭此页面。') }
          catch { return json(400, { error: 'MCP 授权回调无效' }) }
        }
        const file = /^files\/([^/]+)$/.exec(userRoute[2]!)
        if (file && request.method === 'GET') {
          try {
            const result = await (await space.files(file[1]!)).read(file[1]!, url.searchParams.get('path') ?? '')
            return new Response(Buffer.from(result.base64, 'base64'), { headers: { 'content-type': result.mimeType, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`, 'cache-control': 'no-store' } })
          } catch { return json(404, { error: '文件不存在' }) }
        }
        return json(404, { error: 'not found' })
      }
      if (path.startsWith('/api/admin/')) {
        if (!user) return json(401, { error: '未登录' })
        if (user.role !== 'admin') return json(403, { error: '需要管理员权限' })
        if (request.method !== 'GET' && !sameOrigin(request)) return json(403, { error: '来源不匹配' })
        try {
          if (path === '/api/admin/users' && request.method === 'GET') return json(200, await auth.users())
          const account = /^\/api\/admin\/users\/([^/]+)$/.exec(path)
          if (account && request.method === 'PATCH') {
            const body = await readJson(request)
            if ((body.disabled !== undefined && typeof body.disabled !== 'boolean') || (body.role !== undefined && body.role !== 'admin' && body.role !== 'user')) return json(400, { error: '参数无效' })
            const updated = await auth.updateUser(account[1]!, body as UserPatch)
            await expireSockets()
            await spaces.sync(updated.id)
            return json(200, updated)
          }
          if (path === '/api/admin/registration') {
            if (request.method === 'PUT') {
              const body = await readJson(request)
              if (typeof body.open !== 'boolean') return json(400, { error: '参数无效' })
              await auth.setRegistration(body.open)
            }
            if (request.method === 'GET' || request.method === 'PUT') return json(200, { open: await auth.registrationOpen() })
          }
          if (path === '/api/admin/providers') {
            if (request.method === 'GET') return json(200, await app.providers())
            if (request.method === 'POST') return json(200, await app.putProvider(await readJson(request) as unknown as SharedProviderInput))
          }
          const provider = /^\/api\/admin\/providers\/([^/]+)$/.exec(path)
          if (provider) {
            if (!(await app.providers()).some(p => p.id === provider[1])) return json(404, { error: 'not found' })
            if (request.method === 'PUT') return json(200, await app.putProvider(await readJson(request) as unknown as SharedProviderInput, provider[1]))
            if (request.method === 'DELETE') { await app.deleteProvider(provider[1]!); return json(200, {}) }
          }
          if (path === '/api/admin/usage' && request.method === 'GET') return json(200, await app.usage(url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined))
          if (path === '/api/admin/feedback' && request.method === 'GET') return json(200, await app.feedback.summary(url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined))
        } catch (error) { return json(400, { error: error instanceof Error ? error.message : String(error) }) }
        return json(404, { error: 'not found' })
      }
      const response = await accountApi(auth, request)
      if (response.ok && path === '/api/register') { const current = (await response.clone().json()).user; await spaces.sync(current.id) }
      if (response.ok && request.method === 'POST' && (path === '/api/password' || path === '/api/logout')) await expireSockets()
      return response
    }
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const handled = path.startsWith('/api/') || path.startsWith('/hooks/')
        ? toRequest(req).then(request => api(request, clientIp(req, config.trustProxy))).then(r => send(res, r))
        : staticFile(res, path)
      handled.catch((error) => {
        if (!res.headersSent) void send(res, json((error as { status?: number })?.status === 413 ? 413 : 500, { error: error instanceof Error ? error.message : String(error) }))
        else res.destroy()
      })
    })

    const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
    server.on('upgrade', (req, socket, head) => {
      void (async () => {
        const request = await toRequest(req)
        const user = await signedIn(auth, request)
        if (!(new URL(request.url).pathname === '/ws' && sameOrigin(request) && user)) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          return
        }
        const opened = await spaces.sync(user.id)
        if (!opened) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
        wss.handleUpgrade(req, socket, head, (ws) => {
          socketSessions.set(ws, request)
          const connection = new Connection({ space: opened, send: m => { if (ws.readyState === WebSocket.OPEN) ws.send(m) } })
          // Requests are handled in arrival order so a send never overtakes the watch before it.
          let queue = connection.start()
          ws.on('message', (data) => {
            queue = queue.then(async () => { if (!(await signedIn(auth, request))) { ws.close(4401, 'Session expired'); return }; await connection.handle(String(data)) }).catch(() => {})
          })
          ws.on('close', () => { socketSessions.delete(ws); void connection.close() })
          ws.on('error', () => void connection.close())
        })
      })().catch(() => socket.destroy())
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
    })
    const { port } = server.address() as AddressInfo

    let closing: Promise<void> | undefined
    return {
      url: `http://${config.host}:${port}`,
      auth,
      spaces,
      app,
      backups,
      close() {
        return closing ??= (async () => {
          for (const ws of wss.clients) ws.terminate()
          wss.close()
          await new Promise<void>((resolve) => server.close(() => resolve()))
          try { await cleanup() } finally { await unlock() }
          })()
      },
    }
  } catch (error) { await cleanup().catch(() => {}); throw error }
}

// Self-hosted deployment (ADR-0004 decision 3): one process, one SQLite file per user, sockets over `ws`.
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { Auth, Connection, SESSION_COOKIE, SESSION_MAX_AGE_S, UserSpace, type ModelSetup, type User } from '@gense/core'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import type { HostConfig } from './config.ts'

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

export const openAuth = async (dataDir: string) => {
  await mkdir(dataDir, { recursive: true })
  return Auth.open(await openNodeSqliteDatabase(join(dataDir, 'app.sqlite')))
}

const cookies = (req: IncomingMessage) =>
  Object.fromEntries(
    (req.headers.cookie ?? '').split(';').flatMap((part) => {
      const i = part.indexOf('=')
      return i < 0 ? [] : [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]]
    }),
  ) as Record<string, string>

const isHttps = (req: IncomingMessage) => req.headers['x-forwarded-proto'] === 'https' || 'encrypted' in req.socket

const sessionCookie = (req: IncomingMessage, token: string, maxAge: number) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`

/** Browsers send Origin on WebSocket and fetch POSTs; it must match the host the page came from. */
const sameOrigin = (req: IncomingMessage) => {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求太大')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  return value && typeof value === 'object' ? value : {}
}

export async function startServer(config: HostConfig) {
  const auth = await openAuth(config.dataDir)
  const spaces = new Map<string, Promise<{ space: UserSpace; setup: ModelSetup }>>()

  const space = (userId: string) => {
    let opening = spaces.get(userId)
    if (!opening) {
      opening = (async () => {
        const dir = join(config.dataDir, 'users', userId)
        await mkdir(dir, { recursive: true })
        const setup = config.models()
        const db = await openNodeSqliteDatabase(join(dir, 'pi.sqlite'))
        return { space: await UserSpace.open(db, { models: setup.models, defaultModel: setup.defaultModel }), setup }
      })()
      opening.catch(() => spaces.delete(userId))
      spaces.set(userId, opening)
    }
    return opening
  }

  // Open every existing space now so runs a previous process left unfinished resume without waiting for a login.
  for (const user of await auth.users()) {
    if (existsSync(join(config.dataDir, 'users', user.id, 'pi.sqlite'))) await space(user.id)
  }

  const currentUser = async (req: IncomingMessage): Promise<User | undefined> => {
    const token = cookies(req)[SESSION_COOKIE]
    return (token && (await auth.session(token))) || undefined
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: '来源不匹配' })
    if (path === '/api/login' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        const { token, user } = await auth.login(String(body.email ?? ''), String(body.password ?? ''))
        return json(res, 200, { email: user.email }, { 'set-cookie': sessionCookie(req, token, SESSION_MAX_AGE_S) })
      } catch (error) {
        return json(res, 401, { error: error instanceof Error ? error.message : '登录失败' })
      }
    }
    if (path === '/api/logout' && req.method === 'POST') {
      const token = cookies(req)[SESSION_COOKIE]
      if (token) await auth.logout(token)
      return json(res, 200, {}, { 'set-cookie': sessionCookie(req, '', 0) })
    }
    if (path === '/api/me' && req.method === 'GET') {
      const user = await currentUser(req)
      return user ? json(res, 200, { email: user.email }) : json(res, 401, { error: '未登录' })
    }
    return json(res, 404, { error: 'not found' })
  }

  async function staticFile(res: ServerResponse, path: string) {
    const file = normalize(join(config.webDir, decodeURIComponent(path)))
    const inside = file.startsWith(config.webDir + sep)
    const found = inside && (await stat(file).catch(() => undefined))?.isFile()
    // Client-side routes fall back to the app shell.
    const target = found ? file : join(config.webDir, 'index.html')
    const body = await readFile(target).catch(() => undefined)
    if (!body) return json(res, 404, { error: '前端未构建：运行 npm run build，或用 npm run dev' })
    const immutable = found && target.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(body)
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const handled = path.startsWith('/api/') ? api(req, res, path) : staticFile(res, path)
    handled.catch((error) => {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      else res.destroy()
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const user = path === '/ws' && sameOrigin(req) ? await currentUser(req) : undefined
      if (!user) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      const { space: userSpace, setup } = await space(user.id)
      wss.handleUpgrade(req, socket, head, (ws) => {
        const connection = new Connection({
          space: userSpace,
          email: user.email,
          models: setup.options,
          defaultModel: setup.defaultModel,
          send: (m) => ws.send(m),
        })
        // Requests are handled in arrival order so a send never overtakes the watch before it.
        let queue = connection.start()
        ws.on('message', (data) => {
          queue = queue.then(() => connection.handle(String(data))).catch(() => {})
        })
        ws.on('close', () => void connection.close())
      })
    })().catch(() => socket.destroy())
  })

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://${config.host}:${port}`,
    auth,
    async close() {
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      for (const opening of spaces.values()) await (await opening.catch(() => undefined))?.space.close()
      await auth.close()
    },
  }
}

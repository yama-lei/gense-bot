// The server (ADR-0005): one process, one owner, one SQLite file for login and pi-durable, sockets over `ws`.
//
//   <dataDir>/gense.sqlite    login sessions, app tables and pi-durable storage
//   <dataDir>/files/          the owner's files, mounted at /data in the sandbox
//   <dataDir>/backups/        nightly copies of gense.sqlite
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { accountApi, Auth, Connection, DATA_DIR, json, MountedEnv, parseHookPath, sameOrigin, signedIn, UserSpace } from '../index.ts'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { startBackups } from './backup.ts'
import type { HostConfig } from './config.ts'
import { Sandbox, SandboxedEnv } from './sandbox.ts'

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

export const DB_FILE = 'gense.sqlite'

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
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求太大')
    chunks.push(chunk)
  }
  return new Request(url, { method: req.method, headers, body: Buffer.concat(chunks) })
}

async function send(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}

export async function startServer(config: HostConfig) {
  const files = resolve(config.dataDir, 'files')
  await mkdir(files, { recursive: true })
  const db = await openDatabase(config.dataDir)
  const auth = await Auth.open(db)
  if (!(await auth.hasPassword())) console.warn('还没有设置登录密码：运行 npm run passwd')

  let space: UserSpace | undefined
  const sandbox = config.sandbox && new Sandbox({ ...config.sandbox, name: `gense-sandbox-${createHash('sha256').update(files).digest('hex').slice(0, 12)}`, root: files, image: () => String(space?.plugins.resolved('sandbox').image ?? 'slim') })
  const env = (cwd: string) =>
    sandbox
      ? new SandboxedEnv(new NodeExecutionEnv({ cwd: files }), sandbox, { target: files, cwd })
      : new MountedEnv(new NodeExecutionEnv({ cwd: files }), { mount: DATA_DIR, target: files, cwd })
  // Opening resumes runs a previous process left unfinished (R32). The space owns `db` and closes it.
  space = await UserSpace.open(db, { models: config.models(), env, plugins: config.plugins, secretKey: config.secretKey, sandbox: !!sandbox, webhooks: true })
  const opened = space
  const backups = config.backups === false ? undefined : startBackups(db, join(config.dataDir, 'backups'), config.backups)

  async function staticFile(res: ServerResponse, path: string) {
    const file = normalize(join(config.webDir, decodeURIComponent(path)))
    const inside = file.startsWith(config.webDir + sep)
    const found = inside && (await stat(file).catch(() => undefined))?.isFile()
    // Client-side routes fall back to the app shell.
    const target = found ? file : join(config.webDir, 'index.html')
    const body = await readFile(target).catch(() => undefined)
    if (!body) return send(res, json(404, { error: '前端未构建：运行 npm run build，或用 npm run dev' }))
    const immutable = found && target.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(body)
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    // A webhook call (R50) is signed by its secret, not by a session.
    const hookId = parseHookPath(path)
    const handled = hookId
      ? toRequest(req).then((request) => opened.handleWebhook(hookId, request)).then((r) => send(res, r))
      : path.startsWith('/api/')
      ? toRequest(req).then((request) => accountApi(auth, request)).then((r) => send(res, r))
      : staticFile(res, path)
    handled.catch((error) => {
      if (!res.headersSent) void send(res, json(500, { error: error instanceof Error ? error.message : String(error) }))
      else res.destroy()
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const request = await toRequest(req)
      if (!(new URL(request.url).pathname === '/ws' && sameOrigin(request) && (await signedIn(auth, request)))) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const connection = new Connection({ space: opened, send: (m) => ws.send(m) })
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
    sandbox,
    backups,
    async close() {
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await backups?.stop()
      await opened.close()
      await sandbox?.stop()
    },
  }
}

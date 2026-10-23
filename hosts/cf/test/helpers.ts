// Runs `wrangler dev` as a child process group, so a test can crash it (workerd included) and start it again.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.once('error', reject)
  })

export const ADMIN_TOKEN = 'test-admin'

export interface Dev {
  url: string
  child: ChildProcess
  /** Ends wrangler and workerd at once; `SIGKILL` simulates a crash. */
  stop(signal?: NodeJS.Signals): Promise<void>
}

export async function wranglerDev(stateDir: string, vars: Record<string, string> = {}): Promise<Dev> {
  const port = await freePort()
  const extra = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])
  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', stateDir, '--var', 'GENSE_FAUX:1', '--var', `ADMIN_TOKEN:${ADMIN_TOKEN}`, '--show-interactive-dev-session=false', ...extra],
    { cwd: new URL('..', import.meta.url), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_PROXY: '*', no_proxy: '*', WRANGLER_SEND_METRICS: 'false' } },
  )
  let log = ''
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${log}`)), 60_000)
    const onData = (s: Buffer) => {
      log += s
      if (log.includes('Ready on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    void exited.then(() => reject(new Error(`wrangler dev exited early:\n${log}`)))
  })
  return {
    url: `http://127.0.0.1:${port}`,
    child,
    async stop(signal = 'SIGTERM') {
      try {
        process.kill(-child.pid!, signal)
      } catch {
        return
      }
      await exited
    },
  }
}

export async function addUser(url: string, email: string, password: string) {
  const res = await fetch(`${url}/api/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`adding a user failed: ${res.status} ${await res.text()}`)
}

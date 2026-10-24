// The user's sandbox (roadmap-3 D7): one Docker container per user, started by the first command and removed after it
// sits idle. Commands run in it with `docker exec`; file tools keep using the host directory, which the container
// mounts at /data, so a virtual path is the same path inside the container.
import type { Context } from '@earendil-works/chord'
import { ExecutionError, err, type ExecutionEnv, type ShellExecOptions, type ShellExecResult, type Result } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { DATA_DIR, MountedEnv, SKILLS_DIR } from '@gense/core'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface SandboxOptions {
  /** Container name suffix; from the login identity, never from a request. */
  userId: string
  /** The user's files directory, mounted at /data. */
  root: string
  /** `slim` or `full`, read at each start. */
  image: () => string
  /** Image name prefix: `<prefix>:slim`. */
  imagePrefix?: string
  memory?: string
  cpus?: string
  pids?: number
  idleMs?: number
}

/** Private, link-local and shared address ranges the container may not reach: the host's ports and the LAN (D7). */
const BLOCKED = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4']
export const NETWORK = 'gense-sandbox'
/** The container's /tmp lives in the user's directory, so `read` can open what a command left there. */
export const SANDBOX_TMP = '/tmp'
export const tmpDir = (root: string) => join(root, '.tmp')
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'NO_PROXY', 'ALL_PROXY'].flatMap((v) => [v, v.toLowerCase()])

/** What the docker CLI needs from the host's environment; nothing else reaches it, so no secret can (R59). */
function dockerEnv() {
  const keep = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR']
  return Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))
}

const docker = (args: string[]) => run('docker', args, { env: dockerEnv(), maxBuffer: 1 << 20 })

let network: Promise<unknown> | undefined
/** A bridge network of our own; its containers cannot reach each other either, since its subnet is private. */
function ensureNetwork() {
  network ??= docker(['network', 'inspect', NETWORK]).catch(() => docker(['network', 'create', NETWORK]).catch(() => docker(['network', 'inspect', NETWORK])))
  network.catch(() => (network = undefined))
  return network
}

export class Sandbox {
  readonly name: string
  readonly #options: SandboxOptions
  /** The docker CLI runs as a host process; its output spills to the user's cache, which the container can read. */
  readonly #cli: NodeExecutionEnv
  #starting: Promise<void> | undefined
  #image: string | undefined
  #running = 0
  #lastUsed = 0
  #timer: NodeJS.Timeout | undefined

  constructor(options: SandboxOptions) {
    this.#options = options
    this.name = `gense-sandbox-${options.userId.replace(/[^\w.-]/g, '')}`
    this.#cli = new NodeExecutionEnv({ cwd: options.root })
  }

  get imageName() {
    return `${this.#options.imagePrefix ?? 'gense-sandbox'}:${this.#options.image() === 'full' ? 'full' : 'slim'}`
  }

  /** Starts the container unless it runs; a changed image setting applies when no other command runs (R58). */
  async #ensure() {
    const wanted = this.imageName
    if (this.#starting && (this.#image === wanted || this.#running > 1)) {
      const started = await this.#starting.then(() => true, () => false)
      if (started && (await this.#alive())) return
    }
    this.#image = wanted
    this.#starting = this.#start(wanted)
    this.#starting.catch(() => (this.#starting = undefined))
    await this.#starting
  }

  async #alive() {
    const out = await docker(['inspect', '-f', '{{.State.Running}}', this.name]).catch(() => undefined)
    return out?.stdout.trim() === 'true'
  }

  async #start(image: string) {
    const { root } = this.#options
    await docker(['image', 'inspect', image]).catch(() => {
      throw new Error(`沙箱镜像 ${image} 还没有构建：在服务器上运行 npm run sandbox:build`)
    })
    await ensureNetwork()
    await docker(['rm', '-f', this.name]).catch(() => {})
    // A fresh /tmp for each container, as a reboot would leave it.
    await rm(tmpDir(root), { recursive: true, force: true })
    for (const dir of ['skills', '.cache', '.local', '.home', '.tmp']) await mkdir(join(root, dir), { recursive: true })
    const uid = process.getuid?.() ?? 1000
    const gid = process.getgid?.() ?? 1000
    await docker([
      'run', '-d', '--name', this.name, '--label', 'gense.sandbox=1', '--hostname', 'sandbox',
      // The host's uid, so files the sandbox writes stay the host's; no root, no added capabilities (D7).
      '--user', `${uid}:${gid}`, '--security-opt', 'no-new-privileges', '--init',
      '--network', NETWORK,
      '--memory', this.#options.memory ?? '2g', '--memory-swap', this.#options.memory ?? '2g',
      '--cpus', this.#options.cpus ?? '2', '--pids-limit', String(this.#options.pids ?? 512),
      '--mount', `type=bind,src=${root},dst=${DATA_DIR}`,
      '--mount', `type=bind,src=${join(root, 'skills')},dst=${SKILLS_DIR},readonly`,
      '--mount', `type=bind,src=${tmpDir(root)},dst=${SANDBOX_TMP}`,
      // The docker CLI adds the host's proxy settings; they point at the host, which the sandbox cannot reach.
      ...PROXY_VARS.flatMap((v) => ['--env', `${v}=`]),
      image, 'sleep', 'infinity',
    ])
    try {
      await this.#firewall(image)
    } catch (error) {
      await docker(['rm', '-f', this.name]).catch(() => {})
      throw new Error(`沙箱网络规则设置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Rejects private ranges in the container's own network namespace, from a short-lived helper that holds NET_ADMIN;
   * the sandbox itself has no NET_ADMIN, so it cannot undo them.
   */
  async #firewall(image: string) {
    const rules = ['iptables -A OUTPUT -o lo -j ACCEPT', ...BLOCKED.map((net) => `iptables -A OUTPUT -d ${net} -j REJECT`)]
    await docker(['run', '--rm', '--network', `container:${this.name}`, '--cap-add', 'NET_ADMIN', '--user', '0', '--entrypoint', 'sh', image, '-c', rules.join(' && ')])
  }

  /** Runs a command in the container with `cwd` a path under /data; a timeout or abort kills what it started. */
  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, cwd: string, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    this.#running++
    this.#touch()
    try {
      try {
        await this.#ensure()
      } catch (error) {
        return err(new ExecutionError('spawn_error', error instanceof Error ? error.message : String(error)))
      }
      const id = randomUUID()
      const argv = typeof command === 'string' ? ['bash', '-c', command] : [...command]
      const env = Object.entries(options?.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`])
      const result = await this.#cli.exec(
        ['docker', 'exec', '--workdir', cwd, '--env', `GENSE_RUN=${id}`, ...env, this.name, ...argv],
        { ...options, cwd: undefined, env: dockerEnv(), inheritEnv: false },
        context,
      )
      if (!result.ok) await this.#kill(id)
      return this.#spilled(result)
    } finally {
      this.#running--
      this.#touch()
    }
  }

  /** Kills the processes of one command, found by the marker in their environment, which children inherit. */
  async #kill(id: string) {
    const script = `for d in /proc/[0-9]*; do grep -qa "GENSE_RUN=${id}" "$d/environ" 2>/dev/null && kill -9 "\${d#/proc/}" 2>/dev/null; done; true`
    await docker(['exec', this.name, 'sh', '-c', script]).catch(() => {})
  }

  /** Moves spilled output into the user's cache, at a path the agent can read in the sandbox. */
  async #spilled(result: Result<ShellExecResult, ExecutionError>): Promise<Result<ShellExecResult, ExecutionError>> {
    const spillPath = result.ok ? result.value.spillPath : result.error.spillPath
    if (!spillPath) return result
    const dir = join(this.#options.root, '.cache', 'output')
    await mkdir(dir, { recursive: true })
    const name = basename(spillPath)
    const moved = await rename(spillPath, join(dir, name)).then(() => `${DATA_DIR}/.cache/output/${name}`, () => spillPath)
    if (result.ok) return { ok: true, value: { ...result.value, spillPath: moved } }
    result.error.spillPath = moved
    return result
  }

  #touch() {
    this.#lastUsed = Date.now()
    if (this.#timer) return
    const idle = this.#options.idleMs ?? 15 * 60_000
    this.#timer = setInterval(() => {
      if (this.#running > 0 || Date.now() - this.#lastUsed < idle) return
      void this.stop()
    }, Math.min(idle, 60_000))
    this.#timer.unref()
  }

  /** Removes the container; the files stay in the host directory, and the next command starts a new one. */
  async stop() {
    clearInterval(this.#timer)
    this.#timer = undefined
    this.#starting = undefined
    await docker(['rm', '-f', this.name]).catch(() => {})
  }
}

/** The user's files with `exec` in their sandbox: the virtual working directory is the same path in the container. */
export class SandboxedEnv extends MountedEnv {
  readonly #sandbox: Sandbox

  constructor(inner: ExecutionEnv, sandbox: Sandbox, options: { target: string; cwd: string }) {
    super(inner, { mount: DATA_DIR, ...options, readOnly: { mount: SANDBOX_TMP, target: tmpDir(options.target) } })
    this.#sandbox = sandbox
  }

  override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
    const cwd = options?.cwd ? (options.cwd.startsWith('/') ? options.cwd : `${this.cwd}/${options.cwd}`) : this.cwd
    return this.#sandbox.exec(command, options, cwd, context)
  }
}

// Sandbox plugin (roadmap-3 D7, R57): `bash` runs in the user's own container, which the host provides through the
// environment's `exec`; file tools keep reading the host directory. Hosts without a sandbox (Cloudflare) never offer it.
import { defineExtension, section } from '@earendil-works/pi-durable'
import { createBashTool, type BashToolInput } from '@earendil-works/pi-durable/tools'
import type { PluginValue } from '../catalog.ts'

/** Seconds a command may run when the model names no timeout, and at most. */
export const BASH_TIMEOUT = 120
const MAX_TIMEOUT = 1800

export function sandboxExtension(_config: () => Record<string, PluginValue>) {
  const bash = createBashTool()
  return defineExtension({
    name: 'sandbox',
    tools: [
      {
        ...bash,
        execute: (args: BashToolInput, api, context) => bash.execute({ ...args, timeout: Math.min(args.timeout ?? BASH_TIMEOUT, MAX_TIMEOUT) }, api, context),
      },
    ],
    sections: [
      section('sandbox', () =>
        [
          '你可以用 bash 在用户自己的 Linux 沙箱里运行命令，当前目录就是本会话工作区，生成的文件用户能在文件面板里看到。',
          '沙箱里有 Python 3、Node、git、uv、rg 等工具，可以联网，可以用 pip install --user、uv、npm 安装依赖；没有 root 权限，不能 apt install。',
          '给用户的文件放在工作区；/tmp 里的文件你也能用 read 读取（例如检查生成的图片），但用户看不到，沙箱重启后会清空。',
          `命令默认 ${BASH_TIMEOUT} 秒超时，耗时更长的用 timeout 参数加长；不要启动常驻的服务。沙箱里没有任何密钥，需要密钥的事用对应的工具做。`,
        ].join('\n'),
      ),
    ],
  })
}

/** Said instead when this conversation cannot run commands, so the assistant explains it rather than pretends (R57). */
export const noSandbox = defineExtension({
  name: 'no-sandbox',
  sections: [section('sandbox', () => '这里不能运行代码或命令（没有 bash）。用户要求运行代码时，说明这个部署或当前设置不支持，可以给出代码让用户自己运行。')],
})

// Sandbox plugin (roadmap-3 D7, R57): `bash` runs in a container the host provides through the environment's `exec`;
// file tools keep reading the host directory. Without a sandbox (SANDBOX=0) it is not offered.
import { defineExtension, section } from '@earendil-works/pi-durable'
import { createBashTool, type BashToolInput } from '@earendil-works/pi-durable/tools'
import type { PluginValue } from './catalog.ts'

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
        description: [
          "Run a bash command in the user's Linux sandbox. The current directory is this conversation's workspace. Returns stdout and stderr together; long output keeps only the last 2000 lines or 50KB.",
          '- Use it to run code, process data, convert files and use command-line tools. To read, write or change a file, use `read`, `write` or `edit` instead of cat, echo or sed.',
          `- Commands time out after ${BASH_TIMEOUT} seconds unless you pass \`timeout\`, up to ${MAX_TIMEOUT}.`,
          '- Each call starts a new shell: environment variables and `cd` do not carry over.',
          '- Quote paths that contain spaces.',
        ].join('\n'),
        parameters: { ...bash.parameters, properties: { ...bash.parameters.properties, timeout: { type: 'number', description: `Timeout in seconds; default ${BASH_TIMEOUT}, at most ${MAX_TIMEOUT}` } } },
        execute: (args: BashToolInput, api, context) => bash.execute({ ...args, timeout: Math.min(args.timeout ?? BASH_TIMEOUT, MAX_TIMEOUT) }, api, context),
      },
    ],
    sections: [
      section('sandbox', () =>
        [
          "`bash` runs commands in the user's own Linux sandbox, in this conversation's workspace.",
          '- Installed: Python 3, Node, git, uv, rg and common command-line tools. The network is available. Install packages with `pip install --user`, `uv` or `npm`; there is no root, so no `apt install`.',
          '- Put files for the user in the workspace. Files in /tmp are only yours: you can read them (for example to check a generated image), the user cannot, and they are gone when the sandbox restarts.',
          '- Do not start servers or other processes that keep running.',
          '- The sandbox holds no keys or credentials. For anything that needs them, use the matching tool.',
        ].join('\n'),
      ),
    ],
  })
}

/** Said instead when this conversation cannot run commands, so the assistant explains it rather than pretends (R57). */
export const noSandbox = defineExtension({
  name: 'no-sandbox',
  sections: [section('sandbox', () => "You cannot run code or commands here: there is no `bash`. When the user asks you to run something, say that this deployment or their settings do not allow it, and give them the code to run themselves.")],
})

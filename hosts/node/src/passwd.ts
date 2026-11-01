// npm run passwd        sets the owner's password and signs out every session
// The password is read from the terminal without echo, or from stdin when piped. Safe while the server runs: SQLite
// waits for the server's write lock.
import { Auth } from '@gense/core'
import { createInterface } from 'node:readline/promises'
import { configFromEnv } from './config.ts'
import { openDatabase } from './server.ts'

async function readPassword() {
  if (!process.stdin.isTTY) {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    return text.split('\n')[0]!.trim()
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const write = rl as unknown as { _writeToOutput: (s: string) => void }
  let muted = false
  write._writeToOutput = (s: string) => void (muted ? s.includes('\n') && process.stdout.write('\n') : process.stdout.write(s))
  const ask = async (prompt: string) => {
    const answer = rl.question(prompt)
    muted = true
    const value = await answer
    muted = false
    return value
  }
  const first = await ask('新密码：')
  const second = await ask('再输一次：')
  rl.close()
  if (first !== second) throw new Error('两次输入不一致')
  return first
}

const db = await openDatabase(configFromEnv().dataDir)
try {
  const auth = await Auth.open(db)
  await auth.setPassword(await readPassword())
  console.log('密码已设置，已有的登录都已退出')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await db.close()
}

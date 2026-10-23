// npm run user:add -- <email>       creates a user, or resets the password of an existing one
// The password is read from the terminal without echo, or from stdin when piped.
import { createInterface } from 'node:readline/promises'
import { configFromEnv } from './config.ts'
import { openAuth } from './server.ts'

const email = process.argv[2]
if (!email) {
  console.error('用法：npm run user:add -- <email>')
  process.exit(2)
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    return text.split('\n')[0]!.trim()
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })
  let muted = false
  write._writeToOutput = (s: string) => void (muted ? s.includes('\n') && process.stdout.write('\n') : process.stdout.write(s))
  const ask = async (prompt: string) => {
    const answer = rl.question(prompt)
    muted = true
    const value = await answer
    muted = false
    return value
  }
  const first = await ask('密码：')
  const second = await ask('再输一次：')
  rl.close()
  if (first !== second) throw new Error('两次输入不一致')
  return first
}

const auth = await openAuth(configFromEnv().dataDir)
try {
  const password = await readPassword()
  const exists = (await auth.users()).some((u) => u.email === email.trim().toLowerCase())
  if (exists) {
    await auth.setPassword(email, password)
    console.log(`已重置 ${email} 的密码`)
  } else {
    const user = await auth.createUser(email, password)
    console.log(`已创建用户 ${user.email}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await auth.close()
}

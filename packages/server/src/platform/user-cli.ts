import { Auth } from './auth.ts'
import { configFromEnv } from './config.ts'
import { importOwner } from './import-owner.ts'
import { openDatabase } from './server.ts'

const [command, email] = process.argv.slice(2)
try {
  if (!email) throw new Error(`用法：npm run user:${command} <email>`)
  const config = configFromEnv()
  if (command === 'import-owner') {
    const user = await importOwner(config.dataDir, email)
    console.log(`已迁移到 ${user.email} (${user.id})；现在可启动服务器`)
  } else if (command === 'admin') {
    const db = await openDatabase(config.dataDir)
    try {
      const auth = await Auth.open(db), user = await auth.find(email)
      if (!user) throw new Error('邮箱未注册')
      await auth.updateUser(user.id, { role: 'admin', disabled: false })
      console.log(`已提升管理员：${user.email}`)
    } finally { await db.close() }
  } else throw new Error('命令无效')
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }

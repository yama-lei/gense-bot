import { configFromEnv } from './config.ts'
import { startServer } from './server.ts'

const server = await startServer(configFromEnv())
console.log(`gense listening on ${server.url}`)

let stopping = false
const stop = async () => {
  if (stopping) process.exit(1)
  stopping = true
  await server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

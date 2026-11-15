// A local wire service: the real HTTP client, SDK parser, adapter and SQLite harness process authored SSE.
import { createServer, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'

export async function deepseekPlatform(reply?: (body: Record<string, any>, response: ServerResponse, ordinal: number) => void | Promise<void>) {
  const requests: Record<string, any>[] = []
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      if (reply) await reply(body, res, requests.length)
      else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(await fixture('read-link')) }
    } catch (error) { res.writeHead(500).end(String(error)) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() }) }
}
export const fixture = (name: string) => readFile(new URL(`./fixtures/deepseek/${name}.sse`, import.meta.url), 'utf8')

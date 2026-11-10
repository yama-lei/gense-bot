// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).
import { BACKGROUND_CONTEXT,type Context } from '@earendil-works/chord/context'

import {
type WebhookInfo
} from '@gense/protocol'

import {
verifySignature,
WEBHOOK_MAX_BODY,
webhookContent
} from '../events/tasks.ts'

import { json } from '../platform/http.ts'

import { type WebhookRow } from './shared.ts'

import type { UserSpace } from './space.ts'
export async function webhooks(this: UserSpace): Promise<WebhookInfo[]> {
    if (!this.options.webhooks) return []
    return (await this.db.all<WebhookRow>('SELECT id, treeId, secret, createdAt, lastUsedAt FROM webhooks ORDER BY createdAt')).map(this.webhookInfo)
  }

export async function createWebhook(this: UserSpace, treeId: string): Promise<{ webhook: WebhookInfo; secret: string; }> {
    if (!this.options.webhooks) throw new Error('这个部署没有开启 Webhook')
    if (!this.sealer) throw new Error('服务器没有配置 TOKEN_ENCRYPTION_KEY，无法保存 Webhook 密钥')
    await this.row(treeId)
    const secret = `whsec_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')}`
    const row: WebhookRow = { id: crypto.randomUUID().replaceAll('-', ''), treeId, secret: await this.sealer.seal(secret), createdAt: this.now(), lastUsedAt: null }
    await this.db.run('DELETE FROM webhooks WHERE treeId = ?', treeId)
    await this.db.run('INSERT INTO webhooks (id, treeId, secret, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, NULL)', row.id, treeId, row.secret, row.createdAt)
    this.automationsChanged()
    return { webhook: this.webhookInfo(row), secret }
  }

export async function deleteWebhook(this: UserSpace, id: string): Promise<void> {
    await this.db.run('DELETE FROM webhooks WHERE id = ?', id)
    this.automationsChanged()
  }

export async function handleWebhook(this: UserSpace, hookId: string, request: Request, ctx: Context = BACKGROUND_CONTEXT): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: 'POST only' })
    const row = await this.db.get<WebhookRow>('SELECT id, treeId, secret, createdAt, lastUsedAt FROM webhooks WHERE id = ?', hookId)
    if (!row || !this.sealer) return json(404, { error: 'not found' })
    const body = await request.text()
    if (body.length > WEBHOOK_MAX_BODY) return json(413, { error: 'body too large' })
    const signature = request.headers.get('x-gense-signature')
    const valid = await verifySignature(await this.sealer.open(row.secret), request.headers.get('x-gense-timestamp'), signature, body, this.now())
    if (!valid) return json(401, { error: 'invalid signature' })
    const { title, body: text } = webhookContent(body, request.headers.get('content-type'))
    const event = await this.emit(
      row.treeId,
      { source: { kind: 'webhook', id: row.id, label: 'Webhook' }, type: 'webhook', title, body: text, wake: true },
      { key: `webhook:${row.id}:${request.headers.get('idempotency-key') ?? signature}` },
      ctx,
    )
    await this.db.run('UPDATE webhooks SET lastUsedAt = ? WHERE id = ?', this.now(), row.id)
    this.automationsChanged()
    return json(202, { eventId: event.id })
  }
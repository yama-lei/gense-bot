import { feishuHttp } from './http.ts'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import type { ChannelInfo, PluginValue } from '@gense/protocol'
import { Client, Domain, EventDispatcher, WSClient, type Logger } from '@larksuiteoapi/node-sdk'
import { createHash } from 'node:crypto'
import type { UserSpace } from '../../agent/space.ts'
import { MAX_UPLOAD, fromBase64, safeName } from '../../agent/workspace.ts'
import type { StoredTrigger } from '../../events/store.ts'
import type { Channel, ChannelDefinition, InboundTrigger, OutboxItem } from '../channel.ts'

export interface FeishuOptions { domain?: string; publicUrl?: string; streamMs?: number; handshakeMs?: number }
interface Message { message_id: string; chat_id: string; chat_type?: string; message_type?: string; content?: string; thread_id?: string; root_id?: string; parent_id?: string; mentions?: { key?: string; id?: { open_id?: string }; name?: string }[] }
interface Event { event_id?: string; message: Message; sender?: { sender_type?: string; sender_id?: { open_id?: string }; name?: string } }
const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const uuid = (id: string) => { const h = createHash('sha256').update(id).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}` }
const json = (text?: string): Record<string, unknown> => { try { const v = JSON.parse(text ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} } }
const crop = (text: string, max = 22_000) => { const bytes = Buffer.from(text); return bytes.length <= max ? text : new TextDecoder().decode(bytes.subarray(0,max)) + '\n\n（内容较长，完整内容见网页。）' }
function plain(content: string) {
  const data = json(content)
  if (typeof data.text === 'string') return data.text
  const parts: string[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const p of v) walk(p); return }
    if (!v || typeof v !== 'object') return
    const p = v as Record<string, unknown>
    if (typeof p.title === 'string') parts.push(p.title)
    if (typeof p.text === 'string') parts.push(p.text + (typeof p.href === 'string' ? ` (${p.href})` : ''))
    for (const [key, value] of Object.entries(p)) if (key === 'content' || ['zh_cn','en_us','ja_jp'].includes(key)) walk(value)
  }
  walk(data)
  return parts.join('\n')
}
interface CardState { messageId?: string; chain: Promise<unknown>; lastAt: number; latest: string; timer?: NodeJS.Timeout; finished: boolean }

export function feishuDefinition(space: UserSpace, options: FeishuOptions = {}): ChannelDefinition {
  return {
    id: 'feishu', name: '飞书', description: '飞书 / Lark 私聊和群聊 Bot，使用官方长连接。',
    settings: [
      { key: 'appId', label: 'App ID', kind: 'text', placeholder: 'cli_…' },
      { key: 'appSecret', label: 'App Secret', kind: 'secret' },
      { key: 'domain', label: '平台', kind: 'select', options: [{ value: 'feishu', label: '飞书' }, { value: 'lark', label: 'Lark' }], default: 'feishu' },
      { key: 'stream', label: '流式更新回答卡片', kind: 'toggle', default: true },
      { key: 'contextCount', label: '群聊上下文条数', kind: 'select', options: ['0','5','10','20'].map(v => ({ value: v, label: v })), default: '10' },
      { key: 'persona', label: 'Bot 人设', kind: 'textarea', default: '你在 IM 里回答问题。简短、直接，优先给出有用的结论；需要时再展开。' },
    ],
    create: (config, state) => new FeishuChannel(space, config, state, options),
  }
}

export class FeishuChannel implements Channel {
  #space: UserSpace
  #config: Record<string, PluginValue>
  #state: (patch: Partial<Pick<ChannelInfo, 'status' | 'error' | 'bot'>>) => void
  #options: FeishuOptions
  #client?: Client
  #ws?: WSClient
  #botId = ''
  #ingest?: (trigger: InboundTrigger) => Promise<unknown>
  #incoming: Promise<unknown> = Promise.resolve()
  #cards = new Map<string, CardState>()
  #closed = false
  constructor(space: UserSpace, config: Record<string, PluginValue>, state: (patch: Partial<Pick<ChannelInfo, 'status' | 'error' | 'bot'>>) => void, options: FeishuOptions) {
    this.#space = space; this.#config = config; this.#state = state; this.#options = options
  }
  async start(ingest: (trigger: InboundTrigger) => Promise<unknown>) {
    this.#ingest = ingest
    const appId = String(this.#config.appId ?? ''), appSecret = String(this.#config.appSecret ?? '')
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret) throw new Error('请填写有效的 App ID 和 App Secret')
    if (!this.#options.publicUrl || !/^https?:\/\//.test(this.#options.publicUrl)) throw new Error('请在服务器配置 PUBLIC_URL（网页公开地址）')
    const domain = this.#options.domain ?? (this.#config.domain === 'lark' ? Domain.Lark : Domain.Feishu)
    const base = { appId, appSecret, domain, logger: silent, httpInstance: feishuHttp() }
    this.#client = new Client(base)
    try {
      const response = await this.#client.request<{ code?: number; bot?: { open_id?: string; app_name?: string; avatar_url?: string } }>({ method: 'GET', url: '/open-apis/bot/v3/info', timeout: 10_000 })
      if (response.code || !response.bot?.open_id) throw new Error('bot identity missing')
      this.#botId = response.bot.open_id
      this.#state({ bot: { name: response.bot.app_name ?? 'Gense', ...(response.bot.avatar_url && { avatar: response.bot.avatar_url }) } })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.#ws?.close({ force: true }); reject(new Error('Feishu connection timed out')) }, this.#options.handshakeMs ?? 15_000)
        this.#ws = new WSClient({ ...base, handshakeTimeoutMs: this.#options.handshakeMs ?? 10_000, wsConfig: { pingTimeout: 15 },
          onReady: () => { clearTimeout(timer); this.#state({ status: 'ready', error: undefined }); resolve() },
          onError: () => { clearTimeout(timer); this.#state({ status: 'error', error: '飞书长连接失败，请检查凭据和网络' }); reject(new Error('Feishu connection failed')) },
          onReconnecting: () => this.#state({ status: 'connecting' }),
          onReconnected: () => this.#state({ status: 'ready', error: undefined }),
        })
        const dispatcher = new EventDispatcher({ logger: silent }).register({ 'im.message.receive_v1': async data => {
          const operation = this.#incoming.catch(() => {}).then(() => this.#receive(data as Event))
          this.#incoming = operation
          await operation
        } })
        void this.#ws.start({ eventDispatcher: dispatcher }).catch(error => { clearTimeout(timer); reject(error) })
      })
      for (const row of await this.#space.db.all<StoredTrigger>("SELECT * FROM triggers WHERE source = 'feishu' AND decision = 'command' AND result IS NULL ORDER BY created_at")) await this.#command(JSON.parse(row.payload), row)
    } catch { this.#ws?.close({ force: true }); throw new Error('无法连接飞书，请检查凭据、应用权限和网络') }
  }
  async #receive(event: Event) {
    if (this.#closed || !event.message || event.sender?.sender_type === 'app' || event.sender?.sender_type === 'bot') return
    const m = event.message, actorId = event.sender?.sender_id?.open_id
    if (!actorId || !m.message_id || !m.chat_id) return
    const id = event.event_id ?? m.message_id
    const existing = await this.#space.triggers.get(id)
    if (existing) { if (existing.decision === 'command' && !existing.result) await this.#command(JSON.parse(existing.payload), existing); return }
    const group = m.chat_type === 'group'
    const mentioned = m.mentions?.some(mention => mention.id?.open_id === this.#botId) ?? false
    let text = plain(m.content ?? '{}')
    for (const mention of m.mentions ?? []) if (mention.id?.open_id === this.#botId && mention.key) text = text.split(mention.key).join('')
    text = text.trim()
    const trigger: InboundTrigger = { id, source: 'feishu', thread: { key: group ? `${m.chat_id}:${m.thread_id || m.root_id || m.parent_id || m.message_id}` : m.chat_id, label: group ? `飞书群 ${m.chat_id}` : '飞书私聊', group }, actor: { id: actorId, name: event.sender?.name ?? actorId }, text, destination: { chatId: m.chat_id, messageId: m.message_id, group, ...(m.thread_id && { threadId: m.thread_id }) } }
    if (group && !mentioned) { await this.#space.triggers.admit(trigger, false, { reason: '群聊中未 @Bot' }); return }
    const pairCode = /^\/?pair\s+(\S+)$/i.exec(text)?.[1] ?? (/^[A-F0-9]{8}$/i.test(text) ? text : undefined)
    if (!group && pairCode && await this.#space.channels.consumePair('feishu', pairCode, trigger.actor, trigger)) {
      const admitted = await this.#space.triggers.admit(trigger, true, { command: 'pair' }, 'command')
      await this.#completeCommand(trigger, admitted.row, '已配对。现在可以直接发消息；/help 查看命令。')
      return
    }
    if (!this.#space.channels.isAllowed('feishu', actorId)) { await this.#space.triggers.admit(trigger, false); return }
    if (group) {
      const context: string[] = [], count = Number(this.#config.contextCount ?? '10')
      if (m.parent_id) {
        const reply = await this.#api(this.#client!.im.message.get({ path: { message_id: m.parent_id } }))
        const message = reply.data?.items?.[0]
        if (message) { context.push('被回复的消息：' + plain(message.body?.content ?? '{}')); if (!m.thread_id) trigger.thread.key = `${m.chat_id}:${message.root_id || message.message_id || m.parent_id}` }
      }
      if (m.thread_id && count > 0) {
        const history = await this.#api(this.#client!.im.message.list({ params: { container_id_type: 'thread', container_id: m.thread_id, page_size: count, sort_type: 'ByCreateTimeDesc' } }))
        for (const message of [...(history.data?.items ?? [])].reverse()) if (message.message_id !== m.message_id) context.push(`${message.sender?.id ?? '话题'}：${plain(message.body?.content ?? '{}')}`)
      }
      trigger.context = crop(context.join('\n'), 12_000)
    }
    if (/^\/(new|stop|model|help)(?:\s|$)/.test(text)) {
      const admitted = await this.#space.triggers.admit(trigger, true, { command: text }, 'command')
      await this.#command(trigger, admitted.row)
      return
    }
    trigger.attachments = await this.#attachments(m)
    if (!trigger.text && trigger.attachments.length) trigger.text = '请查看附件。'
    if (!trigger.text) trigger.text = `[${m.message_type ?? '消息'}]`
    return this.#ingest!(trigger)
  }
  async #attachments(m: Message) {
    const content = json(m.content), resources: { key: string; name: string; type: string }[] = []
    if (m.message_type === 'image' && typeof content.image_key === 'string') resources.push({ key: content.image_key, name: `image-${safeName(m.message_id)}.png`, type: 'image' })
    if (m.message_type === 'file' && typeof content.file_key === 'string') resources.push({ key: content.file_key, name: safeName(String(content.file_name ?? 'attachment')), type: 'file' })
    if (m.message_type === 'post') {
      const walk = (value: unknown): void => { if (Array.isArray(value)) { value.forEach(walk); return }; if (!value || typeof value !== 'object') return; const p = value as Record<string,unknown>; if (p.tag === 'img' && typeof p.image_key === 'string') resources.push({ key:p.image_key, name:`image-${resources.length}.png`, type:'image' }); Object.values(p).filter(v => v && typeof v === 'object').forEach(walk) }
      walk(content)
    }
    const ids: string[] = []
    for (const resource of resources) {
      const response = await this.#client!.im.messageResource.get({ path: { message_id: m.message_id, file_key: resource.key }, params: { type: resource.type } })
      const stream = response.getReadableStream(), chunks: Buffer[] = []; let total = 0
      try { for await (const chunk of stream) { const bytes = Buffer.from(chunk); total += bytes.length; if (total > MAX_UPLOAD) throw new Error('飞书附件超过 20 MB'); chunks.push(bytes) } } finally { stream.destroy() }
      const bytes = Buffer.concat(chunks)
      let name = resource.name
      if (resource.type === 'image') { const ext = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' : bytes.subarray(0,3).toString() === 'GIF' ? 'gif' : bytes.subarray(8,12).toString() === 'WEBP' ? 'webp' : 'png'; name = name.replace(/\.png$/, '.' + ext) }
      ids.push((await this.#space.workspace.upload(name, bytes)).id)
    }
    return ids
  }
  async #api<T extends { code?: number; msg?: string }>(request: Promise<T>): Promise<T> { const result = await request; if (result.code && result.code !== 0) throw new Error('Feishu API failed: ' + result.code); return result }
  async #newTree(trigger: InboundTrigger, row: StoredTrigger) {
    const treeId = row.tree_id ?? (await this.#space.createTree()).id
    await this.#space.triggers.bind(row.id, treeId)
    await this.#space.triggers.setThread('feishu', trigger.thread.key, treeId)
    await this.#space.db.run('UPDATE trees SET source = ? WHERE id = ?', JSON.stringify({ kind: 'feishu', label: trigger.thread.label }), treeId)
    const { branch } = await this.#space.branchRow(treeId)
    await (await this.#space.open(branch, ctx)).configure({ instructions: String(this.#config.persona ?? '') }, ctx)
    await this.#space.changed()
    return treeId
  }
  async #command(trigger: InboundTrigger, row: StoredTrigger) {
    if (row.result) return
    const [command, ...args] = trigger.text.split(/\s+/)
    let text = '', treeId = await this.#space.triggers.thread('feishu', trigger.thread.key)
    if (command === '/new') { treeId = await this.#newTree(trigger, row); text = '已开启新对话。' }
    else if (command === '/stop') { if (treeId) await this.#space.abort(treeId, (await this.#space.mainBranch(treeId)).id); text = '已停止。' }
    else if (command === '/model') {
      const models = await this.#space.accounts.list()
      if (args.length) {
        const requested = args.join(' '), model = models.find(m => m.id === requested || `${m.provider}/${m.id}` === requested)
        if (!model) text = '模型不可用。用 /model 查看可用模型。'
        else { treeId ??= await this.#newTree(trigger, row); const branch = await this.#space.mainBranch(treeId); await (await this.#space.open(branch,ctx)).configure({ model: { provider:model.provider, modelId:model.id } },ctx); text = `已切换到 ${model.provider}/${model.id}。` }
      } else {
        const model = treeId ? (await (await this.#space.open(await this.#space.mainBranch(treeId),ctx)).agent(ctx)).model : undefined
        const fallback = await this.#space.accounts.defaultModel()
        text = `当前：${model ? model.provider + '/' + model.modelId : fallback ? fallback.provider + '/' + fallback.id : '未配置'}\n可用模型：\n${models.map(m => `${m.provider}/${m.id}`).join('\n')}\n用 /model <模型> 切换。`
      }
    } else if (command === 'pair' || /^[A-F0-9]{8}$/i.test(command ?? '') || /^\/?pair$/i.test(command ?? '')) text = '已配对。现在可以直接发消息；/help 查看命令。'
    else text = '/new 开启新对话\n/stop 中止回答\n/model 查看模型\n/model <模型> 切换模型\n/help 查看帮助\n群聊中请 @Bot；同一话题共用对话。'
    await this.#completeCommand(trigger, row, text, treeId)
  }
  async #completeCommand(trigger: InboundTrigger, row: StoredTrigger, text: string, treeId?: string) {
    await this.#space.triggers.complete(row.id, { final: true, command: true, treeId }, [{ id: row.id + ':final', channelId: 'feishu', triggerId: row.id, treeId, kind: 'message', payload: { ...trigger.destination, text, ...(treeId && { treeId }) } }])
    void this.#space.outbox.drain()
  }
  #card(text: string, treeId?: string, progress = false) {
    const link = treeId ? `\n\n[在网页中打开](${new URL('/c/' + encodeURIComponent(treeId), this.#options.publicUrl!).href})` : ''
    return JSON.stringify({ config: { wide_screen_mode: true, update_multi: true }, header: { title: { tag: 'plain_text', content: progress ? 'Gense · 回答中' : 'Gense' } }, elements: [{ tag: 'markdown', content: crop(text) + link }] })
  }
  async #send(payload: Record<string, unknown>, msgType: string, content: string, id: string) {
    const data = { msg_type: msgType, content, uuid: uuid(id) }
    const response = payload.group && payload.messageId
      ? await this.#api(this.#client!.im.message.reply({ path: { message_id: String(payload.messageId) }, data: { ...data, reply_in_thread: true } }))
      : await this.#api(this.#client!.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: String(payload.chatId) } }))
    const messageId = response.data?.message_id
    if (!messageId) throw new Error('Feishu receipt missing')
    return messageId
  }
  #cardState(id: string) { let state = this.#cards.get(id); if (!state) { state = { chain:Promise.resolve(), lastAt:0, latest:'', finished:false }; this.#cards.set(id,state) }; return state }
  async render(triggerId: string, treeId: string, text: string) {
    if (this.#closed || this.#config.stream === false) return
    const state = this.#cardState(triggerId)
    if (state.finished) return
    state.latest = text
    const flush = () => {
      clearTimeout(state.timer)
      state.timer = undefined
      if (this.#closed || state.finished) return
      state.lastAt = Date.now()
      state.chain = state.chain.catch(() => {}).then(async () => {
        if (state.finished || this.#closed) return
        const row = await this.#space.triggers.get(triggerId); if (!row) return
        const payload = JSON.parse(row.payload) as InboundTrigger & { streamMessageId?: string }
        state.messageId ??= payload.streamMessageId
        const content = this.#card(state.latest, treeId, true)
        if (state.messageId) await this.#api(this.#client!.im.message.patch({ path: { message_id:state.messageId }, data:{ content } }))
        else {
          state.messageId = await this.#send(payload.destination ?? {}, 'interactive', content, triggerId + ':progress')
          // Keep ephemeral card identity so the durable final can update it after a restart.
          const current = await this.#space.triggers.get(triggerId)
          if (current) await this.#space.db.run('UPDATE triggers SET payload = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(current.payload), streamMessageId:state.messageId }),triggerId)
        }
      }).catch(() => {})
    }
    const remaining = (this.#options.streamMs ?? 1000) - (Date.now() - state.lastAt)
    if (remaining <= 0) flush()
    else if (!state.timer) { state.timer = setTimeout(flush,remaining); state.timer.unref() }
  }
  async deliver(item: OutboxItem): Promise<string> {
    if (!this.#client || this.#closed) throw new Error('飞书未连接')
    if (item.kind === 'file') {
      if (!item.treeId || typeof item.payload.path !== 'string') throw new Error('文件投递参数无效')
      const snapshot = item.payload.file as { name?: string; mimeType?: string; base64?: string } | undefined
      const file = snapshot && typeof snapshot.name === 'string' && typeof snapshot.mimeType === 'string' && typeof snapshot.base64 === 'string' ? { name: snapshot.name, mimeType: snapshot.mimeType, base64: snapshot.base64 } : await this.#space.workspace.read(item.treeId,item.payload.path)
      const bytes = Buffer.from(fromBase64(file.base64))
      if (bytes.length > 30*1024*1024 || !bytes.length) return this.#send(item.payload, 'interactive', this.#card(`文件 ${file.name} 无法作为飞书附件发送，请在网页中下载。`, item.treeId), item.id)
      const image = file.mimeType.startsWith('image/') && bytes.length <= 10*1024*1024 && !['image/svg+xml'].includes(file.mimeType)
      const resource = image ? await this.#client.im.image.create({ data:{ image_type:'message', image:bytes } }) : await this.#client.im.file.create({ data:{ file_type:'stream', file_name:file.name, file:bytes } })
      const key = image ? (resource as {image_key?:string})?.image_key : (resource as {file_key?:string})?.file_key
      if (!key) throw new Error('飞书文件上传失败')
      return this.#send(item.payload,image?'image':'file',JSON.stringify(image?{image_key:key}:{file_key:key}),item.id)
    }
    const state = this.#cardState(item.triggerId); state.finished = true; clearTimeout(state.timer); await state.chain
    const row = await this.#space.triggers.get(item.triggerId)
    state.messageId ??= row ? JSON.parse(row.payload).streamMessageId : undefined
    let text = String(item.payload.text ?? '')
    const entries = item.payload.entries as {model?:{content?:{type:string;name?:string}[]}[]}[] | undefined
    const richNames = new Set(this.#space.plugins.list().flatMap(p => p.tools.filter(t => t.resourceUri && t.name !== 'image_generate').map(t => t.name)))
    const rich = entries?.flatMap(e => e.model ?? []).flatMap(m => m.content ?? []).filter(c => c.type === 'toolCall' && c.name && richNames.has(c.name))
    if (rich?.length) text += '\n\n已生成界面或产物，完整交互内容请在网页中打开。'
    const content = this.#card(text,item.treeId)
    if (state.messageId) { await this.#api(this.#client.im.message.patch({ path:{message_id:state.messageId}, data:{content} })); return state.messageId }
    state.messageId = await this.#send(item.payload,'interactive',content,item.id)
    return state.messageId
  }
  async stop() {
    this.#closed = true; this.#ws?.close({ force:true })
    for (const state of this.#cards.values()) clearTimeout(state.timer)
    await this.#incoming.catch(() => {})
    await Promise.allSettled([...this.#cards.values()].map(s=>s.chain))
  }
}

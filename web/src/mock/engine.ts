// Scripted stand-in for the backend: turns a user message into status changes,
// tool calls (executed by the real plugin tools) and streamed text. No model is called.
import type { AppState, Citation, DriveFile, Turn } from '../types'

export interface Step {
  name: string
  input: unknown
  durationMs: number
}

export interface Script {
  summary: string
  steps: Step[]
  text: string
  citations: Citation[]
  error?: string
  /** Shorter delays, for scripts with many steps. */
  fast?: boolean
}

const MAX_STEPS = 20

/** Lines worth quoting: body text without list markers, so each quote is a verbatim substring. */
function excerpts(file: DriveFile, n: number): Citation[] {
  return (file.content ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/^(\d+\.|-)\s*/, ''))
    .filter((l) => l.length > 6 && !l.startsWith('#') && !l.endsWith('：'))
    .slice(0, n)
    .map((quote) => ({ fileId: file.id, name: file.name, quote }))
}

const unavailable = (what: string): Script => ({
  summary: '所需能力未开启，没有调用工具',
  steps: [],
  text: `「${what}」插件目前已在“定制”页关闭，我不能执行这一步，也没有调用任何工具。需要的话请先开启它再试一次。`,
  citations: [],
})

export function planReply(turn: Turn, state: AppState): Script {
  const { userMessage: message, attachments = [], command, mentions = [] } = turn
  const enabled = (id: string) => state.plugins.some((p) => p.id === id && p.enabled && p.available)

  const skill = command?.id.startsWith('skill:') ? command.label : null
  if (skill) {
    return {
      summary: `使用 Skill：${skill}`,
      steps: [{ name: 'skill_activate', input: { name: skill }, durationMs: 120 }],
      text: `我按 Skill **${skill}** 的说明处理了你的请求：\n\n> ${message}\n\n（Mock 演示：真实环境中助手会先读取 Skill 的完整说明，再按步骤完成任务。）`,
      citations: [],
    }
  }
  if (command?.id === 'summarize') {
    const conv = state.conversations.find((c) => c.turns.some((t) => t.id === turn.id))
    const earlier = conv?.turns.filter((t) => t.id !== turn.id && t.userMessage) ?? []
    return {
      summary: '总结会话，没有调用工具',
      steps: [],
      text: earlier.length ? `本会话要点：\n\n${earlier.map((t) => `- ${t.userMessage.replace(/\s+/g, ' ').slice(0, 40)}`).join('\n')}\n\n（Mock 演示）` : '这个会话还没有可以总结的内容。（Mock 演示）',
      citations: [],
    }
  }
  const chats = mentions.filter((m) => m.kind === 'chat')
  if (chats.length) {
    return {
      summary: `读取 ${chats.length} 个会话`,
      steps: chats.map((c) => ({ name: 'chats_read', input: { id: c.id }, durationMs: 150 })),
      text: `我读了你提到的会话：${chats.map((c) => `「${c.label}」`).join('、')}，会结合其中的内容回答。（Mock 演示）`,
      citations: [],
    }
  }

  if (attachments.length) {
    return {
      summary: `读取 ${attachments.length} 个附件`,
      steps: attachments.map((a) => ({ name: 'files_read', input: { fileId: a.id }, durationMs: 260 })),
      text: `我读了你附上的文件：\n\n${attachments.map((a) => `- **${a.name}**`).join('\n')}\n\n文件已保存在 \`GenseBot/资料/\`，之后的对话里也可以继续引用。（Mock 演示，没有真正解析文件内容）`,
      citations: [],
    }
  }
  const sources = state.files.filter((f) => f.kind === 'source')
  const mentioned = sources.find((f) => message.includes(f.name.replace(/\.\w+$/, '')))

  if (/端点|失败|错误/.test(message)) {
    return {
      summary: '调用模型',
      steps: [],
      text: '',
      citations: [],
      error: '模型端点返回 529 Overloaded，已重试 3 次后停止。可以稍后重试，或在下方切换到另一个模型。（Mock 演示）',
    }
  }

  if (/步数|循环/.test(message)) {
    return {
      summary: '反复搜索资料',
      steps: Array.from({ length: MAX_STEPS }, (_, i) => ({ name: 'files_search', input: { query: `第 ${i + 1} 次` }, durationMs: 20 })),
      text: '',
      citations: [],
      error: `已达到单轮步数上限（${MAX_STEPS}），本轮停止，已有内容保留。可以把问题拆小后重新提交。`,
      fast: true,
    }
  }

  if (mentions.some((m) => m.id === 'ui') || /图表|表格|对比|比较|可视化|趋势/.test(message)) {
    if (!enabled('ui')) return unavailable('界面')
    const phone = (title: string, subtitle: string, price: string, tags: string[], note: string) => ({
      type: 'card' as const,
      title,
      subtitle,
      blocks: [{ type: 'stat' as const, label: '起售价', value: price }, { type: 'badges' as const, items: tags }, { type: 'text' as const, text: note }],
    })
    return {
      summary: '整理成卡片和图表',
      steps: [
        {
          name: 'ui_render',
          input: {
            title: '三款手机对比',
            blocks: [
              {
                type: 'grid',
                columns: 3,
                cards: [
                  phone('Pixel 10', 'Google', '¥5,299', ['影像', '原生系统'], '拍照稳定，系统更新最久。'),
                  phone('iPhone 17', 'Apple', '¥5,999', ['生态', '视频'], '视频和生态最好，充电偏慢。'),
                  phone('小米 16', 'Xiaomi', '¥4,299', ['续航', '快充'], '续航和快充领先，价格最低。'),
                ],
              },
              { type: 'chart', kind: 'bar', title: '续航测试（小时）', labels: ['Pixel 10', 'iPhone 17', '小米 16'], series: [{ name: '视频播放', values: [21, 24, 27] }, { name: '游戏', values: [7.5, 8, 9.5] }], unit: '小时' },
              { type: 'chart', kind: 'line', title: '近 6 个月价格（元）', labels: ['5月', '6月', '7月', '8月', '9月', '10月'], series: [{ name: 'Pixel 10', values: [5999, 5799, 5699, 5499, 5399, 5299] }, { name: 'iPhone 17', values: [6299, 6299, 6199, 6099, 5999, 5999] }, { name: '小米 16', values: [4599, 4599, 4499, 4399, 4299, 4299] }], unit: '元' },
              { type: 'chart', kind: 'pie', title: '评测关注点', labels: ['影像', '续航', '性能', '系统', '价格'], series: [{ name: '占比', values: [34, 26, 18, 12, 10] }], unit: '%' },
              { type: 'table', columns: ['', '屏幕', '重量', '快充'], rows: [['Pixel 10', '6.3 英寸', '204 g', '30 W'], ['iPhone 17', '6.3 英寸', '177 g', '40 W'], ['小米 16', '6.4 英寸', '191 g', '90 W']] },
              { type: 'callout', tone: 'info', text: '价格为 Mock 数据，仅用于演示。' },
              { type: 'buttons', items: [{ label: '更看重拍照', message: '我更看重拍照，该选哪款？' }, { label: '更看重续航', message: '我更看重续航，该选哪款？' }, { label: '预算 4000 以内', message: '预算 4000 以内有什么推荐？' }] },
            ],
          },
          durationMs: 300,
        },
      ],
      text: '如果预算有限、重视续航，小米 16 最合适；重视拍照和系统更新选 Pixel 10。点下面的按钮告诉我你更看重什么。',
      citations: [],
    }
  }

  if (/邮件|email/i.test(message)) {
    if (!enabled('email')) return unavailable('邮件')
    return {
      summary: '起草邮件，等待你检查',
      steps: [
        {
          name: 'email_draft',
          input: {
            to: 'grad-office@example.edu.cn',
            subject: '咨询：' + message.replace(/\s+/g, ' ').slice(0, 20),
            body: `王老师您好：\n\n${message}\n\n谢谢老师！\nRayama`,
          },
          durationMs: 420,
        },
      ],
      text: '草稿已经准备好，请核对收件人和正文。点“存入草稿箱”后，它会出现在 smail 的草稿箱里，由你在邮箱 App 中发送；助手不会替你发信。',
      citations: [],
    }
  }

  if (command?.id === 'research' || command?.id === 'fetch' || mentions.some((m) => m.id === 'web') || /搜索|最新|网页|网上|https?:\/\//.test(message)) {
    if (!enabled('web')) return unavailable('网页')
    return {
      summary: '搜索网页，读取 1 个页面',
      steps: [
        { name: 'web_search', input: { query: message.replace(/\s+/g, ' ').slice(0, 40) }, durationMs: 380 },
        { name: 'web_fetch', input: { url: 'https://blog.cloudflare.com/project-think/' }, durationMs: 520 },
      ],
      text: `我先搜索了网页，又打开了最相关的一篇读正文：\n\n- **Think** 是构建在 Agents SDK 之上的智能体运行时，负责消息树、断线恢复和 Skills（[Cloudflare 博客](https://blog.cloudflare.com/project-think/)）。\n- **Agents SDK** 把每个智能体放在一个 Durable Object 里，自带持久化和调度（[官方文档](https://developers.cloudflare.com/agents/)）。\n\n下方“来源”列出了本轮用到的全部网页。（Mock 演示，结果是固定的）`,
      citations: [],
    }
  }

  const wantsFile = mentioned || /资料|文档|通知|周报|提纲|整理/.test(message)
  if (wantsFile && !state.account.driveConnected) {
    return {
      summary: '读取资料',
      steps: [],
      text: '',
      citations: [],
      error: 'Google Drive 未连接，无法读取资料。请先在“资料”页或“定制”页连接 Google Drive。',
    }
  }

  if (wantsFile && /提纲|整理成|保存|汇报/.test(message)) {
    const file = mentioned ?? sources.find((f) => f.name.includes('周报')) ?? sources[0]
    const cites = excerpts(file, 4)
    if (!enabled('artifact')) return unavailable('Artifact')
    return {
      summary: `读取 ${file.name}，生成提纲`,
      steps: [
        { name: 'files_read', input: { fileId: file.id }, durationMs: 160 },
        {
          name: 'artifact_create',
          input: {
            title: `${file.name.replace(/\.\w+$/, '')} 提纲`,
            type: 'markdown',
            content: `# ${file.name.replace(/\.\w+$/, '')} 提纲\n\n${cites.map((c, i) => `${i + 1}. ${c.quote}`).join('\n')}\n\n## 待讨论\n\n- （在这里补充需要导师决定的问题）\n`,
          },
          durationMs: 300,
        },
      ],
      text: `我读了 **${file.name}**，整理成了提纲，点开卡片可以预览。确认没问题后点“保存到 Drive”，它会存到 \`GenseBot/Artifacts/\`，原文不会被改动。`,
      citations: cites.slice(0, 2),
    }
  }

  if (wantsFile) {
    const file = mentioned ?? sources[0]
    const cites = excerpts(file, 3)
    return {
      summary: `读取 ${file.name} 并整理要点`,
      steps: [
        { name: 'files_search', input: { query: file.name.replace(/\.\w+$/, '') }, durationMs: 90 },
        { name: 'files_read', input: { fileId: file.id }, durationMs: 140 },
      ],
      text: `我读取了 **${file.name}**，摘出几条要点：\n\n${cites.map((c) => `- ${c.quote}`).join('\n')}\n\n下方引用显示原文摘录，点击可以打开文件并定位。需要的话我可以把整理结果另存为 Artifact。`,
      citations: cites,
    }
  }

  return {
    summary: '直接回答，没有调用工具',
    steps: [],
    text: `这是 **Mock 前端**生成的示例回复，没有调用任何模型。

你刚才说的是：

> ${message.split('\n').join('\n> ')}

可以试试这些说法，查看不同的界面状态：

- 「读一下奖学金通知」：工具调用与原文摘录引用
- 「把周报整理成组会汇报提纲」：Artifact 卡片与侧边面板
- 「帮我给王老师写封邮件」：邮件草稿插件界面
- 「模拟模型端点错误」「模拟步数循环」：失败与兜底限制

\`\`\`ts
// 接入后端后，这里会是 Think 驱动的真实回复
agent.sendMessage({ id: requestId, text })
\`\`\``,
    citations: [],
  }
}

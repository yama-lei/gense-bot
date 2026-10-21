// Scripted stand-in for the backend: turns a user message into status changes,
// tool calls (executed by the real plugin tools) and streamed text. No model is called.
import type { AppState, Citation, DriveFile } from '../types'

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
  return file.content
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

export function planReply(message: string, state: AppState): Script {
  const enabled = (id: string) => state.plugins.some((p) => p.id === id && p.enabled && p.available)
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

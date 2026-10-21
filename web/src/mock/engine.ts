// Scripted stand-in for the backend: turns a user message into a sequence of
// status changes, tool calls and streamed text. No model is called.
import type { Citation, Confirmation, Doc, ToolCall } from '../types'

export interface Script {
  summary: string
  tools: Omit<ToolCall, 'status'>[]
  text: string
  citations: Citation[]
  confirmation?: Confirmation
  error?: string
}

export function planReply(message: string, docs: Doc[]): Script {
  const mentioned = docs.find((d) => message.includes(d.path) || message.includes(d.path.split('/').pop()!.replace(/\.md$/, '')))

  if (/失败|额度|quota/i.test(message)) {
    return {
      summary: '尝试调用模型',
      tools: [],
      text: '',
      citations: [],
      error: '今日免费模型额度已用完，任务已停止，没有自动切换到付费模型。额度恢复后可以重试。（Mock 演示）',
    }
  }

  if (/邮件|email/i.test(message)) {
    return {
      summary: '起草邮件，等待你确认',
      tools: [{ id: uid(), name: 'email.draft', args: '{ "to": "someone@example.edu.cn" }', output: '已生成草稿（未发送）', durationMs: 640 }],
      text: '草稿已经准备好。确认前请核对收件人和正文；修改后需要重新确认。',
      citations: [],
      confirmation: {
        kind: 'email',
        fields: [
          { label: '收件人', value: 'someone@example.edu.cn' },
          { label: '主题', value: '关于：' + message.slice(0, 20) },
          { label: '正文', value: `您好：\n\n${message}\n\n谢谢！\nRayama` },
        ],
        consequence: '确认后将以你的邮箱发送这封邮件，发送后无法撤回。（Mock：不会真正发送）',
        state: 'pending',
      },
    }
  }

  if (mentioned || /资料|文档|通知|周报/.test(message)) {
    const doc = mentioned ?? docs[0]
    const lines = doc.content.split('\n')
    const picked = lines
      .map((text, i) => ({ text: text.trim(), line: i + 1 }))
      .filter((l) => l.text && !l.text.startsWith('#') && !l.text.endsWith('：'))
      .slice(0, 3)
    return {
      summary: `读取 ${doc.path} 并整理要点`,
      tools: [
        { id: uid(), name: 'workspace.list', args: '{ "dir": "/" }', output: `${docs.length} 个文件`, durationMs: 18 },
        { id: uid(), name: 'workspace.read', args: `{ "path": "${doc.path}" }`, output: `读取 ${lines.length} 行`, durationMs: 35 },
      ],
      text: `我读取了 \`${doc.path}\`，摘出前几条要点：\n\n${picked.map((l) => `- ${l.text.replace(/^[-\d.]+\s*/, '')}`).join('\n')}\n\n点击下方引用可以跳到原文对应的行。需要我把整理结果另存为新文档吗？原文不会被覆盖。`,
      citations: picked.map((l) => ({ path: doc.path, line: l.line })),
    }
  }

  return {
    summary: '直接回答，没有调用工具',
    tools: [],
    text: `这是 **Mock 前端**生成的示例回复，没有调用任何模型。

你刚才说的是：

> ${message.split('\n').join('\n> ')}

可以试试这些说法，查看不同的界面状态：

- 「读一下奖学金通知」：工具调用与原文引用
- 「帮我写封邮件给王老师」：发送前的确认卡片
- 「模拟额度失败」：失败状态与重试

\`\`\`ts
// 接入后端后，这里会是 Pi Durable 驱动的真实回复
const reply = await assistant.submit({ requestId, message })
\`\`\``,
    citations: [],
  }
}

export function uid() {
  return Math.random().toString(36).slice(2, 10)
}

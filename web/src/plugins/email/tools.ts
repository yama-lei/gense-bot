import { uid } from '../../util'
import type { PluginTool } from '../types'

export interface DraftInput {
  to: string
  subject: string
  body: string
}

export const emailTools: PluginTool[] = [
  {
    name: 'email_draft',
    plugin: 'email',
    description: '展示一封邮件草稿供用户检查和修改（显示工具）',
    resourceUri: 'ui://email/draft',
    sideEffect: false,
    execute: (input: DraftInput) => ({ content: `已生成给 ${input.to} 的草稿，等待用户检查`, structuredContent: input }),
  },
  {
    name: 'email_saveDraft',
    plugin: 'email',
    description: '把草稿写入 smail 草稿箱（IMAP APPEND），不发送',
    sideEffect: true,
    execute: (input: DraftInput) => ({ content: `已存入草稿箱：${input.subject}`, structuredContent: { draftId: 'd-' + uid() } }),
  },
]

import { definePlugin } from '../../registry.ts'
import { emailExtension } from '../../display.ts'

export default definePlugin({
...{
  "id": "email",
  "name": "邮件",
  "description": "起草邮件，由你检查后复制或在邮箱 App 中发送。",
  "sideEffect": false,
  "settings": []
},
issue: () => null,
extension: emailExtension,
resources: { email_draft: 'ui://email/draft' }
})

// Plugins whose tools mostly show something (R33): Artifact, email drafts and generative UI. The input is what the
// view renders, so each tool returns it as `details`.
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env'
import { Type, type Static } from 'typebox'
import type { PluginValue } from '../catalog.ts'
import { safeName } from '../workspace.ts'
import { uiInput } from './ui-schema.ts'

export const artifactInput = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120, description: '产物标题，也用作保存时的文件名' }),
  type: Type.Union([Type.Literal('markdown'), Type.Literal('code')]),
  language: Type.Optional(Type.String({ maxLength: 32, description: 'type 为 code 时的语言，例如 python' })),
  content: Type.String({ description: '完整内容' }),
})
export type ArtifactInput = Static<typeof artifactInput>

const EXT: Record<string, string> = { python: 'py', javascript: 'js', typescript: 'ts', shell: 'sh', bash: 'sh', markdown: 'md', yaml: 'yml', rust: 'rs', golang: 'go' }

/**
 * Saves an artifact as `artifacts/<title>.<ext>` in the env's cwd. An existing file with the same content is reused,
 * so a retried save does not make a copy; a different one gets a new name.
 */
export async function saveArtifact(env: ExecutionEnv, input: ArtifactInput, ctx: Context = BACKGROUND_CONTEXT) {
  const lang = (input.language ?? '').toLowerCase()
  const ext = input.type === 'code' ? (EXT[lang] ?? (/^[a-z0-9]{1,8}$/.test(lang) ? lang : 'txt')) : 'md'
  const base = safeName(input.title).replace(/\.[a-z0-9]{1,8}$/i, '') || 'artifact'
  for (let n = 1; n < 100; n++) {
    const path = getOrThrow(await env.absolutePath(`artifacts/${base}${n > 1 ? ` (${n})` : ''}.${ext}`, ctx))
    const existing = await env.readTextFile(path, ctx)
    if (existing.ok && existing.value !== input.content) continue
    if (!existing.ok) getOrThrow(await env.writeFile(path, input.content, ctx))
    return path
  }
  throw new Error('同名文件太多，请换个标题')
}

export function artifactExtension() {
  return defineExtension({
    name: 'artifact',
    tools: [
      defineTool({
        name: 'artifact_create',
        description: '在会话中展示一个产物（提纲、报告、代码等），用户可以在侧边面板预览、复制并保存到工作区。只用于展示，不会保存。',
        parameters: artifactInput,
        replay: 'safe',
        async execute(input) {
          return { output: [{ type: 'text', text: `已展示 Artifact「${input.title}」（未保存）` }], details: input }
        },
      }),
      defineTool({
        name: 'artifact_save',
        description: '把产物保存到工作区的 artifacts/ 下。不会覆盖已有的不同文件。只在用户要求保存时调用。',
        parameters: artifactInput,
        replay: 'safe',
        async execute(input, api, context) {
          if (!api.env) throw new Error('没有工作区，不能保存')
          const path = await saveArtifact(api.env, input, context)
          return { output: [{ type: 'text', text: `已保存到 ${path}` }], details: { path } }
        },
      }),
    ],
  })
}

export const draftInput = Type.Object({
  to: Type.String({ maxLength: 500, description: '收件人地址，多个用逗号分隔' }),
  subject: Type.String({ maxLength: 300 }),
  body: Type.String({ maxLength: 20_000, description: '纯文本正文' }),
})

export function emailExtension() {
  return defineExtension({
    name: 'email',
    tools: [
      defineTool({
        name: 'email_draft',
        description: '展示一封邮件草稿，用户可以修改、复制，或在邮箱 App 中打开后自己发送。不会发送邮件。',
        parameters: draftInput,
        replay: 'safe',
        async execute(input) {
          return { output: [{ type: 'text', text: `已生成给 ${input.to} 的草稿，等待用户检查后自己发送` }], details: input }
        },
      }),
    ],
  })
}

export function uiExtension(config: () => Record<string, PluginValue>) {
  return defineExtension({
    name: 'ui',
    tools: [
      defineTool({
        name: 'ui_render',
        description:
          '在回答中插入一块界面：卡片、网格、统计数字、表格、图表（柱状/折线/饼图）、提示框和按钮。适合对比多个选项、展示数据和趋势、给出可点选的下一步；简单问答不要用。按钮被点击时，它的 message 会作为用户消息发出。界面已经展示的内容不要在文字里再重复一遍。',
        parameters: uiInput,
        replay: 'safe',
        async execute(input) {
          const text = `已在界面中显示${input.title ? `「${input.title}」` : '内容'}，用户能看到；不要在文字里重复其中的数据，只补充结论或说明。`
          return { output: [{ type: 'text', text }], details: input }
        },
      }),
    ],
    sections: [
      section('ui', () =>
        config().usage === 'often' ? '用户希望多用界面：只要回答里有可以结构化的内容（要点、步骤、对比、数据），就用 ui_render 展示。' : '',
      ),
    ],
  })
}

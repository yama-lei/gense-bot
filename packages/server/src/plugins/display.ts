// Plugins whose tools mostly show something (R33): Artifact, email drafts and generative UI. The input is what the
// view renders, so each tool returns it as `details`.
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env'
import { Type, type Static } from 'typebox'
import type { PluginValue } from './catalog.ts'
import { safeName } from '../agent/workspace.ts'
import { createParser } from '@openuidev/lang-core'
import { UI_PROMPT, UI_ROOT, UI_SCHEMA, UI_SIGNATURES } from './genui/generated.ts'

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

export const uiInput = Type.Object({
  program: Type.String({ minLength: 1, maxLength: 60_000, description: 'openui-lang 程序，第一行是 root = Col(...)' }),
})
export type UiInput = Static<typeof uiInput>

let parser: ReturnType<typeof createParser> | undefined

/** What is wrong with a program, one line each, for the model to fix (docs/plans/openui.md R71); empty when it renders. */
export function checkProgram(program: string) {
  parser ??= createParser(UI_SCHEMA as never, UI_ROOT)
  const result = parser.parse(program)
  const problems = result.meta.errors.filter((e) => e.severity !== 'warning').map((e) => `${e.statementId ? `${e.statementId}: ` : ''}${e.message}`)
  for (const name of result.meta.unresolved) problems.push(`${name}: 引用了但没有定义`)
  if (!result.root && !problems.length) problems.push(`没有根节点：第一行要写 root = ${UI_ROOT}(...)`)
  // Type errors name the field but not the call's shape; the signature saves the model a guess.
  const wrong = new Set(result.meta.errors.filter((e) => e.severity !== 'warning' && !e.message.includes('signature:')).map((e) => e.component))
  for (const name of wrong) if (UI_SIGNATURES[name]) problems.push(`${name} 的签名：${UI_SIGNATURES[name]}`)
  return { problems, orphaned: result.meta.orphaned }
}

export function uiExtension(config: () => Record<string, PluginValue>) {
  return defineExtension({
    name: 'ui',
    tools: [
      defineTool({
        name: 'ui_render',
        description: '在回答中显示一个用 openui-lang 写的交互页面。写法见系统提示中的 openui-lang 说明。',
        parameters: uiInput,
        replay: 'safe',
        async execute(input) {
          const { problems, orphaned } = checkProgram(input.program)
          if (problems.length) throw new Error(`程序有错误，没有显示。改正后重新调用 ui_render：\n${problems.map((p) => `- ${p}`).join('\n')}`)
          const unused = orphaned.length ? `（${orphaned.join('、')} 没有从 root 引用到，没有显示）` : ''
          return { output: [{ type: 'text', text: `已显示页面${unused}，用户能看到并操作；不要在文字里重复其中的内容。` }], details: { shown: true } }
        },
      }),
    ],
    sections: [
      section('ui', () =>
        [UI_PROMPT, config().usage === 'often' ? '\n用户希望多用界面：只要回答里有可以结构化或交互的内容（步骤、对比、数据、地点、选择），就用 ui_render。' : ''].join(''),
      ),
    ],
  })
}

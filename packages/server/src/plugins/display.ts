// Plugins whose tools mostly show something (R33): Artifact, email drafts and generative UI. The input is what the
// view renders, so each tool returns it as `details`.
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env'
import { Type, type Static } from 'typebox'
import type { PluginValue } from './catalog.ts'
import { safeName, SKILLS_DIR } from '../agent/workspace.ts'
import { createParser } from '@openuidev/lang-core'
import { UI_ROOT, UI_SCHEMA, UI_SIGNATURES } from './genui/generated.ts'

/** The generative UI's own Skill (roadmap-6 A4): the language and practices the model reads before its first page. */
export const UI_SKILL = `${SKILLS_DIR}/generative-ui`

/** All the system prompt says about pages; the rest is in the Skill, read on first use (A5). */
export const UI_PROMPT = [
  'The user reads your answers in an app that can also render interactive pages. `ui_render` puts one inside your answer: charts, forms, calculators, small tools.',
  '- Answer in Markdown by default: text, lists and tables, plus images and PDF pages from the workspace embedded as the files section says. Use ui_render only when the user asks for a page, for a chart of real numbers, for a form whose answers come back to you, or for a small tool the user will operate (a calculator, a converter, a checklist).',
  '- Do not use it for comparisons, steps or options a table or list shows as well, nor for simple questions, general knowledge or anything about safety.',
  `- Before your first ui_render call in a conversation, read ${UI_SKILL}/SKILL.md and the references it lists, and write programs the way they show.`,
].join('\n')

export const artifactInput = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120, description: 'Title, also the file name when it is saved' }),
  type: Type.Union([Type.Literal('markdown'), Type.Literal('code')], { description: '`markdown` for a document, `code` for source code' }),
  language: Type.Optional(Type.String({ maxLength: 32, description: 'The language when type is code, e.g. python' })),
  content: Type.String({ description: 'The complete content; never placeholders such as "rest unchanged"' }),
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
        description: [
          'Show a document or a piece of code in a side panel, where the user can preview it, copy it and save it to the workspace.',
          '- Use it for content the user will take away and reuse as a whole, such as a report, an outline, a letter or a script, roughly 20 lines or more. Shorter content belongs in your reply.',
          '- It only shows the content. To save a file yourself, use `write`; for interactive content, use `ui_render`.',
          '- Do not repeat the content in your reply; a sentence about what it is and what to check is enough.',
        ].join('\n'),
        parameters: artifactInput,
        replay: 'safe',
        async execute(input) {
          return { output: [{ type: 'text', text: `已展示 Artifact「${input.title}」（未保存）` }], details: input }
        },
      }),
      defineTool({
        name: 'artifact_save',
        description: 'Save an artifact under `artifacts/` in the workspace. It never overwrites a different existing file. Call it only when the user asks to save.',
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
  to: Type.String({ maxLength: 500, description: 'Recipient addresses, comma-separated; empty when you do not know them' }),
  subject: Type.String({ maxLength: 300, description: 'Subject line' }),
  body: Type.String({ maxLength: 20_000, description: 'The body in plain text, not Markdown' }),
})

export function emailExtension() {
  return defineExtension({
    name: 'email',
    tools: [
      defineTool({
        name: 'email_draft',
        description: [
          'Show an email draft that the user can edit, copy, or open in their mail app and send themselves. Nothing is sent.',
          '- Leave `to` empty when you do not know the address; never guess one.',
          '- Write in the language and register the recipient expects.',
          '- Do not repeat the draft in your reply.',
        ].join('\n'),
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
  program: Type.String({ minLength: 1, maxLength: 60_000, description: 'The openui-lang program. The first line is `root = Col(...)`, and every name it uses must be defined' }),
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
        description: [
          'Show an interactive page, written as an openui-lang program, inside your answer.',
          `- Read ${UI_SKILL}/SKILL.md and its references before your first call; they list the components and how to lay out a good page.`,
          '- If the program has errors, nothing is shown and the result lists them. Fix them and call again; do not tell the user about the errors.',
        ].join('\n'),
        parameters: uiInput,
        replay: 'safe',
        async execute(input) {
          const { problems, orphaned } = checkProgram(input.program)
          if (problems.length) throw new Error(`程序有错误，没有显示。改正后重新调用 ui_render：\n${problems.map((p) => `- ${p}`).join('\n')}\n组件签名和语法见 ${UI_SKILL}/references/language.md，没读过就先读。`)
          const unused = orphaned.length ? `（${orphaned.join('、')} 没有从 root 引用到，没有显示）` : ''
          return { output: [{ type: 'text', text: `已显示页面${unused}，用户能看到并操作；不要在文字里重复其中的内容。` }], details: { shown: true } }
        },
      }),
    ],
    sections: [
      section('ui', () =>
        [UI_PROMPT, config().usage === 'often' ? '\n- The user wants pages more often: use ui_render whenever part of the answer can be structured or interacted with.' : ''].join(''),
      ),
    ],
  })
}

// Built-in Agent Skills (roadmap-2 "L2 Skills"). Drive skills use the same SKILL.md format:
// YAML front matter with `name` and `description`, then the instructions.

export interface SkillDoc {
  name: string
  description: string
  body: string
}

export const builtinSkills: SkillDoc[] = [
  {
    name: '周报整理',
    description: '把零散的工作记录、聊天摘录或旧周报整理成结构清晰的周报，或改写成组会汇报提纲',
    body: `# 周报整理

1. 先弄清材料来源：用户附上的文件、提到的资料，或直接贴在消息里的文字。需要时用 files_search / files_read 读取，不要编造进展。
2. 按下面的结构整理，每条一句话，写具体的结果和数字：
   - **本周完成**：已经完成并可以验证的事
   - **进行中**：当前进度与下一步
   - **问题与求助**：卡住的地方、需要导师或同事决定的事
   - **下周计划**：3–5 条，按优先级排列
3. 用户的记忆里有周报格式要求（例如三段式）时，以记忆为准。
4. 用户要求汇报提纲时，把同样的内容改成幻灯片式提纲：每页一个标题和不超过 4 条要点。
5. 内容较长时用 artifact_create 展示；用户要求保存时再调用 artifact_save。`,
  },
  {
    name: '论文速读',
    description: '快速读一篇论文（PDF 或网页），提炼问题、方法、结果和局限，并给出是否值得精读的建议',
    body: `# 论文速读

1. 读取全文：附件或资料用 files_read（PDF 会自动转换为文字，较长时用 offset 分段读完）；网址用 web_fetch。
2. 按以下结构输出，每部分 2–4 句：
   - **一句话总结**
   - **要解决的问题**：为什么重要，现有方法缺什么
   - **方法**：核心思路，关键公式或模块用通俗的话解释
   - **实验与结果**：数据集、对比基线、主要数字
   - **局限与疑问**：作者承认的和你发现的
   - **是否值得精读**：结合用户的研究方向（如果记忆或项目说明里有）给出建议
3. 引用论文原文时用 files_cite 逐字摘录，让用户可以回到原文核对。
4. 术语第一次出现时给出英文原词。`,
  },
  {
    name: '邮件起草',
    description: '按场景起草得体的中文或英文邮件（请假、咨询导师、投稿、催办等），给出主题和正文',
    body: `# 邮件起草

1. 确认收件人身份、目的和需要对方做的事；信息不全时先问，最多问两个问题。
2. 结构：
   - **主题**：一眼能看出目的，例如“咨询：奖学金申请材料截止时间”
   - **称呼**：对老师用“X 老师您好”，英文用 “Dear Prof. X”
   - **正文**：第一段说明来意；第二段给出必要背景；最后一段明确请求和时间
   - **署名**：按用户记忆中的署名要求
3. 语气礼貌、简洁，不超过 250 字（英文不超过 180 词）。
4. 只起草，不发送；把草稿完整写在回复里，方便用户复制。`,
  },
]

/** Skill names: letters, digits, `-` and `_`, as used in `/` commands. */
export const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u

/** Reads SKILL.md: simple `key: value` front matter, then the body. Null when name or description is missing. */
export function parseSkill(raw: string): SkillDoc | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^﻿/, ''))
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line)
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  const name = fields.name ?? ''
  const description = fields.description ?? ''
  if (!SKILL_NAME.test(name) || !description) return null
  return { name, description: description.slice(0, 1024), body: m[2].trim() }
}

import { builtinSkills } from '../skills'
import type { SkillInfo, WorkspaceFile, WorkspacePreview } from '../types'

// Mock half of the per-chat workspace (roadmap-2 "L0-6 会话工作区"): file texts per chat in
// localStorage; /skills is derived from the enabled built-in skills, like the server's mount.

export type MockFiles = Record<string, { text: string; mtime: number }>
/** Workspace files by chat id. */
export type MockWorkspaces = Record<string, MockFiles>

const now = Date.now()

export const seedWorkspaces: MockWorkspaces = {
  'c-weekly': {
    '/workspace/本周记录.md': {
      text: '# 本周记录\n\n- 周一：跑完 PDB 数据清洗，剩余 3% 异常结构\n- 周三：和导师确认奖学金材料清单\n- 周五：组会汇报提纲初稿\n',
      mtime: now - 26 * 3600_000,
    },
    '/workspace/skills/组会汇报/SKILL.md': {
      text: '---\nname: 组会汇报\ndescription: 把本周记录整理成 5 页以内的组会汇报提纲\n---\n\n# 组会汇报\n\n1. 先读 /workspace/本周记录.md。\n2. 每页一个标题、不超过 4 条要点。\n3. 最后一页列下周计划。\n',
      mtime: now - 25 * 3600_000,
    },
  },
}

/** What /skills holds for the enabled skills; Drive skills are not in the mock. */
export function sharedSkills(skills: SkillInfo[]): Record<string, string> {
  return Object.fromEntries(
    builtinSkills
      .filter((s) => skills.some((x) => x.name === s.name && x.enabled))
      .map((s) => [`/skills/${s.name}/SKILL.md`, `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`]),
  )
}

export function listing(files: MockFiles = {}, skills: SkillInfo[]): WorkspaceFile[] {
  const size = (t: string) => new TextEncoder().encode(t).length
  return [
    ...Object.entries(files).map(([path, f]) => ({ path, size: size(f.text), mtime: f.mtime, readOnly: false })),
    ...Object.entries(sharedSkills(skills)).map(([path, text]) => ({ path, size: size(text), mtime: now, readOnly: true })),
  ].sort((a, b) => a.path.localeCompare(b.path))
}

export function preview(files: MockFiles = {}, skills: SkillInfo[], path: string): WorkspacePreview {
  const text = files[path]?.text ?? sharedSkills(skills)[path]
  if (text == null) throw new Error('文件不存在')
  return { text, size: text.length, truncated: false, binary: false }
}

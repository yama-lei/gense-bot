import { pluginCatalog, pluginReadiness, resolveSettings } from '../plugins/catalog'
import { builtinSkills } from '../skills'
import type { AppState, PluginInfo, PluginValue, ToolCall } from '../types'

const mockPlugins = ['files', 'artifact', 'email', 'ui', 'web', 'image']
/** Settings a real deployment would take from `.env`. */
const mockServerKeys: Record<string, string[]> = { web: ['deepseekKey', 'researchModel'], image: ['baseUrl', 'apiKey'] }

/** A plugin's settings state and issue, as the hub would compute them; secrets only count as set. */
export function mockPluginConfig(id: string, values: Record<string, PluginValue>, secretsSet: string[]): Pick<PluginInfo, 'config' | 'issue'> {
  const serverKeys = mockServerKeys[id] ?? []
  const present = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 'set']))
  const resolved = resolveSettings(id, { ...values, ...present(secretsSet) }, present(serverKeys))
  return { config: { values, secretsSet, serverKeys }, issue: pluginReadiness(id, resolved, true).issue }
}

const now = Date.now()
const min = 60_000
const hour = 60 * min
const day = 24 * hour

const notice = `# 关于2026年秋季学期研究生学业奖学金评定的通知

各位研究生：

1. 申请对象：2025级、2024级全日制研究生。
2. 报名截止时间：2026年10月30日 17:00。
3. 答辩活动时间：2026年11月6日 14:00，地点仙Ⅱ-302。
4. 需提交材料：
   - 申请表（ehall 在线填写）
   - 成绩单（教务系统导出）
   - 科研成果证明（论文首页或录用通知）
5. 联系人：研究生秘书 王老师，grad-office@example.edu.cn

研究生院
2026年10月18日
`

const profile = `# 个人资料

- 姓名：Rayama
- 年级：2025级硕士
- 研究方向：大模型推理系统
- 导师：陈老师

## 成果

- 2026-09 论文 "Efficient KV Cache Offloading" 被 Workshop 录用
- 2026-06 课程项目：分布式训练通信原语实验

## 偏好

- 邮件署名使用中文全名
- 不要把报名截止时间当成活动开始时间
`

const weekly = `# 周报 2026-10-13

## 本周

- 完成 RoPE 实现的单元测试
- 阅读 FlashAttention-3 论文第 3 节

## 下周

- 跑通 8 卡 all-reduce 基准
- 准备组会汇报
`

const draft = {
  to: 'grad-office@example.edu.cn',
  subject: '咨询：学业奖学金科研成果证明材料',
  body: '王老师您好：\n\n我是2025级硕士生 Rayama。想咨询一下，Workshop 录用的论文是否可以作为本次学业奖学金评定的科研成果证明？如可以，提交录用通知是否足够？\n\n谢谢老师！\nRayama',
}

const outline = {
  title: '组会汇报提纲',
  type: 'markdown' as const,
  content: `# 组会汇报提纲（10-13 周）

## 已完成

1. RoPE 实现的单元测试
2. 精读 FlashAttention-3 第 3 节

## 下周计划

- 跑通 8 卡 all-reduce 基准
- 准备组会汇报

## 待讨论

- all-reduce 基准用哪种拓扑
`,
}

const read = (id: string, fileId: string, name: string, text: string, durationMs: number): ToolCall => ({
  id,
  name: 'files_read',
  status: 'succeeded',
  input: { fileId },
  result: { content: `读取 ${name}，${text.length} 字`, structuredContent: { id: fileId, name, text } },
  origin: 'model',
  durationMs,
})

export const seed: AppState = {
  projects: [
    { id: 'p-assistant', name: '个人助手', description: '日常事务、通知整理和邮件草稿。', pinned: true },
    { id: 'p-llm', name: 'LLM Basic Learning', description: '大模型基础知识与实验记录。', pinned: true },
    { id: 'p-research', name: 'Research', description: '文献调研与导师沟通。', pinned: true },
  ],
  conversations: [
    {
      id: 'c-scholarship',
      title: '奖学金通知整理',
      projectId: 'p-assistant',
      pinned: false,
      updatedAt: now - 20 * min,
      turns: [
        {
          id: 't-s1',
          requestId: 'r-s1',
          status: 'succeeded',
          userMessage: '帮我读一下 inbox/奖学金通知.md，告诉我需要做什么，有哪些时间点。',
          summary: '读取通知与个人资料，整理待办和时间点',
          assistantMessage: `我读了通知和你的个人资料，整理如下。

**时间点**（注意区分报名截止和活动时间）

| 事项 | 时间 | 来源 |
| --- | --- | --- |
| 报名截止 | 2026-10-30 17:00 | 通知第 2 条 |
| 答辩活动 | 2026-11-06 14:00，仙Ⅱ-302 | 通知第 3 条 |

**需要准备的材料**

1. ehall 在线填写申请表
2. 从教务系统导出成绩单
3. 科研成果证明：你的 Workshop 论文 *Efficient KV Cache Offloading* 可以作为成果，需要论文首页或录用通知

你符合申请对象（2025级硕士）。要我起草一封给王老师的咨询邮件吗？`,
          toolCalls: [read('tc1', 'f-notice', '奖学金通知.md', notice, 42), read('tc2', 'f-profile', '个人资料.md', profile, 31)],
          citations: [
            { fileId: 'f-notice', name: '奖学金通知.md', quote: '报名截止时间：2026年10月30日 17:00。' },
            { fileId: 'f-notice', name: '奖学金通知.md', quote: '答辩活动时间：2026年11月6日 14:00，地点仙Ⅱ-302。' },
            { fileId: 'f-profile', name: '个人资料.md', quote: '2026-09 论文 "Efficient KV Cache Offloading" 被 Workshop 录用' },
          ],
          model: 'anthropic:claude-haiku-5-5',
          effort: 'medium',
          createdAt: now - 25 * min,
        },
        {
          id: 't-s2',
          requestId: 'r-s2',
          status: 'succeeded',
          userMessage: '好的，起草一封邮件问王老师成果证明是否接受 Workshop 论文。',
          summary: '根据通知联系人起草邮件，等待你检查',
          assistantMessage: '草稿已经准备好，请核对收件人和正文。点“存入草稿箱”后，由你在邮箱 App 中发送。',
          toolCalls: [
            {
              id: 'tc3',
              name: 'email_draft',
              status: 'succeeded',
              input: draft,
              result: { content: '已生成给 grad-office@example.edu.cn 的草稿，等待用户检查', structuredContent: draft },
              resourceUri: 'ui://email/draft',
              origin: 'model',
              durationMs: 880,
            },
          ],
          citations: [{ fileId: 'f-notice', name: '奖学金通知.md', quote: '联系人：研究生秘书 王老师，grad-office@example.edu.cn' }],
          model: 'anthropic:claude-haiku-5-5',
          effort: 'medium',
          createdAt: now - 21 * min,
        },
      ],
    },
    {
      id: 'c-pdb',
      title: 'Python pdb 调用量检查',
      projectId: 'p-llm',
      pinned: false,
      updatedAt: now - 3 * hour,
      turns: [
        {
          id: 't-p1',
          requestId: 'r-p1',
          status: 'succeeded',
          userMessage: `torch.Size([5, 2, 2])
(Pdb) torch.stack([half_cos,half_cos],dim=-1).squeeze(-1)
tensor([[[ 1.0000,  1.0000],
         [ 1.0000,  1.0000]],

        [[ 0.5403,  0.5403],
         [ 1.0000,  1.0000]],

        [[-0.4161, -0.4161],
         [ 1.0000,  1.0000]],

        [[-0.9900, -0.9900],
         [ 1.0000,  1.0000]],

        [[-0.6536, -0.6536],
         [ 1.0000,  1.0000]]])
为什么 squeeze 之后形状没变？`,
          summary: 'Tracing tensor shapes through a stacking and squeeze operation.',
          assistantMessage: `你的 \`half_cos\` 形状应该是 \`(5, 2)\`。\`torch.stack([half_cos, half_cos], dim=-1)\` 会在最后新增一维，结果是 \`(5, 2, 2)\`。

\`.squeeze(-1)\` 没有效果，因为 \`squeeze\` 只会删除大小为 1 的维度，而这里最后一维的大小是 2。所以最终形状仍是 \`(5, 2, 2)\`。

如果你想得到的是 \`(5, 4)\`，比如 \`[c0, c0, c1, c1]\` 这种相邻元素成对重复的排列（常见于 RoPE 的实现），可以这样写：

\`\`\`python
torch.stack([half_cos, half_cos], dim=-1).flatten(-2)   # shape (5, 4)
\`\`\`

如果想要的是 \`[c0, c1, c0, c1]\` 这种整体拼接的排列，则用：

\`\`\`python
torch.cat([half_cos, half_cos], dim=-1)   # shape (5, 4)
\`\`\``,
          toolCalls: [],
          citations: [],
          model: 'anthropic:claude-haiku-5-5',
          effort: 'medium',
          createdAt: now - 3 * hour,
        },
      ],
    },
    {
      id: 'c-weekly',
      title: '周报整理',
      projectId: null,
      pinned: false,
      updatedAt: now - day,
      turns: [
        {
          id: 't-w1',
          requestId: 'r-w1',
          status: 'succeeded',
          userMessage: '根据周报-2026-10-13 写一份组会汇报提纲。',
          summary: '读取周报，生成提纲',
          assistantMessage: '我读了 **周报-2026-10-13.md**，整理成了提纲，并按你的要求保存到了 `GenseBot/Artifacts/`。原文没有改动。',
          toolCalls: [
            read('tc4', 'f-weekly', '周报-2026-10-13.md', weekly, 28),
            {
              id: 'tc4b',
              name: 'artifact_create',
              status: 'succeeded',
              input: outline,
              result: { content: '已创建 Artifact「组会汇报提纲」（未保存）', structuredContent: outline },
              resourceUri: 'ui://artifact/view',
              origin: 'model',
              viewState: { saved: { fileId: 'f-outline', name: '组会汇报提纲.md' } },
              durationMs: 310,
            },
            {
              id: 'tc4c',
              name: 'artifact_save',
              status: 'succeeded',
              input: outline,
              result: { content: '已保存到 GenseBot/Artifacts/组会汇报提纲.md', structuredContent: { fileId: 'f-outline', name: '组会汇报提纲.md' } },
              origin: 'view',
              durationMs: 520,
            },
          ],
          citations: [
            { fileId: 'f-weekly', name: '周报-2026-10-13.md', quote: '完成 RoPE 实现的单元测试' },
            { fileId: 'f-weekly', name: '周报-2026-10-13.md', quote: '跑通 8 卡 all-reduce 基准' },
          ],
          model: 'anthropic:claude-haiku-5-5',
          effort: 'high',
          createdAt: now - day,
        },
        {
          id: 't-w2',
          requestId: 'r-w2',
          status: 'failed',
          userMessage: '再加一页实验进度的表格。',
          summary: '调用模型',
          assistantMessage: '',
          toolCalls: [],
          citations: [],
          error: '模型端点返回 529 Overloaded，已重试 3 次后停止。可以稍后重试，或在下方切换到另一个模型。',
          model: 'openai:gpt-6.1-sol',
          effort: 'high',
          createdAt: now - day + 5 * min,
        },
      ],
    },
    {
      id: 'c-paper',
      title: '学者联系和论文查询',
      projectId: 'p-research',
      pinned: false,
      updatedAt: now - 2 * day,
      turns: [
        {
          id: 't-r1',
          requestId: 'r-r1',
          status: 'interrupted',
          userMessage: '帮我查一下陈老师最近三年的论文。',
          summary: '搜索论文',
          assistantMessage: '我先从你的资料里确认了导师信息，正在检索',
          toolCalls: [
            read('tc5', 'f-profile', '个人资料.md', profile, 30),
            {
              id: 'tc6',
              name: 'web.search',
              status: 'failed',
              input: { query: '陈 大模型推理 2024..2026' },
              result: { content: '已被你停止', isError: true },
              origin: 'model',
              durationMs: 4100,
            },
          ],
          citations: [{ fileId: 'f-profile', name: '个人资料.md', quote: '导师：陈老师' }],
          model: 'anthropic:claude-haiku-5-5',
          effort: 'high',
          createdAt: now - 2 * day,
        },
      ],
    },
  ],
  files: [
    { id: 'f-notice', name: '奖学金通知.md', kind: 'source', mimeType: 'text/markdown', size: new Blob([notice]).size, content: notice, modifiedTime: now - 2 * day },
    { id: 'f-profile', name: '个人资料.md', kind: 'source', mimeType: 'text/markdown', size: new Blob([profile]).size, content: profile, modifiedTime: now - 7 * day },
    { id: 'f-weekly', name: '周报-2026-10-13.md', kind: 'source', mimeType: 'text/markdown', size: new Blob([weekly]).size, content: weekly, modifiedTime: now - 8 * day },
    { id: 'f-outline', name: '组会汇报提纲.md', kind: 'artifact', mimeType: 'text/markdown', size: new Blob([outline.content]).size, content: outline.content, modifiedTime: now - day },
  ],
  schedules: [
    { id: 's1', name: '每日邮件摘要', rule: '每天 08:00', nextRunAt: now + 9 * hour, enabled: true, lastResult: '昨天 08:00 · 3 封新邮件，已生成摘要' },
    { id: 's2', name: '奖学金报名截止提醒', rule: '2026-10-29 20:00 一次', nextRunAt: now + 8 * day, enabled: true, lastResult: '尚未执行' },
    { id: 's3', name: '周报草稿', rule: '每周五 18:00', nextRunAt: now + 3 * day, enabled: false, lastResult: '上周五 · 失败：免费额度耗尽' },
  ],
  plugins: pluginCatalog.map((p) => ({ ...p, enabled: mockPlugins.includes(p.id), available: mockPlugins.includes(p.id), ...mockPluginConfig(p.id, {}, []) })),
  skills: builtinSkills.map((s) => ({ name: s.name, description: s.description, source: 'builtin' as const, enabled: true })),
  memories: [
    { id: 'm1', text: '不要把报名截止时间当成活动开始时间。' },
    { id: 'm2', text: '邮件署名使用中文全名。' },
    { id: 'm3', text: '回答技术问题时附上可运行的最小代码。' },
  ],
  prefs: { language: '中文', defaultEffort: 'medium', model: 'anthropic:claude-haiku-5-5' },
  account: { name: 'Rayama', email: 'rayama@gmail.com', driveConnected: true, driveError: null },
  // Stand-in for GET /v1/models on both endpoints, joined with models.dev capabilities.
  models: [
    { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', capabilities: { toolCall: true, efforts: ['low', 'medium', 'high'], context: 1_000_000, image: true } },
    { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', capabilities: { toolCall: true, efforts: ['low', 'medium', 'high'], context: 1_000_000, image: true } },
    { provider: 'openai', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', capabilities: { toolCall: true, efforts: ['low', 'medium', 'high'], context: 400_000, image: true } },
    { provider: 'openai', id: 'gpt-6.1-mini', name: 'GPT-6.1 Mini', capabilities: { toolCall: true, efforts: [], context: 400_000, image: true } },
    { provider: 'openai', id: 'my-proxy-model', name: 'my-proxy-model', capabilities: null },
  ],
  modelsError: null,
  skillsError: null,
}

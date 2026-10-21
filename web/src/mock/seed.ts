import type { AppState } from '../types'

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
| 报名截止 | 2026-10-30 17:00 | 通知第 6 行 |
| 答辩活动 | 2026-11-06 14:00，仙Ⅱ-302 | 通知第 7 行 |

**需要准备的材料**

1. ehall 在线填写申请表
2. 从教务系统导出成绩单
3. 科研成果证明：你的 Workshop 论文 *Efficient KV Cache Offloading* 可以作为成果，需要论文首页或录用通知

你符合申请对象（2025级硕士）。要我起草一封给王老师的确认邮件吗？`,
          toolCalls: [
            { id: 'tc1', name: 'workspace.read', status: 'succeeded', args: '{ "path": "inbox/奖学金通知.md" }', output: '读取 16 行', durationMs: 42 },
            { id: 'tc2', name: 'workspace.read', status: 'succeeded', args: '{ "path": "profile.md" }', output: '读取 17 行', durationMs: 31 },
          ],
          citations: [
            { path: 'inbox/奖学金通知.md', line: 6 },
            { path: 'inbox/奖学金通知.md', line: 7 },
            { path: 'profile.md', line: 10 },
          ],
          model: 'Workers AI · Llama 4 Scout',
          effort: 'medium',
          createdAt: now - 25 * min,
        },
        {
          id: 't-s2',
          requestId: 'r-s2',
          status: 'succeeded',
          userMessage: '好的，起草一封邮件问王老师成果证明是否接受 Workshop 论文。',
          summary: '根据通知联系人起草邮件，等待你确认',
          assistantMessage: '草稿已经准备好。确认前请核对收件人和正文；修改后需要重新确认。',
          toolCalls: [
            { id: 'tc3', name: 'email.draft', status: 'succeeded', args: '{ "to": "grad-office@example.edu.cn" }', output: '已生成草稿（未发送）', durationMs: 880 },
          ],
          citations: [{ path: 'inbox/奖学金通知.md', line: 12 }],
          confirmation: {
            kind: 'email',
            fields: [
              { label: '收件人', value: 'grad-office@example.edu.cn（王老师）' },
              { label: '主题', value: '咨询：学业奖学金科研成果证明材料' },
              { label: '正文', value: '王老师您好：\n\n我是2025级硕士生 Rayama。想咨询一下，Workshop 录用的论文是否可以作为本次学业奖学金评定的科研成果证明？如可以，提交录用通知是否足够？\n\n谢谢老师！\nRayama' },
            ],
            consequence: '确认后将以你的邮箱发送这封邮件，发送后无法撤回。（Mock：不会真正发送）',
            state: 'pending',
          },
          model: 'Workers AI · Llama 4 Scout',
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
          model: 'Workers AI · Llama 4 Scout',
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
          status: 'failed',
          userMessage: '根据 notes/周报-2026-10-13.md 写一份组会汇报提纲。',
          summary: '读取周报',
          assistantMessage: '',
          toolCalls: [
            { id: 'tc4', name: 'workspace.read', status: 'succeeded', args: '{ "path": "notes/周报-2026-10-13.md" }', output: '读取 12 行', durationMs: 28 },
          ],
          citations: [],
          error: '今日免费模型额度已用完，任务已停止，没有自动切换到付费模型。额度通常在 UTC 0 点恢复，届时可以重试。',
          model: 'Workers AI · Llama 4 Scout',
          effort: 'high',
          createdAt: now - day,
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
            { id: 'tc5', name: 'workspace.read', status: 'succeeded', args: '{ "path": "profile.md" }', output: '读取 17 行', durationMs: 30 },
            { id: 'tc6', name: 'web.search', status: 'failed', args: '{ "query": "陈 大模型推理 2024..2026" }', output: '已被你停止', durationMs: 4100 },
          ],
          citations: [{ path: 'profile.md', line: 6 }],
          model: 'Workers AI · Llama 4 Scout',
          effort: 'high',
          createdAt: now - 2 * day,
        },
      ],
    },
  ],
  docs: [
    { path: 'inbox/奖学金通知.md', content: notice, updatedAt: now - 2 * day },
    { path: 'profile.md', content: profile, updatedAt: now - 7 * day },
    { path: 'notes/周报-2026-10-13.md', content: weekly, updatedAt: now - 8 * day },
  ],
  schedules: [
    { id: 's1', name: '每日邮件摘要', rule: '每天 08:00', nextRunAt: now + 9 * hour, enabled: true, lastResult: '昨天 08:00 · 3 封新邮件，已生成摘要' },
    { id: 's2', name: '奖学金报名截止提醒', rule: '2026-10-29 20:00 一次', nextRunAt: now + 8 * day, enabled: true, lastResult: '尚未执行' },
    { id: 's3', name: '周报草稿', rule: '每周五 18:00', nextRunAt: now + 3 * day, enabled: false, lastResult: '上周五 · 失败：免费额度耗尽' },
  ],
  tools: [
    { id: 'workspace', name: '工作区文件', description: '读取、列出、保存小型文本文档。', sideEffect: false, enabled: true, available: true },
    { id: 'web.search', name: '网页搜索', description: '通过免费搜索接口检索公开网页。', sideEffect: false, enabled: true, available: true },
    { id: 'email', name: '邮件', description: '读取 smail 邮件并起草回复。发送前必须确认。', sideEffect: true, enabled: false, available: false },
    { id: 'ehall', name: 'ehall 办事大厅', description: '查询信息、填写表单。提交前必须确认。', sideEffect: true, enabled: false, available: false },
  ],
  memories: [
    { id: 'm1', text: '不要把报名截止时间当成活动开始时间。' },
    { id: 'm2', text: '邮件署名使用中文全名。' },
    { id: 'm3', text: '回答技术问题时附上可运行的最小代码。' },
  ],
  prefs: { language: '中文', defaultEffort: 'medium', model: 'Workers AI · Llama 4 Scout' },
}

export const models = ['Workers AI · Llama 4 Scout', 'Workers AI · Qwen3 30B', 'Workers AI · Gemma 3 12B']

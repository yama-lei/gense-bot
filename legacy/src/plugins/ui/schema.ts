import { z } from 'zod'

// Generative UI (roadmap-2 "L3 生成式界面"): the model describes a small component tree and the
// browser renders it with the app's own styles. Three fixed levels (grid → card → block) instead
// of a recursive tree, so weaker models get a flat, easy schema. The field descriptions are what
// the model reads about each component.

const short = (max: number) => z.string().max(max)
const url = z.string().url().max(2000).describe('https 链接')

export const uiBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: short(200) }).describe('小标题'),
  z.object({ type: z.literal('text'), text: short(4000).describe('Markdown 正文') }).describe('一段文字'),
  z
    .object({
      type: z.literal('stat'),
      label: short(40),
      value: short(40).describe('主数字，带单位，例如 "¥5,999" 或 "12.5 小时"'),
      note: short(80).optional().describe('补充说明，例如环比变化'),
      trend: z.enum(['up', 'down', 'flat']).optional(),
    })
    .describe('一个关键数字'),
  z.object({ type: z.literal('badges'), items: z.array(short(40)).min(1).max(12) }).describe('一组标签'),
  z.object({ type: z.literal('list'), items: z.array(short(500)).min(1).max(30), ordered: z.boolean().optional() }).describe('列表'),
  z
    .object({
      type: z.literal('table'),
      columns: z.array(short(80)).min(1).max(10),
      rows: z.array(z.array(z.union([short(500), z.number()])).max(10)).max(50).describe('每行的单元格与 columns 一一对应'),
    })
    .describe('表格'),
  z
    .object({
      type: z.literal('chart'),
      kind: z.enum(['bar', 'line', 'pie']).describe('bar 比较大小；line 看随时间的变化；pie 看占比（只用第一个 series，最多 8 块）'),
      title: short(80).optional(),
      labels: z.array(short(40)).min(1).max(24).describe('横轴的类别或时间点'),
      series: z
        .array(z.object({ name: short(40), values: z.array(z.number()).max(24).describe('与 labels 一一对应') }))
        .min(1)
        .max(8)
        .describe('数据系列；单位不同的数据请分成两个图表，不要放在同一个图里'),
      unit: short(12).optional().describe('数值单位，例如 "元" 或 "%"'),
    })
    .describe('图表'),
  z.object({ type: z.literal('image'), url, alt: short(200) }).describe('图片'),
  z.object({ type: z.literal('link'), url, text: short(200) }).describe('链接'),
  z
    .object({ type: z.literal('callout'), tone: z.enum(['info', 'success', 'warning', 'error']), text: short(1000).describe('Markdown') })
    .describe('提示框'),
  z
    .object({
      type: z.literal('buttons'),
      items: z
        .array(z.object({ label: short(30), message: short(500).describe('用户点击后，作为用户消息发送给你的文字') }))
        .min(1)
        .max(6),
    })
    .describe('一组按钮，用于让用户选下一步'),
])

export const uiCard = z
  .object({
    type: z.literal('card'),
    title: short(120).optional(),
    subtitle: short(200).optional(),
    image: url.optional().describe('卡片顶部的图片'),
    blocks: z.array(uiBlock).max(20),
  })
  .describe('卡片，把相关内容放在一起')

export const uiGrid = z
  .object({ type: z.literal('grid'), columns: z.number().int().min(2).max(4).optional().describe('每行几张卡片，默认 3'), cards: z.array(uiCard).min(1).max(12) })
  .describe('卡片网格，适合并列比较几样东西')

export const uiInput = z.object({
  title: short(120).optional().describe('整个界面的标题'),
  blocks: z.array(z.union([uiBlock, uiCard, uiGrid])).min(1).max(30),
})

export type UiBlock = z.infer<typeof uiBlock>
export type UiCard = z.infer<typeof uiCard>
export type UiGrid = z.infer<typeof uiGrid>
export type UiInput = z.infer<typeof uiInput>
export type UiChart = Extract<UiBlock, { type: 'chart' }>

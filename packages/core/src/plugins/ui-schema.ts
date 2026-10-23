// Generative UI (roadmap-2 "L3 生成式界面"): the model describes a small component tree and the browser renders it
// with the app's own styles. Three fixed levels (grid → card → block) instead of a recursive tree, so weaker models
// get a flat, easy schema. The descriptions are what the model reads about each component.
import { Type, type Static } from 'typebox'

const short = (maxLength: number, description?: string) => Type.String({ maxLength, ...(description && { description }) })
const url = Type.String({ maxLength: 2000, pattern: '^https?://', description: 'https 链接' })
const opt = Type.Optional

export const uiBlock = Type.Union([
  Type.Object({ type: Type.Literal('heading'), text: short(200) }, { description: '小标题' }),
  Type.Object({ type: Type.Literal('text'), text: short(4000, 'Markdown 正文') }, { description: '一段文字' }),
  Type.Object(
    {
      type: Type.Literal('stat'),
      label: short(40),
      value: short(40, '主数字，带单位，例如 "¥5,999" 或 "12.5 小时"'),
      note: opt(short(80, '补充说明，例如环比变化')),
      trend: opt(Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('flat')])),
    },
    { description: '一个关键数字' },
  ),
  Type.Object({ type: Type.Literal('badges'), items: Type.Array(short(40), { minItems: 1, maxItems: 12 }) }, { description: '一组标签' }),
  Type.Object({ type: Type.Literal('list'), items: Type.Array(short(500), { minItems: 1, maxItems: 30 }), ordered: opt(Type.Boolean()) }, { description: '列表' }),
  Type.Object(
    {
      type: Type.Literal('table'),
      columns: Type.Array(short(80), { minItems: 1, maxItems: 10 }),
      rows: Type.Array(Type.Array(Type.Union([short(500), Type.Number()]), { maxItems: 10 }), { maxItems: 50, description: '每行的单元格与 columns 一一对应' }),
    },
    { description: '表格' },
  ),
  Type.Object(
    {
      type: Type.Literal('chart'),
      kind: Type.Union([Type.Literal('bar'), Type.Literal('line'), Type.Literal('pie')], { description: 'bar 比较大小；line 看随时间的变化；pie 看占比（只用第一个 series，最多 8 块）' }),
      title: opt(short(80)),
      labels: Type.Array(short(40), { minItems: 1, maxItems: 24, description: '横轴的类别或时间点' }),
      series: Type.Array(Type.Object({ name: short(40), values: Type.Array(Type.Number(), { maxItems: 24, description: '与 labels 一一对应' }) }), {
        minItems: 1,
        maxItems: 8,
        description: '数据系列；单位不同的数据请分成两个图表，不要放在同一个图里',
      }),
      unit: opt(short(12, '数值单位，例如 "元" 或 "%"')),
    },
    { description: '图表' },
  ),
  Type.Object({ type: Type.Literal('image'), url, alt: short(200) }, { description: '图片' }),
  Type.Object({ type: Type.Literal('link'), url, text: short(200) }, { description: '链接' }),
  Type.Object(
    {
      type: Type.Literal('callout'),
      tone: Type.Union([Type.Literal('info'), Type.Literal('success'), Type.Literal('warning'), Type.Literal('error')]),
      text: short(1000, 'Markdown'),
    },
    { description: '提示框' },
  ),
  Type.Object(
    {
      type: Type.Literal('buttons'),
      items: Type.Array(Type.Object({ label: short(30), message: short(500, '用户点击后，作为用户消息发送给你的文字') }), { minItems: 1, maxItems: 6 }),
    },
    { description: '一组按钮，用于让用户选下一步' },
  ),
])

export const uiCard = Type.Object(
  {
    type: Type.Literal('card'),
    title: opt(short(120)),
    subtitle: opt(short(200)),
    image: opt(Type.String({ maxLength: 2000, pattern: '^https?://', description: '卡片顶部的图片' })),
    blocks: Type.Array(uiBlock, { maxItems: 20 }),
  },
  { description: '卡片，把相关内容放在一起' },
)

export const uiGrid = Type.Object(
  {
    type: Type.Literal('grid'),
    columns: opt(Type.Integer({ minimum: 2, maximum: 4, description: '每行几张卡片，默认 3' })),
    cards: Type.Array(uiCard, { minItems: 1, maxItems: 12 }),
  },
  { description: '卡片网格，适合并列比较几样东西' },
)

export const uiInput = Type.Object({
  title: opt(short(120, '整个界面的标题')),
  blocks: Type.Array(Type.Union([uiBlock, uiCard, uiGrid]), { minItems: 1, maxItems: 30 }),
})

export type UiBlock = Static<typeof uiBlock>
export type UiCard = Static<typeof uiCard>
export type UiGrid = Static<typeof uiGrid>
export type UiInput = Static<typeof uiInput>
export type UiChart = Extract<UiBlock, { type: 'chart' }>

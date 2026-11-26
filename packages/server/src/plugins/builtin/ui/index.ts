import { definePlugin } from '../../registry.ts'
import { uiExtension } from '../../display.ts'
import { findPhotos, streetRoute } from '../../genui/lookup.ts'

export default definePlugin({
...{
  "id": "ui",
  "name": "界面",
  "description": "在回答里放可以操作的小页面：图表、计算器、清单，表单可以发回给助手。默认只在要求时或确实需要时使用。",
  "sideEffect": false,
  "settings": [
    {
      "key": "usage",
      "label": "使用倾向",
      "kind": "select",
      "options": [
        {
          "value": "auto",
          "label": "只在需要时"
        },
        {
          "value": "often",
          "label": "尽量使用"
        }
      ],
      "default": "auto"
    }
  ]
},
issue: () => null,
extension: uiExtension,
resources: { ui_render: 'ui://ui/render' },
viewTools: {
ui_photos: { description: '查找照片', async call(args) { const images = await findPhotos(String((args as { query?: string })?.query ?? '')); return { content: '找到 ' + images.length + ' 张照片', structuredContent: { images } } } },
ui_route: { description: '查询路线', async call(args) { const points = await streetRoute(String((args as { coords?: string })?.coords ?? '')); return { content: '路线有 ' + points.length + ' 个点', structuredContent: { points } } } }
}
})

import { definePlugin } from '../../registry.ts'
import { webExtension } from '../../web.ts'

export default definePlugin({
...{
  "id": "web",
  "name": "网页",
  "description": "搜索公开网页、读取网页正文，复杂问题可以深度搜索。回答附来源链接。",
  "sideEffect": false,
  "settings": [
    {
      "key": "deepseekKey",
      "label": "DeepSeek API Key",
      "help": "用于搜索和读取网页",
      "kind": "secret"
    },
    {
      "key": "searchCount",
      "label": "每次搜索结果数",
      "kind": "select",
      "options": [
        {
          "value": "5",
          "label": "5"
        },
        {
          "value": "8",
          "label": "8"
        },
        {
          "value": "12",
          "label": "12"
        },
        {
          "value": "20",
          "label": "20"
        }
      ],
      "default": "8"
    }
  ]
},
issue: config => config.deepseekKey ? null : '需要填写 DeepSeek API Key',
extension: webExtension
})

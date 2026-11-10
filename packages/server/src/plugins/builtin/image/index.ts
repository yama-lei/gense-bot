import { definePlugin } from '../../registry.ts'
import { imageExtension } from '../../image.ts'

export default definePlugin({
...{
  "id": "image",
  "name": "图片",
  "description": "按描述生成图片，显示在会话中，并保存到会话工作区。",
  "sideEffect": false,
  "settings": [
    {
      "key": "baseUrl",
      "label": "端点地址",
      "help": "OpenAI 兼容的 Images API",
      "kind": "url",
      "placeholder": "https://api.openai.com/v1"
    },
    {
      "key": "apiKey",
      "label": "API Key",
      "kind": "secret"
    },
    {
      "key": "model",
      "label": "模型",
      "kind": "text",
      "default": "gpt-image-2"
    },
    {
      "key": "size",
      "label": "默认尺寸",
      "kind": "select",
      "options": [
        {
          "value": "auto",
          "label": "自动"
        },
        {
          "value": "1024x1024",
          "label": "方形 1024×1024"
        },
        {
          "value": "1536x1024",
          "label": "横向 1536×1024"
        },
        {
          "value": "1024x1536",
          "label": "纵向 1024×1536"
        }
      ],
      "default": "auto"
    },
    {
      "key": "quality",
      "label": "质量",
      "help": "越高越慢",
      "kind": "select",
      "options": [
        {
          "value": "auto",
          "label": "自动"
        },
        {
          "value": "low",
          "label": "低"
        },
        {
          "value": "medium",
          "label": "中"
        },
        {
          "value": "high",
          "label": "高"
        }
      ],
      "default": "auto"
    }
  ]
},
issue: config => { const missing = [!config.baseUrl && '端点地址', !config.apiKey && 'API Key', !config.model && '模型'].filter(Boolean); return missing.length ? '需要填写' + missing.join('、') : null },
extension: imageExtension,
resources: { image_generate: 'ui://image/view' }
})

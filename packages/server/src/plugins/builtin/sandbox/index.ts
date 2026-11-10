import { definePlugin } from '../../registry.ts'
import { sandboxExtension } from '../../sandbox.ts'

export default definePlugin({
...{
  "id": "sandbox",
  "name": "代码沙箱",
  "description": "在你自己的隔离容器里运行命令和代码（Python、Node、git 等），可以联网安装依赖，产生的文件保存在会话工作区。服务器关闭沙箱（SANDBOX=0）时不可用。",
  "sideEffect": true,
  "defaultEnabled": true,
  "needsSandbox": true,
  "settings": [
    {
      "key": "image",
      "label": "镜像",
      "help": "从下一条命令起生效，已安装的依赖和文件保留",
      "kind": "select",
      "options": [
        {
          "value": "slim",
          "label": "精简：Python、Node、git、uv 和常用命令行工具"
        },
        {
          "value": "full",
          "label": "完整：另有常用 Python 包、编译工具链、ffmpeg、pandoc"
        }
      ],
      "default": "slim"
    }
  ]
},
issue: () => null,
extension: sandboxExtension
})

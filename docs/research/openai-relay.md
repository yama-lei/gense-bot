# OpenAI 兼容中转站的已知问题

记录时间：2026-10-21。对象是 `.env` 中 `OPENAI_BASE_URL` 指向的中转站（sub2api，默认模型 `gpt-6.1-sol`，走 Responses API）。证据来自本地 `vite dev` 的真实请求和直接 curl / Python 调用，不是中转站的文档。中转站的行为可能随上游变化，处理前先复测。

“现状”一列说明我们目前怎么绕开；“后续”一列是要慢慢解决的事。

## 问题列表

| # | 问题 | 现象与证据 | 现状 | 后续 |
| --- | --- | --- | --- | --- |
| 1 | Responses 请求会被注入托管工具 `image_generation` | 请求只声明了函数工具，但响应的 `tools` 里多出 `image_generation`。用户说“画图”时，模型优先调用它，产出 `image_generation_call`，`result` 是约 1.6 MB 的 base64。AI SDK 报 `Model tried to call unavailable tool 'image_generation'`，这一轮没有回答。路线图 2 阶段 5 也见过：模型找不到图表工具时，改用这个工具画图 | `worker/models.ts` 的 `responsesCompat` 给每个带工具的 Responses 请求设 `tool_choice: {type: "allowed_tools", mode: "auto", tools: [...]}`，只允许调用我们声明的工具。直接调用时验证过：不设时模型调用托管工具；设了以后改为调用 `image_generate` | 问中转站能否关闭注入。若别的端点不支持 `allowed_tools`，需要按端点开关这项改写 |
| 2 | 不支持 `item_reference` | AI SDK 默认 `store: true`，多步工具调用时用 `item_reference` 按 id 引用上一步的推理。中转站不保存响应，整个请求返回 `502 {"error":{"message":"Upstream request failed","type":"upstream_error"}}`，重试 3 次后这一轮失败。出现在第二次及以后的工具调用之后（输入形如 `developer, user, function_call, function_call_output, item_reference, function_call, ...`） | `responsesCompat` 从 `input` 里删掉 `item_reference`。模型因此看不到前几步的推理，可能多花 token，也可能前后不连贯 | 试 `store: false` 加 `include: ["reasoning.encrypted_content"]`，让推理随请求带上。要先确认中转站是否支持 |
| 3 | Images API 忽略 `size`、`quality`、`output_format` | `POST /v1/images/generations`，`model: gpt-image-2`，`size: 1024x1536`。直接调用也返回 `size: 1254x1254`、`quality: low`、`output_format: png`，约 1.6 MB | 按文件头识别格式；图片字节按 1 MB 分块存进会话 DO。图片插件的“默认尺寸”和“质量”目前不生效。横版、竖版只能靠提示词，并不可靠 | 问中转站能否透传这些参数，或换一个透传的端点。之后再验证设置是否生效 |
| 4 | 生图需要分组权限 | 开通前 `/images/generations` 和 Responses `image_generation` 都返回 `Image generation is not enabled for this group` | 用户已开通（2026-10-21） | 换分组或换 Key 时要再确认。图片插件会把 403 转述为“端点没有开通生图” |
| 5 | 两个端点的 `/v1/models` 返回同一份全量列表 | 见[架构](../design/architecture.md)“模型列表”。列表里未必有配置的默认模型 | Anthropic 端点只显示 models.dev 认作 Anthropic 的模型；两个默认模型总是显示 | 无 |
| 6 | 偶发 `Upstream request failed` | 表现与问题 2 相同，都是 502。目前看到的都能用问题 2 解释，没有证据表明存在独立的偶发故障 | AI SDK 默认重试 3 次 | 再出现时记下请求的 `x-request-id` 和 `input` 的结构（不含内容），确认是否另有原因 |

## 复测方法

- 问题 1、2：用 Python 直接调用 `POST /v1/responses`，看 `output` 里每一项的 `type`，以及响应回显的 `tools`。
- 问题 3：用 Python 调用 `/v1/images/generations`，读 PNG 头第 16–24 字节得到宽高。
- 在应用里复现：本地 `vite dev` 下让助手画图，或者让它连续调用两次以上工具。
- 读取 `.env` 时不要打印密钥，日志用 `grep -v 'ANTHROPIC\|OPENAI\|TOKEN\|SECRET\|GOOGLE'` 过滤。

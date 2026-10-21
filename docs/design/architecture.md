# Design：Cloudflare 云端个人助手

状态：架构草案，待评审与部署验证。2026-10-21 起改用 Think + Google Drive（见 [ADR-0002](../adr/0002-think-google-drive.md)），原 Pi Durable / PiHarness / Computer Workspace 方案作废。

依据：[产品 Intent](../intents/personal-assistant.md)、[Spec](../specs/personal-assistant.md)、[网页界面 Spec](../specs/web-ui.md)。

## 技术基线

| 用途 | 选择 | 备注 |
| --- | --- | --- |
| 语言 | TypeScript | |
| 前端 | React + Vite（沿用 `web/`） | 聊天用 `@cloudflare/ai-chat/react` 的 `useAgentChat` |
| 宿主 | Workers + SQLite-backed Durable Objects，Free 计划 | `nodejs_compat`；静态资源与 Agent 同一个 Worker |
| Agent 运行时 | `@cloudflare/think` | 依赖锁定精确版本；`@cloudflare/computer` 只作为 peer dependency 安装 |
| 模型 | AI SDK `@ai-sdk/anthropic`、`@ai-sdk/openai` | 两个兼容端点，配置来自 `.env`，模型列表从端点获取 |
| 登录 | Cloudflare Access，Google 身份提供方 | Worker 自己再校验 Access JWT |
| 用户文件 | Google Drive API v3 | OAuth scope 先只申请 `drive.file` |
| 部署 | `cf deploy --secrets-file .env` | 密钥不进 Git，不经过对话 |

不使用 Dynamic Workers、Containers、Workers AI、R2 或向量库。

## 组件

```text
浏览器（手机 / 桌面）
  │  Cloudflare Access（Google 登录、邮箱白名单）
  ▼
Worker 入口
  ├─ 静态资源（SPA）
  ├─ 校验 Cf-Access-Jwt-Assertion → 不通过返回 403
  ├─ /oauth/google/*   Google 授权回调
  └─ /agents/*         routeAgentRequest
        ├─ UserHub（Agent，每个用户一个）
        │    会话索引、项目、偏好、工具开关、记忆、Google 凭据
        └─ Chat（Think，每个会话一个）
             消息、轮次状态、工具循环、恢复
             工具 → UserHub 取 access token → Drive API
```

- **Chat** 每个会话一个实例，名称就是会话 ID。消息、流恢复和去重都由 Think 负责，我们不再维护第二份聊天记录。
- **UserHub** 保存跨会话的数据。Chat 通过 DO RPC 找它要短期 access token，refresh token 不离开 UserHub。
- 单用户首版也按用户 ID（Access JWT 中的 `sub`）给 UserHub 命名，以后支持多用户时不用迁移数据。

## 登录与授权

1. Access 应用覆盖整个域名（包括 `workers.dev`），策略：只允许指定的 Google 邮箱。
2. Worker 对每个非静态请求都校验 `Cf-Access-Jwt-Assertion`：签名用团队域名的 certs，`aud` 要匹配应用的 AUD tag。不能只信任“请求经过了 Access”，这样可以防止有人绕过 Access 直接访问 Worker。
3. 首次使用时，界面提示“连接 Google Drive”，走 OAuth 授权码流程（`access_type=offline`），拿到 refresh token 后加密保存在 UserHub。加密用 AES-GCM，密钥来自 secret `TOKEN_ENCRYPTION_KEY`。
4. Google OAuth 应用发布为 Production（未验证）。如果停留在 Testing，refresh token 约 7 天过期。`drive.file` 是非敏感 scope；以后加日历、Tasks 时增量申请对应 scope。

Access 登录和 Google OAuth 是两次授权：前者证明“你是谁”，后者授权“助手可以访问你的 Drive”。暂时不合并，因为 Access 不会把 Google 的 API token 交给我们的应用。

## 模型

`.env` 中配置两个供应商，各自都是可选的，至少要有一个：

| 供应商 | 变量 | AI SDK |
| --- | --- | --- |
| Anthropic 兼容 | `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`DEFAULT_ANTHROPIC_MODEL` | `createAnthropic({ baseURL, authToken })`，以 `Authorization: Bearer` 发送 |
| OpenAI 兼容 | `OPENAI_BASE_URL`、`OPENAI_AUTH_TOKEN`、`DEFAULT_OPENAI_MODEL` | `createOpenAI({ baseURL, apiKey })`，默认使用 Responses API |

```ts
getModel() {
  const { provider, model } = this.getConfig() // 会话选定的模型
  return provider === 'openai'
    ? createOpenAI({ baseURL: v1(this.env.OPENAI_BASE_URL), apiKey: this.env.OPENAI_AUTH_TOKEN })(model)
    : createAnthropic({ baseURL: v1(this.env.ANTHROPIC_BASE_URL), authToken: this.env.ANTHROPIC_AUTH_TOKEN })(model)
}
// v1()：去掉末尾斜杠，没有 /v1 时补上
```

- **模型列表**：UserHub 分别调用两个端点的 `GET /v1/models`（处理分页），缓存 1 小时，按供应商分组显示在选择器中。某个端点获取失败时，只显示这个供应商的 `DEFAULT_*_MODEL`，并标注“列表获取失败”。
- **默认模型**：新会话使用用户上次选择的模型；从未选过时，使用 `DEFAULT_ANTHROPIC_MODEL`，没有配置就用 `DEFAULT_OPENAI_MODEL`。
- **切换模型**：每个会话记录所选的供应商和模型，可以在会话中切换；每一轮记录实际使用的模型。
- **effort**：映射到各供应商自己的推理强度参数（Anthropic 的 effort / thinking，OpenAI 的 `reasoningEffort`）。具体映射在 V1 中按实际端点确定。
- **待验证**：根据 AI SDK 文档，GPT-6 系列的工具调用要通过 Responses API。如果 OpenAI 兼容端点只支持 Chat Completions，这个供应商就不能用于需要工具的会话，界面要标注出来。

## Drive 存储

```text
我的云端硬盘/
└─ GenseBot/
   ├─ 资料/        用户上传的文件
   └─ Artifacts/   助手保存的产物
```

- `drive.file` 只能访问本应用创建的文件，以及用户通过 Google Picker 选中的文件。用户自己手动放进 `资料/` 的文件，助手看不到，需要用 Picker 选择一次。这是用权限范围换来的安全性：如果申请完整的 `drive` scope，就属于受限 scope，授权页会出现更严重的警告。（待用户确认，见“待定”）
- 文件 ID 是唯一标识，路径只用于显示。UserHub 缓存文件列表（ID、名称、修改时间），Drive 才是数据源。
- 首版只处理文本：`.md`、`.txt`、`.csv`、`.json` 和 Google 文档（导出为 Markdown 或纯文本）。PDF 和图片放到后续阶段。

### 工具

| 工具 | 副作用 | 说明 |
| --- | --- | --- |
| `files.list` / `files.search` | 无 | 列出或按名称搜索资料与 Artifacts |
| `files.read` | 无 | 按文件 ID 读取文本，过长时分段读取 |
| `artifact.save` | 创建新文件 | 只在 `Artifacts/` 中新建文件，不覆盖已有文件，所以可以安全重试（以 `idempotencyKey` 作为 Drive `appProperties` 去重） |
| `files.update` / `files.delete` | 修改用户数据 | 首版不提供；后续通过 Think Actions 的审批流程加入 |

### 引用

助手回答时，以结构化数据输出引用：`{ fileId, name, quote }`，`quote` 是不超过 200 字的原文。界面打开文件后，先做精确匹配，再做去掉空白后的匹配，找到就高亮，找不到就提示“原文已变化”。服务端在保存这一轮之前检查 `quote` 确实出现在本轮读过的内容中，不在的引用直接丢弃，防止模型编造引用。

## 一轮任务的数据流

1. 前端为每条消息生成稳定 ID，通过 `useAgentChat` 发送。
2. Think 持久化消息后开始执行（S3）。文档只明确保证了 `runTurn({ mode: 'submit', idempotencyKey })` 和 `addMessages()`（按消息 ID）是幂等的，没有说明 WebSocket 路径会对同一条消息 ID 去重。V4 要实测；如果不去重，就改为由前端通过 callable 方法调用 `runTurn` 的 submit 模式，WebSocket 只用来接收流。
3. 模型调用工具，工具执行前检查 UserHub 中的工具开关（S8）。
4. 浏览器断开后，DO 继续执行；重新连接时 Think 恢复流或返回最终消息（S4）。
5. DO 被驱逐或重新部署后，由 `chatRecovery` 恢复（S7）。有副作用的工具标记为不可重放：恢复时如果发现它已开始但没有结果，标记为“结果未知”，不重跑。

## 兜底限制的实现

- 单轮工具调用：`maxSteps = 20`。
- 模型流卡住：`chatStreamStallTimeoutMs = 120_000`。
- 恢复：使用 `chatRecovery` 的 `maxRecoveryWork`、`shouldKeepRecovering`；超过后，本轮标记为失败。
- 错误分类：模型 4xx/5xx、Drive 错误、平台额度错误分别映射到界面文案（Spec S2、S9）。
- 不做按天计数。如果以后发现需要，再在 UserHub 中加计数器。

## 插件与界面

工具按插件组织。插件可以自带界面，接口按 [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) 的概念设计，这样以后接入的 MCP 工具及其界面，也能和我们自己的工具走同一条渲染路径。（2026-10-21 确认：首版用 React 渲染，只对齐接口。）

```text
plugins/<id>/
  tools.ts   工具定义（服务端）
  views.tsx  界面组件（前端，可选）
```

### 工具（服务端）

- 每个工具有名称、说明、参数 schema，以及 `execute()`。
- 返回值与 MCP 的 `CallToolResult` 一致：`content` 给模型看，`structuredContent` 给界面用。
- 需要界面的工具在元数据中声明 `_meta.ui.resourceUri = 'ui://<插件>/<视图>'`。
- 声明副作用和重放策略（见“兜底限制的实现”）。
- 按 MCP Apps 的建议，**取数据**和**显示**分开：数据工具不带界面，显示工具接收模型整理好的数据，再交给界面渲染。

### 界面（前端）

前端维护一张表，把 `resourceUri` 映射到 React 组件。组件收到的参数和 MCP Apps 的消息一一对应：

| 组件参数 | 对应的 MCP Apps 消息 | 用途 |
| --- | --- | --- |
| `toolInput` | `ui/notifications/tool-input` | 工具调用的参数 |
| `toolResult` | `ui/notifications/tool-result` | `structuredContent` 与 `content` |
| `host.callTool(name, args)` | `tools/call` | 界面直接调用本插件的工具，例如“重新生成” |
| `host.sendMessage(text)` | `ui/message` | 以用户身份发一条后续消息 |
| `displayMode` | `inline` / `fullscreen` | 另加 `panel`（右侧面板，手机上全屏），给 Artifact 使用 |

渲染一个工具调用时，按以下顺序选择：

1. `resourceUri` 在表中 → 用内置 React 组件渲染。
2. 来自 MCP 服务器、资源类型为 `text/html;profile=mcp-app` → 在沙箱 iframe 中渲染（**预留，首版不实现**）。
3. 其他情况 → 通用的工具调用卡片（名称、状态、参数、结果摘要）。

### 安全

- 界面发起的 `callTool` 发到服务端的 Chat，和模型发起的调用走同一套工具开关和权限检查。界面只能调用本插件的工具。
- 有副作用的工具无论由谁发起，都要经过确认（Think Actions 审批），界面不能绕过。
- 以后渲染 MCP 界面时，iframe 必须放在独立域名上（例如单独部署一个 sandbox Worker），使用 `@mcp-ui/client` 或官方 AppBridge，并按 `_meta.ui.csp` 限制它能加载的外部资源。第三方界面不能访问主站的 cookie 或接口。

### 首批插件

| 插件 | 工具 | 界面 |
| --- | --- | --- |
| files | `files.list`、`files.search`、`files.read` | 无（通用卡片）；引用卡片属于消息本身，不归插件 |
| artifact | `artifact.create`（显示工具）、`artifact.save` | `ui://artifact/card`（消息中的卡片）、`ui://artifact/panel`（面板预览，提供保存到 Drive） |
| email（后续） | `email.search`、`email.read`、`email.draft`（显示工具）、`email.saveDraft` | `ui://email/draft`：草稿预览，可修改，点“存入草稿箱”时调用 `email.saveDraft` |
| mcp（后续） | 远程 MCP 服务器的工具 | 按上面第 2 条处理 |

## 后续能力

### smail（腾讯企业邮）

方案已于 2026-10-21 确认。

腾讯企业邮的开放 API 需要组织管理员权限，学生账号拿不到，所以只能走标准协议：

- **读取**：IMAP `imap.exmail.qq.com:993`（SSL），用邮箱设置里生成的“客户端专用密码”登录，不用主密码。UserHub 用 Think scheduled tasks 定时（例如每 15 分钟）拉取新邮件，按 `UIDVALIDITY + UID` 去重，生成摘要。
- **回复**：助手把起草好的回复写入草稿箱（IMAP `APPEND` 到 Drafts）。用户在企业微信或邮箱 App 中打开草稿，修改后自己点发送。这样“发送的是用户确认的最终版本”这一点由用户的操作保证，我们不需要实现发送确认、幂等和结果未知的处理。
- **直接发送**（可选，更晚）：SMTP `smtp.exmail.qq.com:465`，必须走确认卡片；发送后把邮件 `APPEND` 到“已发送”。
- **待验证**：Workers 的 TCP sockets 能否连接这两个端口；`imapflow` 等 IMAP 库能否在 `nodejs_compat`（`node:net` / `node:tls`）下运行。如果不行，就自己用 `cloudflare:sockets` 实现所需的少量 IMAP 命令。
- **备选**：在 smail 中设置自动转发到 Gmail，再用 Gmail API 读取。缺点是需要 `gmail.readonly`（受限 scope），而且回复仍要通过腾讯的 SMTP 以 smail 身份发出。

### Google Calendar / Tasks

共用同一个 Google OAuth 授权，增量申请 scope。提醒以 Google Tasks 或日历事件的形式交付，这样手机上有原生通知，我们就不用自己做推送。

## 实现前验证

| 阶段 | 验证内容 | 通过证据 |
| --- | --- | --- |
| V1 | Think 部署到 Free 计划，并接入用户模型 | 锁定的依赖版本；两个端点的 `/v1/models` 是否可用；两个供应商各完成一轮带工具调用的对话；记录 compatibility date |
| V2 | Access 与 JWT 校验 | Spec S1 的三个操作全部符合预期 |
| V3 | Google OAuth 与 Drive | 授权后上传、读取、保存 Artifact；8 天后 refresh token 仍有效（Production 状态） |
| V4 | 去重、断线、恢复 | Spec S3、S4、S7 的操作 |
| V5 | 兜底限制 | Spec S9 的操作 |
| V6 | Free 计划资源 | 记录一天正常使用的 Worker 请求数、DO 请求数和 SQL 读写行数，与免费额度对比 |
| V7（后续） | smail IMAP | 在 Worker 中登录并列出收件箱的最新 5 封邮件；`APPEND` 一封草稿后，在 App 中能看到 |

测试走真实路径：使用真实模型端点和真实的测试 Drive 账号，不写只测 mock 的测试。

## 待定

- 用 `drive.file` + Picker，还是申请完整的 `drive` scope（见“Drive 存储”）。
- Google 文档的导出格式选 Markdown 还是纯文本，取决于 Drive API 的实际导出质量。
- 是否需要会话全文搜索；Think 的 session search 能否跨会话使用。
- MCP 界面 iframe 的 sandbox 域名，以及 `@mcp-ui/client` 和官方 AppBridge 选哪个（接入 MCP 时再定）。

## 上游依据

- [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)、[OpenAI：给 MCP 服务器加 UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Think 文档](https://developers.cloudflare.com/agents/harnesses/think/)
- [Think 配置](https://developers.cloudflare.com/agents/harnesses/think/configuration/)、[恢复](https://developers.cloudflare.com/agents/harnesses/think/recovery/)、[Actions](https://developers.cloudflare.com/agents/harnesses/think/actions/)
- [AI SDK Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)
- [Cloudflare Access：校验 JWT](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)
- [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

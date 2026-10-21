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
| 模型 | AI SDK `@ai-sdk/anthropic` | 端点和 token 来自 `.env`，模型列表从端点获取 |
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

```ts
getModel() {
  const base = this.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '')
  return createAnthropic({
    baseURL: base.endsWith('/v1') ? base : `${base}/v1`,
    authToken: this.env.ANTHROPIC_AUTH_TOKEN, // 以 Authorization: Bearer 发送
  })(this.getConfig().model) // 会话创建时选定的模型
}
```

- `.env` 只需要 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`。
- UserHub 调用 `GET {base}/v1/models` 获取模型列表（处理 `has_more` 分页），缓存 1 小时，界面的模型选择器显示这个列表。用户上次选的模型存在偏好里，作为新会话的默认值。
- 端点不支持 `/v1/models`，或者返回空列表时，界面提示“无法获取模型列表”，不发送消息。不内置后备模型名，因为写死的名字很可能在这个端点上不存在。
- 每个会话在创建时记录所选模型，之后可以在会话中切换；轮次记录实际使用的模型。

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
| V1 | Think 部署到 Free 计划，并接入用户模型 | 锁定的依赖版本；`/v1/models` 返回列表；用其中一个模型完成一轮对话；记录 compatibility date |
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

## 上游依据

- [Think 文档](https://developers.cloudflare.com/agents/harnesses/think/)
- [Think 配置](https://developers.cloudflare.com/agents/harnesses/think/configuration/)、[恢复](https://developers.cloudflare.com/agents/harnesses/think/recovery/)、[Actions](https://developers.cloudflare.com/agents/harnesses/think/actions/)
- [AI SDK Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)
- [Cloudflare Access：校验 JWT](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)
- [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

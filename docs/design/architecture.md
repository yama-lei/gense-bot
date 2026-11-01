# Design：单机自部署的个人助手

状态：描述路线图 4 阶段 1（2026-10-31）之后的代码。方向见 [ADR-0004](../adr/0004-pi-durable-portable-core.md)（pi-durable 核心）与 [ADR-0005](../adr/0005-event-driven-vps.md)（事件驱动、单机 VPS）；各部分的详细设计见 [路线图 3](../plans/roadmap-3.md#design) 的 D1–D11。最早的 Think + Google Drive 方案（ADR-0002）及其 V1–V7 验证记录已作废，原文在 git 历史和标签 `legacy-final` 里。

依据：[产品 Intent](../intents/personal-assistant.md)、[Spec](../specs/personal-assistant.md)、[网页界面 Spec](../specs/web-ui.md)。

## 技术基线

| 用途 | 选择 | 备注 |
| --- | --- | --- |
| 语言与运行时 | TypeScript，Node 24 直接运行 `.ts` | 服务端不编译；只有前端用 Vite 构建 |
| Agent 运行时 | `@earendil-works/pi-durable`（锁定版本） | 会话、分叉、工具循环、恢复、定时任务都由它负责 |
| 存储 | 一个 SQLite 文件（`node:sqlite`，WAL） | pi-durable 的表和本项目的表在同一个库、同一个事务队列里 |
| 前端 | React + Vite（`packages/web`） | 同一个进程提供静态文件和 WebSocket |
| 模型 | pi-ai：`.env` 里的中转，加上所有者自己的 API key / 订阅登录 | 见“模型” |
| 登录 | 单一所有者密码 | 见“登录” |
| 执行命令 | Docker sandbox（可用 `SANDBOX=0` 关闭） | 见“文件与 sandbox” |
| 部署 | Docker Compose：app + Caddy（自动 TLS） | 目标机器 2 核 2 GB |

## 组件

```text
浏览器（手机 / 桌面）
  │  HTTPS
  ▼
Caddy ── reverse_proxy ──► app 容器（hosts/node，一个 Node 进程）
                              ├─ 静态文件（packages/web/dist）
                              ├─ /api/login、/api/logout、/api/me
                              ├─ /hooks/<hookId>   webhook，按签名校验，不看登录
                              └─ WebSocket         校验登录 cookie 后建 Connection
                                    │
                                    ▼
                              UserSpace（packages/core）
                                ├─ pi-durable Harness：会话树、分叉、子 agent
                                ├─ Event、定时任务、webhook
                                ├─ 插件（pi-durable extension）与 Skills
                                ├─ 模型账户（ModelAccounts）
                                └─ Workspace ──► 文件目录 / sandbox 容器
```

- `packages/core` 不依赖 Node 之外的部署细节：存储、文件环境、sandbox 都由宿主（`hosts/node`）传进来。两者何时合并留给后续阶段（ADR-0005 决定 2）。
- 一份数据同一时间只能由一个进程打开，所以不能多副本。
- 前端协议见路线图 3 D9：服务端转发 pi-durable `watch()` 的 Chord 操作，前端在本地组装消息；发言、中止、分叉等都是 WebSocket 上的请求。

## 登录

- 只有一个所有者，没有用户名或邮箱。密码在服务器上用 `npm run passwd` 设置，存 PBKDF2（600 000 次）哈希；改密码会退出所有已登录的会话。
- 登录后发 `HttpOnly; SameSite=Lax` 的会话 cookie，HTTPS 下加 `Secure`；服务端存会话记录的哈希，可以吊销。WebSocket 握手校验同一个 cookie，写请求还检查同源。
- 连续 5 次密码错误后锁定 15 分钟。

## 数据与备份

```text
<DATA_DIR>/
  gense.sqlite   登录、会话树、Event、定时任务、插件设置、加密的密钥、pi-durable 存储
  files/         工作区，agent 看到的是 /data（见下）
  backups/       gense-<时间>.sqlite
```

- 每小时检查一次，最新副本超过一天就用 `VACUUM INTO` 拷一份（`.partial` 写完再改名），保留 `BACKUP_KEEP`（默认 7）份。`BACKUPS=0` 关闭。
- 恢复：停掉服务，把某个副本复制成 `gense.sqlite`，删掉 `-wal`、`-shm`，再启动（README“部署到 VPS”）。
- 插件密钥和模型凭据用 `TOKEN_ENCRYPTION_KEY` 加密后存进数据库，只在宿主进程里解密。

## 模型

- **中转**：`.env` 的 `PROVIDER_BASE_URL`、`PROVIDER_AUTH_TOKEN` 注册为 provider `relay`，走 OpenAI Responses 接口。中转的已知问题见 [OpenAI 兼容中转站](../research/openai-relay.md)。
- **模型列表**：中转的模型来自 `DEFAULT_PROVIDER_MODEL` 和 `PROVIDER_MODELS`（逗号分隔），不再调用端点的 `/v1/models`，也不再从 models.dev 取能力。所有者在设置页给 pi-ai 内置的 provider 填 API key 或登录订阅后，这些 provider 的模型也进入列表（路线图 3 D11）。
- **默认与切换**：新会话用 `DEFAULT_PROVIDER_MODEL`；每个分叉可以切换模型，下一轮生效。
- 没有中转配置时启动失败；开发和测试用 `GENSE_FAUX=1` 的假模型。

## 一轮任务的数据流

1. 前端为每条消息生成请求 id，通过 WebSocket 发送；pi-durable 按 id 去重。
2. Harness 持久化输入后开始执行；浏览器断开不影响运行，重连后从当前状态继续显示（pi-durable 不回放历史帧）。
3. 进程崩溃或重启后，Harness 从存储中恢复未完成的运行（R32）。启动时还会补投尚未送达的 Event。
4. Event（子 agent 汇报、定时任务、webhook、系统通知）按 `requestId = event.id` 投递，重启重投不会重复（路线图 3 D4）。

## 文件与 sandbox

- 每棵会话树一个工作区：agent 看到 `/data/sessions/<treeId>`（cwd）和只读的 `/data/skills`，对应宿主上的 `<DATA_DIR>/files/`。
- 文件工具（`read`/`write`/`edit`/`delete`）直接访问宿主目录，带读前检查账本（路线图 3 D6），不依赖 sandbox 是否在运行。
- `bash` 在一个 Docker 容器 `gense-sandbox` 里执行（路线图 3 D7）：
  - 镜像 `gense-sandbox:slim` 或 `:full`，以宿主用户的 uid 运行，`/data` 绑定挂载文件目录。
  - 超时默认 120 秒；内存默认 1 GB（`SANDBOX_MEMORY`），CPU 和进程数也有上限；空闲后自动停止，文件不丢。
  - 能上外网，不能访问宿主端口和内网；规则由带 NET_ADMIN 的临时辅助容器写入。
  - 任何密钥都不进 sandbox（R59）。
- app 自己在容器里时，通过挂载的 Docker socket 启动 sandbox。sandbox 按**宿主上的路径**挂载文件，所以 `DATA_DIR` 在 app 容器内外必须是同一个绝对路径（`compose.yaml` 用 `GENSE_DATA`）。

## 插件与界面

工具按插件组织（`packages/core/src/catalog.ts` 声明，`packages/core/src/plugins/` 实现，每个插件是一个 pi-durable extension）。插件可以自带界面，接口按 [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) 的概念设计，这样以后接入的 MCP 工具及其界面，也能和我们自己的工具走同一条渲染路径。首版用 React 渲染，只对齐接口。

### 工具（服务端）

- 每个工具有名称、说明、参数 schema 和 `execute()`。工具名只用字母、数字和下划线，点号会被部分模型 API 拒绝。
- 返回值与 MCP 的 `CallToolResult` 一致：`content` 给模型看，`structuredContent` 给界面用。
- 需要界面的工具声明 `ui://<插件>/<视图>`。按 MCP Apps 的建议，取数据和显示分开：数据工具不带界面，显示工具接收模型整理好的数据，再交给界面渲染。
- 插件开关只在设置改变时生效（会改变工具列表），下一轮起作用。

### 界面（前端）

前端把资源 URI 映射到 React 组件（`packages/web/src/plugins/`，接口在 `types.ts`）。组件参数与 MCP Apps 的消息一一对应：

| 组件参数 | 对应的 MCP Apps 消息 | 用途 |
| --- | --- | --- |
| `toolInput` | `ui/notifications/tool-input` | 工具调用的参数 |
| `toolResult` | `ui/notifications/tool-result` | `structuredContent` 与 `content` |
| `host.callTool(name, args)` | `tools/call` | 界面调用本插件的工具，例如“重新生成” |
| `host.sendMessage(text)` | `ui/message` | 以用户身份发一条后续消息 |
| `displayMode` | `inline` / `fullscreen` | 另加 `panel`（右侧面板，手机上全屏） |
| `host.requestDisplayMode(mode)` | `ui/request-display-mode` | 界面请求切换显示方式 |
| `viewState` / `host.setViewState(state)` | 无标准字段（对应 ChatGPT 的 `widgetState`） | 保存界面状态，重开页面后恢复 |
| `host.readFile(path)` | 无 | 读取本会话工作区里的文件，例如工具写出的图片 |

渲染一个工具调用时：资源在表中就用内置组件；来自 MCP 服务器的 `text/html;profile=mcp-app` 在沙箱 iframe 中渲染（预留，未实现）；其他情况显示通用的工具调用卡片。生成式界面（插件 `ui`）用 OpenUI Lang，见 [OpenUI 计划](../plans/openui.md)。

### 安全

- 界面发起的 `callTool` 和模型发起的调用走同一套插件开关和权限检查，只能调用本插件的工具。
- 以后渲染 MCP 界面时，iframe 必须放在独立域名上，并按 `_meta.ui.csp` 限制它能加载的资源；第三方界面不能访问主站的 cookie 或接口。

### 现有插件

| 插件 | 内容 |
| --- | --- |
| artifact | 生成文档预览，在面板中打开 |
| email | 起草邮件，由用户检查后复制或在邮箱 App 中发送 |
| ui | 生成式界面（OpenUI Lang） |
| web | 网页搜索与读取 |
| image | 生成图片 |
| sandbox | `bash`，需要 Docker sandbox |
| drive、mcp | 已预留，未实现 |

## 后续能力

按 [路线图 4](../plans/roadmap-4.md)：聊天先变成 Source `chat` 的 Trigger，再加 Eval gate、Mandate、Ticket 和 outbox，然后依次接入 GitHub、内置日历、GitLab、飞书。每个外部 Source 自己验签、按投递 id 去重；令牌只在宿主进程里，push、评论由宿主工具代做。

### smail（腾讯企业邮）

方案于 2026-10-21 确认，尚未实现。开放 API 需要组织管理员权限，所以走标准协议：

- **读取**：IMAP `imap.exmail.qq.com:993`（SSL），用“客户端专用密码”登录；定时拉取新邮件，按 `UIDVALIDITY + UID` 去重。
- **回复**：起草好的回复用 IMAP `APPEND` 写入草稿箱，由用户在邮箱 App 中修改并发送。
- **直接发送**（可选，更晚）：SMTP `smtp.exmail.qq.com:465`，必须走确认卡片。
- 现在运行在 Node 上，可以直接使用 `imapflow` 等 IMAP 库，原先 Workers TCP sockets 的验证项不再需要。

### 日历

ADR-0005 决定先做内置日历，复用现有定时任务（规则、时区、幂等触发）。Google Calendar / CalDAV 同步暂不做。

## 实现前验证

| 项目 | 证据 |
| --- | --- |
| 功能（R 编号） | `npm test`：core 与 `hosts/node` 的测试走真实的 SQLite、文件和 Docker，模型用 faux provider；sandbox 测试需要先 `npm run sandbox:build` |
| 内存 | 路线图 4 阶段 1 记录：空闲 RSS 142 MB，10 个会话同时回答时峰值 168 MB（不含 sandbox） |
| 真实模型 | 部署前手动冒烟，覆盖中转的已知问题 |
| 部署 | 2 GB 机器上 `docker compose up` 后的内存余量（阶段 1 验收，待在 VPS 上测） |

路线图 3 的验证脚本与记录见其 [实现前验证](../plans/roadmap-3.md#实现前验证) 一节。

## 待定

- 是否需要会话全文搜索。
- MCP 界面 iframe 的独立域名，以及 `@mcp-ui/client` 和官方 AppBridge 选哪个（接入 MCP 时再定）。
- `core` 与 `hosts/node` 是否合并。

## 上游依据

- [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)、[OpenAI：给 MCP 服务器加 UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- pi-durable、pi-ai、chord 的 README（`node_modules/@earendil-works/*`）
- [`ref/dsh-superagent-prototype`](../../ref/dsh-superagent-prototype/)（ADR-0005 的参考实现）

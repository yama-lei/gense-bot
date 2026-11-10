# 路线图 5：后端任务

读者：实现后端的 agent。先读 [roadmap-5.md](roadmap-5.md)（Intent、Spec、Design、决定）和 `AGENTS.md`。

## 边界

- 你只改 `packages/server`（阶段 B0 之前是 `packages/core` 与 `hosts/node`）、根目录的 `package.json` / `tsconfig` / `Dockerfile` / `compose.yaml` / `Makefile` / `README.md` / `.env.example`，以及 `docs/design/architecture.md`。
- **不要改 `packages/web`。** 前端正在另一个分支重写，现在类型检查不过是预期的；你的检查命令不包含它。
- **`packages/protocol` 是契约，由前端一方维护。** 按它实现。发现缺字段、歧义或做不到的地方，不要自己改：写进 `docs/plans/roadmap-5-backend-notes.md` 的“协议问题”一节，并在汇报里说明；阻塞时先用最接近的做法继续。
- 不需要兼容旧数据和旧接口；旧数据库不迁移。历史设计（roadmap-3、ADR）与 roadmap-5 冲突时以 roadmap-5 为准。
- 测试按 Spec 的编号写，走真实的 SQLite、文件和 faux 模型。MCP 和飞书用测试里启动的本地服务器（实现真实协议的那一小部分），不用 mock 对象。不要写只验证 mock 的测试。
- 每个阶段一个提交，消息格式 `{chore,feat}/slug: content`。不要 push。每个阶段结束时：`npm run check:server` 通过，然后 `hc send` 汇报（做了什么、测试结果、协议问题、偏离设计的地方及原因）。汇报后直接进入下一阶段，不用等回复。
- 新依赖要锁定确切版本。需要联网时可以用。

## 阶段

### B0 包结构（N1）

- 把 `packages/core` 和 `hosts/node` 合并成 `packages/server`（包名 `@gense/server`），目录按 roadmap-5“包结构”：`platform/ agent/ events/ channels/ plugins/`。`packages/core/src/protocol.ts`、`notes.ts` 现在只是转发，删掉，直接从 `@gense/protocol` 导入。
- 把 `space.ts` 按职责拆开；`UserSpace` 只做组装。
- 根 `package.json` 加 `check:server`：protocol 与 server 的类型检查 + server 的全部测试。`typecheck`、`test`、`dev`、`start`、`passwd`、`Dockerfile`、`Makefile` 跟着改。
- 删除 `drive` 插件条目和其他只为 Cloudflare / Drive 留的代码。
- 行为不变，现有测试全部通过。

### B1 插件注册表与工具清单（N26）

- 每个内置插件一个目录，`definePlugin({ id, name, description, sideEffect, settings, defaultEnabled, issue(config), extension(config), viewTools? })`；`catalog.ts` 按 id 写死的分支消失。
- `plugins` 消息按 `PluginInfo` 发送，`tools` 要填全：名称、说明、`resourceUri`（现在写死在前端 `packages/web/src/plugins/index.ts` 里的那张表搬到各插件的声明里）、`viewOnly`（`ui_photos`、`ui_route`、`artifact_save` 这类只给界面调用的工具）。
- `plugin.tool.set`：逐个开关工具，关掉的不提供给模型。
- `tool.call` 带 `pluginId`：只能调用该插件的工具，走同一套开关检查；去掉 `callTool` 里按名字写死的分支。
- `prefs` / `prefs.set`：称呼与自定义指令，作为提示词的一节。连接建立时发送 `prefs`。
- `trees.search`：按标题与消息内容搜索（pi-durable 自带 search 模块，可用则用），返回 `TreeHit[]`。
- `POST /api/password`：改密码。

### B2 Skills（N24、N25）

- 完整解析 Agent Skills 的 front matter；整个目录保存到 `/data/skills/<name>/`，附带文件原样保留。
- `skill.install`：上传的 zip（可以含多个 Skill），或 Git 地址（可带 `ref`、`path`；浅克隆，在宿主上执行，不带任何凭据，限制大小和文件数，拒绝符号链接和越出目录的路径）。`skill.remove`、`skill.read`。
- `skills` 消息带 `files`、`origin`、`license`、`canInstall`。
- 内置的三个中文名 Skill 保留；安装的 Skill 名按规范校验。

### B3 MCP（N20–N23）

- 官方 `@modelcontextprotocol/sdk` 的 Streamable HTTP 客户端。`mcp.add / update / remove / reconnect / auth`；状态见 `McpServerState`。请求头和 OAuth 令牌用 `Sealer` 加密。
- 工具命名 `mcp__<server>__<tool>`；一个服务器的工具超过阈值（默认 20）时用 pi-durable 的 `deferred` + `tool_search`。
- `resource.read`：读取 `ui://` 资源，返回 `UiResource`（含 `_meta.ui.csp`）。只返回 `text/html;profile=mcp-app`。
- 界面经 `tool.call` 调用工具时只能调用同一个服务器的工具。
- 服务器不可达：`status: 'error'` 并带原因，工具下一轮起不提供；按退避重连，恢复后自动回来。
- OAuth：`mcp.auth` 返回授权地址，回调在 `GET /api/mcp/callback`。

### B4 Trigger、gate、outbox（N1、N4、N6）

- 表 `triggers`、`threads`、`outbox` 与 roadmap-5“事件与 Channel”一致。`Channel` 接口在 `channels/`；现有 `Connection` 成为 `channels/web`。
- 网页的 `send` 先落一条 Trigger（`requestId` = Trigger id）；定时任务、webhook、子 agent 汇报同样由 Trigger 渲染成 `<event>`，不再有独立的 `app.event` 记录。
- gate：每个 Source 一张名单，默认只有所有者。被拒绝的 Trigger 记录原因，不调用模型。
- outbox：与产生它的写入同一事务入队，提交后发送，重试带退避；崩溃后启动时继续；同一 id 不排两次。
- `TreeMeta.source`、`channels` 消息、`channel.set / pair / allow / revoke`、`triggers.list`。

### B5 飞书（N2–N9）

- 官方 `@larksuiteoapi/node-sdk` 的长连接模式。设置项由服务端声明（`ChannelInfo.settings`）：App ID、App Secret、域（飞书 / Lark）、是否流式更新卡片、群聊带入的上下文条数、Bot 人设（textarea）。
- 配对：`channel.pair` 生成一次性短码（10 分钟有效），所有者私聊发给 Bot 后成为 `owner`。
- 私聊：一个持续会话；群聊：只响应 @，按话题（`thread_id`，没有话题时按被回复的根消息）分会话，并把被回复的消息和话题里最近若干条消息作为上下文带入。
- 回答：进行中更新同一张卡片（节流，约每秒一次）；最终回答与文件走 outbox。显示不了的工具界面降级为摘要 + 网页链接（服务器地址来自 `PUBLIC_URL`）。
- 命令 `/new`、`/stop`、`/model`、`/help`。
- 附件进 `attachments/`；助手在工作区生成并在回答里引用的图片、文件发回飞书。
- 测试用本地假的飞书开放平台（HTTP + WebSocket），覆盖 N2–N9。

## 完成后

更新 `docs/design/architecture.md` 描述新的结构，`README.md` 与 `.env.example` 写明新增的配置。

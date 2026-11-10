# Design：单机自部署的个人助手

状态：路线图 5 后端 B0–B5，2026-11-10。当前范围和决定以 [roadmap-5](../plans/roadmap-5.md) 为准；阶段验证及协议问题见 [backend notes](../plans/roadmap-5-backend-notes.md)。不迁移旧版数据库。

## 结构与运行

Node 24 直接运行 TypeScript。`packages/protocol` 是浏览器与后端的固定契约；`packages/server`（`@gense/server`）合并了旧 core 与 Node host；`packages/web` 由前端分支维护。

```text
packages/server/src/
  platform/         配置、SQLite、登录、HTTP、备份、Docker sandbox、文件挂载
  agent/            UserSpace 组装；trees、branches/send、subagents、workspace、ledger、models、credentials、preferences
  events/           自动任务定义、Trigger 存储与恢复、outbox
  channels/         Channel 接口、渠道设置/准入/配对、web Connection、feishu
  plugins/          definePlugin、注册表与设置、builtin/*、mcp/*、skills/*
```

一个进程、一个所有者、一个 SQLite WAL 文件。数据库不能同时由多个服务实例打开。`UserSpace` 组装运行时和按职责拆开的操作；pi-durable 负责模型循环、分叉、子 agent、任务调度及崩溃恢复。

```text
网页 WebSocket ───────────────┐
飞书 / Lark 官方 SDK 长连接 ──┼── Trigger 落库、去重、准入 ──► 会话 / Harness
定时任务 / webhook / 汇报 ───┘                              ├──► 网页 watch / Chord ops
                                                           └──► final + outbox 同一事务 ──► 飞书
```

平台入口是 `platform/main.ts`；WebSocket 连接在 `channels/web.ts`。HTTP 提供静态网页、`/api/login`、`/api/logout`、`/api/me`、`/api/password`、`/api/mcp/callback` 和签名的 `/hooks/<id>`。路径路由回退到网页 app shell。

## 登录、密钥与模型

- 只有所有者密码。PBKDF2-SHA256、600,000 次迭代；登录 cookie 为 HttpOnly / SameSite=Lax，HTTPS 加 Secure。数据库只存会话令牌的哈希；连续失败有速率限制。
- `npm run passwd` 设置密码。`POST /api/password {current,next}` 需有效会话与当前密码；撤销旧会话并给当前浏览器新 cookie。写请求和 WebSocket 握手检查来源。
- `TOKEN_ENCRYPTION_KEY` 通过 Sealer 的 AES-GCM 加密插件密钥、模型凭据、webhook 密钥、MCP headers/OAuth 数据和渠道凭据。密钥不进 sandbox，浏览器只收到已设置的键名。
- 模型来自 `.env` 的 relay（OpenAI Responses）和所有者在页面登录的 pi-ai providers。新会话使用默认模型，分叉可单独切换。`GENSE_FAUX=1` 使用本地流式 faux provider。
- `prefs` 的称呼与自定义指令作为独立提示词节，下一轮读取最新值。`trees.search` 按标题和各分叉的消息文本搜索，通过 pi-durable 公共 transcript API 读取。

## 数据、Trigger 与恢复

```text
<DATA_DIR>/
  gense.sqlite       登录、会话索引、Triggers、threads、outbox、设置、Skills 与 pi-durable
  files/             工作区；agent 看到 /data
  skill-tmp/         Git 安装临时目录，完成/失败后移除
  backups/           每日 SQLite 副本
```

`triggers` 以来源投递 id 为主键，保存来源、线程、actor、原始输入、准入决定、会话和处理结果。网页 requestId 就是 Trigger id，必须全局唯一。被拒绝的输入保留原因，不建立会话、不调用模型。重复投递不覆盖原决定。内部自动任务以 owner 身份准入，外部渠道只接受该渠道名单中的 actor；首次需要配对。

`threads` 将 `(source, thread_key)` 映射到会话；`/new` 改写映射。会话有 `TreeMeta.source`；渠道人设只配置渠道创建的会话。网页继续这棵树时，不向原 IM 发送回答。

自动任务的 `<event>` 由 Trigger 生成，没有独立 events 表。固定协议仍以 `app.event` / `EventData` 标记事件卡片，保留这个显示标记以满足当前契约。重启时补投未提交的输入/事件并恢复渠道运行监视；会话内继续使用相同 requestId 去重。

运行最终结果和 final 消息/文件在同一 SQLite 事务入队，outbox id 唯一。文件在入队时保存字节快照。发送后记录回执；失败按指数退避，启动后继续未完成记录。进行中的卡片更新不走 outbox。原进程结束时没有发送的 final 会在重启后发送。

## 飞书 / Lark

使用官方 `@larksuiteoapi/node-sdk` 的 WSClient 与 Client，不开放公网事件回调。渠道声明设置：App ID、加密的 App Secret、飞书/Lark、流式开关、群上下文条数、Bot 人设。`PUBLIC_URL` 是卡片内网页链接的公开地址，也是 MCP OAuth 回调的基址。

- 所有者在网页生成一次性配对码，十分钟内私聊发送给 Bot。绑定与配对 Trigger 在同一事务落库；码不能重放。其他身份需所有者显式 allow，可 revoke。
- 私聊持续使用同一棵会话树；群聊只响应 @Bot。按 thread_id，或被回复的根消息分会话，携带被回复消息和有限的话题历史。未 @ 或未获准的消息记录拒绝，附件也不会下载。
- `/new`、`/stop`、`/model [provider/id]`、`/help` 不调用模型。命令结果也通过 outbox 投递，未完成的命令启动时恢复。
- 实时读取 `pi.live.generation.message`，约每秒更新同一卡片；保存卡片身份，使 final 可在重启后继续更新。final 等待进行中写入完成，避免旧片段覆盖完整回答。群回复留在原话题。
- 图片、文件与富文本里的图片下载后进入会话 `attachments/`（单附件最大 20 MB）。回答引用的工作区文件保存快照，再上传并发送；图片超过图片接口限制时按文件处理。空文件或超过飞书 30 MB 文件限制时用网页下载卡片降级。
- 工具声明的界面/Artifact 在 IM 中降级为摘要和网页链接；长回答在卡片中截取，完整过程和文件保留在网页会话。

## 插件、MCP 与 Skills

每个内置插件在 `plugins/builtin/<id>/` 声明名称、说明、sideEffect、设置、默认开关、issue、extension、资源 URI 和 view tools。共享注册表生成 PluginInfo。逐工具开关持久化，下一轮更新 Harness 工具集；view-only 工具不提供给模型。界面调用必须指定所属 pluginId，并经过相同开关检查。

MCP 只支持远程 Streamable HTTP，使用官方 TypeScript SDK。每个服务器一个连接，支持分页 tools/list、列表通知、健康检查、退避重连与状态。工具命名 `mcp__<server>__<tool>`；超过默认 20 个时 deferred，通过 pi-durable `tool_search` 按需加载。服务器不可达时不再提供其工具，恢复后自动回来。

OAuth 复用 SDK 的 discovery、动态注册、PKCE、刷新和 issuer 绑定。回调验证十分钟、单次使用的 state；headers、tokens、client registration 和 verifier 均加密。`resource.read` 仅返回本服务器工具声明的 `ui://`、`text/html;profile=mcp-app` 资源及其 `_meta.ui.csp`。独立来源 iframe 的渲染属于前端，本分支只提供协议接口和资源。

Skills 完整解析 YAML front matter，保留附带 scripts/references/assets。上传 ZIP 可含多个 Skill；Git 来源支持 HTTP(S) URL、ref、path 和浅克隆。安装的名称按 Agent Skills 规范校验，三个中文内置名称继续允许。安装前拒绝越界路径、符号链接、特殊文件、重复 ZIP 项和超出大小/数量限制的内容。Git 无宿主凭据、交互提示、全局配置或 hooks，有限时/体积限制，运行在宿主，不在模型 sandbox。

SQLite 保留安装来源、元数据和所有字节；启用的目录投影到 `/data/skills/<name>/`，供模型 read 和 sandbox 的解释器运行脚本。关闭时从模型发现目录移除，仍可通过 skill.read 读取；重新启用或重启时还原。支持安装、删除、读取及逐 Skill 开关。

## 工作区、sandbox 与备份

每棵树的 cwd 为 `/data/sessions/<treeId>`。文件工具直接访问挂载目录，限制在本树工作区；Skills 只读。read/write/edit/delete 使用文件账本，在修改已有文件前必须先读，读后内容改变则拒绝覆盖。

bash 通过宿主 Docker CLI 在隔离容器执行，默认 1 GB 内存、2 CPU、120 秒命令超时，空闲后停止。容器按 files 目录哈希命名，避免不同数据目录互相停止。容器可联网，防火墙拒绝宿主/内网地址，不含宿主密钥。生产镜像带 Git（用于 Skill 安装）和 Docker 客户端；bind mount 的数据路径在容器内外相同。

每日 `VACUUM INTO` 创建完整数据库副本（完成后改名），默认保留七份；`BACKUPS=0` 关闭。恢复时停服，替换 gense.sqlite 并移除旧 WAL/SHM 后启动。

## 验证范围

`npm run check:server` 只检查 protocol/server 类型并运行服务端全部测试，不依赖正在重写的前端。测试使用真实 SQLite、文件、faux 模型和可用的 Docker sandbox；MCP 是本地 JSON-RPC/OAuth HTTP 服务，飞书是本地 HTTP + protobuf WebSocket 服务。包含 SIGKILL 后模型恢复、final outbox 恢复、重复投递、文件与工具完整过程。真实平台凭据与 VPS 部署仍需部署环境验证。

本轮不实现多用户、Ticket/Mandate、GitHub/GitLab Source、内置日历、smail、Drive 或其他 IM。依据见 [roadmap-5](../plans/roadmap-5.md) 和 [ADR-0005](../adr/0005-event-driven-vps.md)。

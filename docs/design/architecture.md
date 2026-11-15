# Design：单机自部署的个人助手

状态：补充至路线图 7 阶段 A、C，2026-11-14。多用户数据边界以 [ADR-0006](../adr/0006-multi-user.md) 为准，路线图 7 功能见 [roadmap-7](../plans/roadmap-7.md)。其余路线图 5 设计及验证保留，见 [roadmap-5](../plans/roadmap-5.md) 和 [backend notes](../plans/roadmap-5-backend-notes.md)。旧单用户布局不自动迁移，可用一次性 `npm run user:import-owner <email>` 导入。
状态：补充至路线图 7 阶段 A / B，2026-11-14。多用户数据边界以 [ADR-0006](../adr/0006-multi-user.md) 为准，记忆、项目、公开分享与临时对话见 [roadmap-7](../plans/roadmap-7.md)。其余路线图 5 设计及验证保留，见 [roadmap-5](../plans/roadmap-5.md) 和 [backend notes](../plans/roadmap-5-backend-notes.md)。旧单用户布局不自动迁移，可用一次性 `npm run user:import-owner <email>` 导入。

## 结构与运行

Node 24 直接运行 TypeScript。`packages/protocol` 是浏览器与后端的固定契约；`packages/server`（`@gense/server`）合并了旧 core 与 Node host；`packages/web` 由前端分支维护。

```text
packages/server/src/
  platform/         配置、SQLite、登录、HTTP、分享快照、备份、Docker sandbox、文件挂载
  agent/            UserSpace 组装；trees、branches/send、subagents、workspace、ledger、models、credentials、preferences、memory、projects
  events/           自动任务定义、Trigger 存储与恢复、outbox
  channels/         Channel 接口、渠道设置/准入/配对、web Connection、feishu
  plugins/          definePlugin、注册表与设置、builtin/*、mcp/*、skills/*
```

一个进程提供多用户服务：全局 `app.sqlite`，每个用户各有 `UserSpace`、`space.sqlite` 和文件目录，SQLite 使用 WAL。一个数据目录不能同时由多个服务实例打开。进程启动时打开全部未停用用户的空间，飞书和定时任务不依赖浏览器登录。`UserSpace` 组装运行时和按职责拆开的操作；pi-durable 负责模型循环、分叉、子 agent、任务调度及崩溃恢复。

```text
网页 WebSocket ───────────────┐
飞书 / Lark 官方 SDK 长连接 ──┼── Trigger 落库、去重、准入 ──► 会话 / Harness
定时任务 / webhook / 汇报 ───┘                              ├──► 网页 watch / Chord ops
                                                           └──► final + outbox 同一事务 ──► 飞书
```

平台入口是 `platform/main.ts`；WebSocket 连接在 `channels/web.ts`，按登录账号路由到对应 `UserSpace`。HTTP 提供静态网页、`/api/register`、`/api/login`、`/api/logout`、`/api/me`、`/api/password`、管理员 `/api/admin/*`、`/api/users/<userId>/mcp/callback` 和签名的 `/hooks/<userId>/<id>`。路径路由回退到网页 app shell。

## 登录、密钥与模型

- 邮箱和密码账号，角色为 admin / user；第一个注册账号是 admin，管理员可关闭注册或停用用户。PBKDF2-SHA256、600,000 次迭代；登录 cookie 为 HttpOnly / SameSite=Lax，HTTPS 加 Secure。`app.sqlite` 只存会话令牌的哈希；连续失败有速率限制。
- `npm run passwd <email>` 设置指定已注册用户的密码，`npm run user:admin <email>` 用于管理员恢复。`POST /api/password {current,next}` 需有效会话与当前密码；只撤销该用户的旧会话并给当前浏览器新 cookie。写请求和 WebSocket 握手检查来源。
- `TOKEN_ENCRYPTION_KEY` 通过 Sealer 的 AES-GCM 加密插件密钥、模型凭据、webhook 密钥、MCP headers/OAuth 数据和渠道凭据（各用户的 `space.sqlite`），以及共享模型密钥（`app.sqlite`）。密钥不进 sandbox，浏览器只收到已设置的键名。
- 模型来自管理员登记的共享提供方和用户自己的 pi-ai providers（BYOK）。共享提供方及按用户记账的用量在 `app.sqlite`，BYOK 凭据在该用户的 `space.sqlite`；共享模型密钥不发给用户。新会话使用默认模型，分叉可单独切换。`GENSE_FAUX=1` 使用本地流式 faux provider。
- `prefs` 的称呼与自定义指令作为独立提示词节，下一轮读取最新值。`trees.search` 按标题和各分叉的消息文本搜索，通过 pi-durable 公共 transcript API 读取。

## 数据、Trigger 与恢复

```text
<DATA_DIR>/
  app.sqlite                       账号、登录会话、共享模型、用量、公开分享快照
  users/<userId>/
    space.sqlite                   会话索引、Triggers、threads、outbox、设置、Skills、记忆、项目、pi-durable
    files/                         仅此用户的文件；该用户的 agent 看到 /data
      sessions/<treeId>/           对话工作区；同树分叉共用
      skills/                      该用户共享的 Skills，agent 只读
      uploads/                     上传暂存区
      projects/<projectId>/        项目资料，agent 只读
    skill-tmp/                     Git 安装临时目录，完成/失败后移除
  backups/app/                     app.sqlite 的每日副本
  backups/users/<userId>/          该用户 space.sqlite 的每日副本（包含停用用户）
```

各用户的数据库和文件目录构成隔离边界；不同用户可以使用相同的 Trigger id、项目名和文件名。`triggers` 在该用户库内以来源投递 id 为主键，保存来源、线程、actor、原始输入、准入决定、会话和处理结果。网页 requestId 就是 Trigger id，须在该 `UserSpace` 内唯一。被拒绝的输入保留原因，不建立会话、不调用模型。重复投递不覆盖原决定。内部自动任务以该空间用户本人的 owner 身份准入，外部渠道只接受该渠道名单中的 actor；首次需要配对。

`threads` 将 `(source, thread_key)` 映射到会话；`/new` 改写映射。会话有 `TreeMeta.source`；渠道人设只配置渠道创建的会话。网页继续这棵树时，不向原 IM 发送回答。

自动任务的 `<event>` 由 Trigger 生成，没有独立 events 表。固定协议仍以 `app.event` / `EventData` 标记事件卡片，保留这个显示标记以满足当前契约。重启时补投未提交的输入/事件并恢复渠道运行监视；会话内继续使用相同 requestId 去重。

运行最终结果和 final 消息/文件在同一 SQLite 事务入队，outbox id 唯一。文件在入队时保存字节快照。发送后记录回执；失败按指数退避，启动后继续未完成记录。进行中的卡片更新不走 outbox。原进程结束时没有发送的 final 会在重启后发送。

## 记忆与项目

`agent/memory.ts` 管理用户 `space.sqlite` 中的 `memories(id, text, source, treeId, projectId, enabled, createdAt, updatedAt)`；`preferences` 保存 `useMemory` 和 `memoryWrites`。每用户最多 200 条，每条最多 500 字符；写入串行校验容量并拒绝疑似密码、密钥、证件号和卡号。变化向该用户全部网页连接推送，网页与飞书模型调用读取同一份数据。

`agent/projects.ts` 管理同库的 `projects(id, name, color, instructions, createdAt, updatedAt)`；`trees.projectId` 保存整棵对话树的归属。项目资料从 uploads 移到 `users/<userId>/files/projects/<projectId>/`，模型中的路径为 `/data/projects/<projectId>/`；单文件最多 20 MB，一个项目总量最多 200 MB。删除项目时可删除所属对话及其工作区，或保留对话并移出项目；两种方式都删除项目文件和项目记忆。

系统提示词靠后的 `memory` 和 `project` 节由 `agent/memory-prompt.ts` 的原文函数生成，每轮读取当前数据。记忆只包含启用的全局条目及当前项目条目，按更新时间优先并限制条目文本预算为 8000 字符；关闭参考记忆也会移除 `memory` 工具。项目节包含当前指令和资料清单，移入/移出、修改指令和分叉都在后续轮次生效，不在首条用户消息里保存项目指令。

## DeepSeek App API

共享提供方在 `app.sqlite.shared_providers.kind` 区分 OpenAI 兼容与 DeepSeek。DeepSeek 地址和模型列表留空时使用协议默认值；共享及 BYOK 都由 `agent/deepseek.ts` 创建 Messages 提供方，只有 `DEEPSEEK_APP_MODELS` 中的模型启用 App 扩展，其余按普通 Messages 调用。共享模型强制 high 安全检查，BYOK 按用户偏好选择 high/low；推理强度映射为 low/high/max，未指定时采用服务端默认。侧调用不加入原生工具或标题。

每轮请求读取插件开关与本轮 @web：联网时仅提供 DeepSeek 的搜索和读链接工具，并移除 web 插件的普通工具和指引；仅有用户链接时只提供读链接。pi-ai 的供应商事件观察器组装步骤、结果、引用与原始块，fetch 流观察器补读 SDK 提前抛出的错误用量。进行中的 NativeTrace 最多每 250 ms 推送一次，只发给 watch 对应分支的网页连接。

GenerationTask 的事务包装在 `pi.assistant` 后紧接着保存 `app.native`，其中有 NativeTrace、原始 blocks（含 kind/signature）和 responseId。助手模型记录也保留回放元数据；`app.native` 自身没有 model 内容，不进入提示词。回放只恢复当前上下文中、相同提供方/API/模型的原始块：重启和分叉可恢复读链接签名，换模型/提供方不会携带旧签名，压缩舍弃的历史也不会重新注入。分叉内部继承到相邻 `app.native`，对外 forkEntryId 和版本分组仍使用助手 id；编辑、重生成遵循同一边界。

终态 refusal 及输入 400 Content Exists Risk 都清空回答正文、思考和待执行的客户端工具，以正常 stop 保存并记用量。飞书等外部渠道等待原生回答终态后才发布正文，拒答使用固定说明。首轮默认标题可由同次回答返回的 title 更新；`space.sqlite.deepseek_titles(treeId, manual)` 保护手动命名，包括与首句相同的命名。

`agent/attachments.ts` 在发送前本地提取 Office/PDF 文本；扫描件、旧格式或非视觉模型的图片，使用任一有 key 的共享 DeepSeek 提供方调用独立 OCR。清理定位标记后写到原路径加 `.txt`，附件说明记录原路径、文本路径、text/ocr 和页数。`space.sqlite.attachment_parses(path, digest, how, pages)` 按原件 SHA-256 缓存，重启复用；解析失败仍发送原文件。OCR 同步等待，最长 180 秒，实际延迟待有 key 后评估。删除对话一并清理其解析索引、手动标题标记和内存进度。Files API 的解析结果不能下载，本轮不使用它做跨模型附件转换。

`platform/speech.ts` 提供登录后的 GET `/api/speech` 和 POST `/api/speech/asr`、`/api/speech/tts`，只使用共享凭据；每用户每分钟最多 20 次写请求。ASR 接受 16-bit PCM WAV / Ogg Opus，限制 8 MiB、120 秒；TTS 限制 4000 个 Unicode 字符，开启 filter_markdown，将 HTTP WAV 响应体带背压地流式转发。浏览器不接触服务端 key。

`app.sqlite.usage` 保存模型 token、searches/fetches 和 modelCalls：原生工具使用最终 tool_search + tool_image_search / tool_fetch，而非展示次数。独立 web Search/Fetch 成功且非空时记在共享 DeepSeek 的 web-tools 行，modelCalls 为 0；只有插件 key 时落在 deepseek-tools/BYOK 行。`service_usage(userId, day, service, calls, units)` 只记录 OCR 页数、ASR 向上取整秒数、TTS 计费字符（汉字×2），不重复计算联网。管理员 `/api/admin/usage` 与个人 `/api/usage` 返回 UsageReport，按 UTC 日期筛选，个人接口的两组数据都限定当前用户。

实现依据见 [DeepSeek 调研](../research/deepseek-app-api.md)。测试使用自拟 SSE 经真实 SDK、SQLite、HTTP/WebSocket 和飞书本地平台；尚未用真实 key 验证上游字段组合、签名接受、拒答时机、识别/合成质量、延迟或账单。
## 公开分享与临时对话

`platform/shares.ts` 在全局 `app.sqlite` 保存 `shares(token, userId, treeId, title, snapshot, turns, createdAt, updatedAt)`。网页端构造选定分支的只读快照，包含问答、允许公开的内置界面和内联图片，去掉思考、工具细节、工作区文件和 MCP Apps；服务端用 TypeBox 校验结构，限制 JSON 为 8 MB / 500 轮、标题 200 字符、图片为 PNG/JPEG/WebP/GIF base64 data URL，不解释正文或界面输入的语义。token 为 16 随机字节的 base64url；更新快照保持 token，后续对话不会自动进入已分享内容。

分享创建、更新、撤销和删除对话在所属用户的队列中校验归属，变更向该用户所有连接推送 `ShareInfo[]`。删除对话时撤销它的全部链接。公开 `GET /api/share/:token` 直接读全局库，不解析 cookie、不要求登录，只返回快照和 updatedAt；不存在或已撤销为 404。响应为 JSON，带 noindex / no-store；`/s/:token` 返回网页入口，带 noindex / no-referrer。公开读取每个客户端 IP 每分钟最多 60 次。`GENSE_TRUST_PROXY` 默认关闭，使用 socket IP；在会追加客户端地址的反向代理后开启时取 X-Forwarded-For 最右侧的有效 IP，无效则回退到 socket IP。生产 Caddy Compose 开启，直连的开发 Compose 关闭。

临时对话在用户 `space.sqlite` 的 `trees.expiresAt` 中记录创建时间加 24 小时。`trees` 推送仍包含 `temporary: { expiresAt }` 以便客户端打开，网页负责在导航等列表中隐藏，服务端搜索排除。它不能放进项目、分享、创建定时任务或 Webhook，也不能作为记忆写入的来源。`agent/temporary.ts` 在创建根对话和空分支时持久化禁用 memory 工具，普通分叉继承；memoryContext 不生成记忆节。

网页离开时请求 tree.delete；服务器还在启动恢复前及每 10 分钟清理一次到期树。清理会中止运行、移除业务索引和工作区、撤销链接、推送列表并停止现有 watch。**删除语义的已知缺口：普通与临时 tree.delete 均未物理擦除 pi-durable 的底层 pi_* 对话和条目；它们仍可能保留在 space.sqlite 及其备份中。** 本轮采用现有删除语义，不直接修改活动 Harness 的内部表；业务内容接口在删除后不能再访问该树，用量计数保留。资料库与导出的回归探测在这些接口上线后会检查实际列表及 ZIP，不包含临时内容。

## 飞书 / Lark

使用官方 `@larksuiteoapi/node-sdk` 的 WSClient 与 Client，不开放公网事件回调。渠道声明设置：App ID、加密的 App Secret、飞书/Lark、流式开关、群上下文条数、Bot 人设。`PUBLIC_URL` 是卡片内网页链接的公开地址，也是 MCP OAuth 回调的基址。

- 每个用户在自己的空间配置自己的 Bot，在网页生成一次性配对码，十分钟内私聊发送给 Bot。绑定与配对 Trigger 在同一事务落库；码不能重放。其他身份需该用户显式 allow，可 revoke。
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

每棵树的 cwd 为 `/data/sessions/<treeId>`，对应当前用户的 `files/sessions/<treeId>/`。文件工具直接访问挂载目录，只修改本树工作区；该用户的 Skills 和当前项目资料只读。read/write/edit/delete 使用文件账本，在修改已有文件前必须先读，读后内容改变则拒绝覆盖。

bash 通过宿主 Docker CLI 在隔离容器执行，默认 1 GB 内存、2 CPU、120 秒命令超时，空闲后停止。每用户一个容器，按数据目录哈希加用户 id 命名，只挂载该用户的 files，避免不同数据目录和用户互相影响。`projects/` 整体只读挂载，read 工具和文件面板限当前项目，write/edit/delete 不允许修改项目资料；bash 可以读取同用户其他项目，这是单用户容器的已接受取舍。容器可联网，防火墙拒绝宿主/内网地址，不含宿主密钥。生产镜像带 Git（用于 Skill 安装）和 Docker 客户端；bind mount 的数据路径在容器内外相同。

每日为 `app.sqlite` 和每个用户的 `space.sqlite`（包括停用用户）用 `VACUUM INTO` 创建完整副本（完成后改名），默认保留七份；`BACKUPS=0` 关闭。恢复时停服，替换对应的 app.sqlite / space.sqlite 并移除它的旧 WAL/SHM 后启动；文件目录需要另行保留或恢复。

## 验证范围

`npm run check:server` 只检查 protocol/server 类型并运行服务端全部测试，不依赖正在重写的前端。测试使用真实 SQLite、文件、faux 模型和可用的 Docker sandbox；MCP 是本地 JSON-RPC/OAuth HTTP 服务，飞书是本地 HTTP + protobuf WebSocket 服务。包含 SIGKILL 后模型恢复、final outbox 恢复、重复投递、文件与工具完整过程。真实平台凭据与 VPS 部署仍需部署环境验证。

多用户已按 [ADR-0006](../adr/0006-multi-user.md) 实现。不实现 Ticket/Mandate、GitHub/GitLab Source、内置日历、smail、Drive 或其他 IM；其余范围依据仍见 [roadmap-5](../plans/roadmap-5.md) 和 [ADR-0005](../adr/0005-event-driven-vps.md)。

# 路线图 7：后端任务

读者：实现后端的 agent。先读 [roadmap-7.md](roadmap-7.md)（Intent、Spec、Design、决定）、`AGENTS.md` 和 [roadmap-6.md](roadmap-6.md) 的 A8–A11（提示词快照与写法）。

## 边界

- 你只改 `packages/server`、根目录的构建 / 部署文件，以及 `docs/design/architecture.md` 和本文件末尾的“汇报”一节。**不要改 `packages/web`。**
- **`packages/protocol` 是契约，由前端一方（Claude）维护。** 按它实现。缺字段、有歧义或做不到时不要自己改：写进本文件“协议问题”一节并在汇报里说明，阻塞时用最接近的做法继续。
- **模型看到的文字由 Claude 写**：`packages/server/src/agent/memory-prompt.ts`。照用其中的工具说明、参数说明和两节提示词；需要改措辞时同样记进“协议问题”，不要自行改写。把参数说明翻成 TypeBox schema 时原文照搬。
- 不需要兼容旧数据和旧接口。
- 测试按 Spec 编号（A1…）写，走真实的 SQLite、文件、沙箱和 faux 模型；不要写只验证 mock 的测试。改了提示词就 `UPDATE_SNAPSHOT=1` 更新 `test/prompt.snapshot.md`。
- 每个小阶段一个提交，消息格式 `feat/r7-a-<slug>: content`，不要 push。每个小阶段结束：`npm run check:server` 通过，然后用 `hc send` 汇报（做了什么、测试结果、协议问题、偏离设计之处及原因），接着做下一阶段，不用等回复。
- 不要启动其他 agent。

## 阶段 A：记忆与项目

### A-1 记忆

- `space.sqlite` 新表 `memories`，字段同协议的 `Memory`。限制见 `MEMORY_LIMITS`：超出条数时 `memory.add` 报错“记忆已满（200 条），请先删除一些”。
- 请求 `memory.add` / `memory.update` / `memory.remove`，每次变化后向该用户的全部连接推送 `memories`；连接建立时推送一次。
- `Preferences` 加 `useMemory`（默认 true）、`memoryWrites`（默认 `auto`），`prefs.set` 校验。
- 系统提示词新增一节 `memory`，内容 = `memorySection(entries, projectId)`；`useMemory` 为 false 或对话是临时对话（阶段 B 才有，先留判断位置）时整节不出现。这一节放在 preferences 之后、按对话变化的位置，不影响前面的缓存。
- 工具 `memory`（`MEMORY_TOOL`），`useMemory` 为 false 时不提供。说明末尾按 `memoryWrites` 拼上 `MEMORY_AUTO` 或 `MEMORY_EXPLICIT_ONLY`。`scope=project` 而对话不在项目里时按 global 处理。结果的 `details` 是 `MemoryToolDetails`；`content` 是一句给模型看的英文确认。
- 拒绝敏感内容（A4）：一个简单的检测（看起来像 API key / 私钥 / 11 位以上连续数字的卡号或证件号 / “密码是…”），命中则工具返回错误，不写入。
- 网页和飞书的对话都生效（同一个 UserSpace）。

### A-2 项目

- `space.sqlite` 新表 `projects`（同协议 `Project`）；`trees` 加 `projectId`，`TreeMeta.projectId` 随 `trees` 推送。
- `tree.create { projectId }`、`tree.update { projectId }`（null = 移出）；`project.create` / `update` / `delete`（`deleteChats` 决定删对话还是移出；同时删除项目文件和 `projectId` 等于它的记忆）。变化后推送 `projects`（以及受影响的 `trees`、`memories`）。
- 项目文件存在用户的 `files/projects/<projectId>/`，沙箱以只读方式挂载到 `projectDir(projectId)`——只给属于该项目的对话挂载（若沙箱按用户一个容器、无法按对话挂载，就挂载整个 `projects/` 但在工具层面拒绝访问别的项目，并在汇报里说明取舍）。`project.files.list/add/delete/read`；`add` 从 uploads 移入，超过 `PROJECT_LIMITS.files` 报错。
- 系统提示词新增一节 `project`，内容 = `projectSection(project, files)`，只在项目里的对话出现；项目指令修改后下一轮即生效。
- 删除浏览器端塞首条消息的旧做法不归你管（前端会去掉）。

### A-3 收尾

- 提示词快照：加一个“项目里的对话、有 2 条记忆、有 1 个项目文件”的场景。
- `docs/design/architecture.md` 补上记忆和项目的数据位置。

## 阶段 B：公开分享与临时对话

协议见 `packages/protocol/src/share.ts` 和 `index.ts` 里的 `share.*`、`shares`、`TreeMeta.temporary`、`tree.create { temporary }`。提交消息用 `feat/r7-b-<slug>`。

### B-1 分享链接

- 快照由网页端构造（它已经有渲染模型），服务器**原样保存、不解析内容语义**，只做校验：TypeBox 校验 `ShareSnapshot` 结构；JSON 大小 ≤ `SHARE_LIMITS.bytes`、轮数 ≤ `turns`、标题截断到 `title`；`image.src` 必须以 `data:image/(png|jpeg|webp|gif);base64,` 开头。不合格就拒绝并说明原因。
- `app.sqlite` 新表 `shares(token PRIMARY KEY, userId, treeId, title, snapshot TEXT, turns, createdAt, updatedAt)`——放全局库，这样未登录请求按 token 一次查到。token 用 `crypto.randomBytes(16)` 的 base64url（B4，128 bit）。
- `share.create`：树必须属于该用户且不是临时对话，返回 `ShareInfo`。`share.update`：只能改自己的 token，换快照、更新 `updatedAt`，token 不变。`share.delete`：删除。三者之后向该用户全部连接推送 `shares`；连接建立时推送一次。删除对话（`tree.delete`，包括临时对话到期）时一并删除它的链接。
- `GET /api/share/:token` → `SharedPage`（`{ ...snapshot, updatedAt }`）；不存在返回 404。**不读 cookie、不需要登录**；响应头 `X-Robots-Tag: noindex`、`Cache-Control: no-store`、`Content-Type: application/json`。按 IP 简单限流即可（例如每分钟 60 次）。
- 页面 `GET /s/:token`：返回 `index.html`（网页端自己渲染），同样加 `X-Robots-Tag: noindex` 和 `Referrer-Policy: no-referrer`。

### B-2 临时对话

- `tree.create { temporary: true }`：在 `trees` 表记 `expiresAt = now + TEMPORARY_TTL_MS`，`TreeMeta.temporary = { expiresAt }`。同时带 `projectId` 报错“临时对话不能放进项目”。
- 照常出现在推送的 `trees` 里（网页端负责隐藏）；`trees.search` 不返回它。
- 提示词与工具：临时对话里没有 `memory` 一节，也不提供 `memory` 工具（A-1 留的判断位置）。
- 拒绝：`tree.update { projectId }`、`share.create`、`schedule.create`、`webhook.create` 作用于临时对话时报错。
- 寿命（B6）：网页离开临时对话时会发 `tree.delete`；服务器另外每 10 分钟（以及启动时）删除所有 `expiresAt` 已过的临时对话，连同工作区和分享（应当没有），并推送 `trees`。删除时若正在运行，先中止。
- 飞书渠道不会产生临时对话，不用管。

### B-3 收尾

- 测试按 B1–B6：真实 SQLite 和 HTTP（未登录访问 `/api/share/:token`、撤销后 404、他人 token 不能 update/delete、超限拒绝、临时对话不进搜索、没有记忆一节、到期清理）。
- 提示词快照加一个“临时对话”场景（应当没有 memory 一节）。
- `docs/design/architecture.md` 补上 `shares` 表和临时对话的清理。

## 阶段 C：DeepSeek App API

先读调研 `docs/research/deepseek-app-api.md`（尤其 §5 pi-ai 审计、§7 风险）。协议见 `packages/protocol/src/deepseek.ts`、`accounts.ts` 的 `ProviderKind` / `UsageReport`、`index.ts` 的 `Preferences.deepseekSafety` 和 `native` 推送。提交消息用 `feat/r7-c-<slug>`。

**没有真实 key。** 实现按官方文档，测试用录下来的 SSE 样本（按调研 §1.3 的块结构自拟，放 `test/fixtures/deepseek/`）走真实的解析、持久化和回放代码，不要只测 mock。真实 API 的验收（调研 §7.3）等用户提供 key 后由 Claude 另做，你在汇报里列出“未实测”的路径。

### C-1 提供方

- `shared_providers` 加 `kind`。`deepseek`：`baseUrl` 为空时用 `DEEPSEEK_BASE_URL`，`modelIds` 为空时用 `deepseek-flash`、`deepseek-v4-pro`。BYOK 的内置 deepseek 提供方同样换成 C-2 的实现（调研 §5.1 末段）。
- App 扩展只给 `DEEPSEEK_APP_MODELS` 里的模型；其他 DeepSeek 模型照普通 Messages（或现有方式）走，不发 App 字段。按提供方类型判断，不要按 providerId 字符串（共享的是 `shared-<uuid>`）。

### C-2 Messages 包装（`agent/deepseek.ts`）

按调研 §5.2 的 1–7 实现，要点：
- `onPayload`：`safety_check: { level: 'high' }`（共享提供方总是；BYOK 看 `prefs.deepseekSafety !== false`）；首轮且标题仍是默认值时 `title: { enabled: true }`；思考按 `effort`：未给 → 不发（服务器默认）、`low` → `thinking: enabled` + `output_config.effort: low`、`medium` → `high`、`high` → `max`。压缩、追问（D-2）等侧调用不加原生工具和标题。
- 联网：本轮消息 @ 了 `web` 插件（网页端“联网搜索”开关就是这个）**或**该用户启用了 web 插件时，加 `deepseek_web_search` 和 `deepseek_read_url`；此时本轮**不**提供 web 插件自己的 search/fetch 工具，也不出现它的提示词指引，避免重复联网。用户消息里有链接而未开联网时，只加 `deepseek_read_url`（C3）。
- 观察原生事件，组装 `NativeTrace`：每个 `server_tool_use` → `NativeStep`（running），对应结果块到达 → done/failed + results（`site_name`→`site`、`site_icon`→`icon`、`page_age`/`published_at`→`publishedAt`）；`citations_delta` → `citations`（按 URL 去重）。每次变化向 watch 该分支的连接推送 `native`（节流到 ≤ 4 次/秒）。
- 助手消息保存后，紧接着写一条 `NATIVE_KIND` 条目（data = `NativeTrace`，模型看不到）；没有任何原生步骤和引用时不写。原生块原文（含 `signature`、`kind`）由你自己存（同一条目的额外字段或旁表都行），下一轮 `onPayload` 据此重建 assistant content，保证读过的链接还在上下文（调研 §7.2-1：覆盖第二轮、分支、重启、压缩、换模型）。
- 拒答（C4）：`stop_reason: refusal` 时把已保存的助手消息清成空正文、无思考、无待执行的工具调用，`stopReason` 记为 `stop`（不是 error），`NativeTrace.refusal = true`。用量照记。飞书渠道：拒答时发一句固定说明“这个问题我没法回答。”而不是空消息。输入直接 400 `Content Exists Risk` 时同样按拒答处理。
- 标题（C5）：`message_delta.title` 有值、且树标题仍是默认或首句截取（用户没改过）时，用它更新树标题并推送 `trees`。
- 错误帧的用量（调研 §5.1 末段“重要例外”）：用 fetch 包装读出，记进 ledger。

### C-3 附件解析（C6）

- 发送时，附件若是模型读不了的类型（扫描版 PDF：本地解析出的文字过少；`.doc/.ppt` 等本地解析器不支持的 Office；图片而模型不支持图片输入），且服务器配置了 DeepSeek（任一共享 deepseek 提供方有 key），调用 `/v1/tools/ocr`（`text_recognition`）把文字写到 `<path>.txt`，附件说明里这一行写成 `<path> -> <path>.txt (ocr, N pages)`（本地解析成功的写 `(text)`，不带页数）。清掉 `<｜ref｜>`、`<｜box｜>` 标记和坐标。
- 改 `notes.ts` 的 `attachmentsText` / `parseNote` 让这种行可往返（`parseNote` 返回 `ParsedAttachment`）——这是协议文件，**由我改**；你在汇报里说你需要的确切格式，先在 server 里用同样的规则写。
- OCR 失败就照旧只给原文件路径，不阻塞发送。用量记 `ocr`，units = 成功页数。

### C-4 听写与朗读（C7）

- `GET /api/speech` → `SpeechCapabilities`（有共享 deepseek 提供方且有 key 即为 true）。`POST /api/speech/asr`、`POST /api/speech/tts` 见协议注释；都要登录，按用户限流（例如每分钟 20 次）。浏览器不直接连 DeepSeek。
- TTS 用 HTTP 整段接口，`filter_markdown: true`，把 DeepSeek 的响应体流式转发给浏览器；文本超过 `TTS_MAX_CHARS` 报 413。
- 用量：`asr` units = 秒（向上取整），`tts` units = 计费字符（汉字 ×2）。

### C-5 记账（C8）

- `usage` 表加 `searches`、`fetches`：从 `server_tool_use` 的 `tool_search + tool_image_search`、`tool_fetch` 取最终值（不是 `web_search_requests`）。web 插件调用独立 Search / Fetch 成功且非空时也记一次（provider 记为该共享 deepseek 提供方）。
- 新表 `service_usage(userId, day, service, calls, units)`，对应 `ServiceUsageSummary`。
- `GET /api/admin/usage` 改为返回 `UsageReport`；D-6 的 `GET /api/usage` 也返回 `UsageReport`（只含自己）。

### C-6 收尾

- 测试：原生块的解析 / 持久化 / 重启后回放（signature 回到第二轮请求里）、拒答清空、标题不覆盖用户重命名、联网时 web 插件工具不出现、OCR 失败不阻塞、speech 接口鉴权与超限、用量两组数字。
- 提示词快照：DeepSeek 模型开联网时的工具列表场景。
- `docs/design/architecture.md` 补 DeepSeek 一节。

## 阶段 D：其余预览功能

协议见 `packages/protocol/src/activity.ts` 和 `index.ts` 里的 `feedback.*`、`inbox.read`、`library.list`、`export.*`、`Preferences.suggestions` 以及对应的推送。提交消息用 `feat/r7-d-<slug>`。

### D-1 反馈

- `space.sqlite` 新表 `feedback(treeId, turnId, value, reasons JSON, comment, model, updatedAt, PRIMARY KEY(treeId, turnId))`。`feedback.set` 校验：树属于该用户；`reasons`、`comment` 只在 `down` 时保存（`up` 时丢弃）；`comment` 截断到 500 字；`value: null` 删除该行。
- `model` 由服务器填：该轮回答的 assistant 消息的 `provider:model`（找不到就留空）。
- 推送 `feedback`：watch 一棵树时发一次（即使为空），每次 `feedback.set` 后发给该用户全部连接。
- 后台统计：同时在 `app.sqlite` 记一行（`userId, day, model, value, reasons`，按 `userId+treeId+turnId` 唯一，改值时覆盖），`GET /api/admin/feedback?from&to` 返回 `FeedbackSummary[]`（只有管理员）。删除对话不必回删统计。

### D-2 追问建议

- 提示词在 `packages/server/src/agent/suggest-prompt.ts`（Claude 写）：`SUGGEST_SYSTEM`、`suggestInput`、`parseSuggestions`，照用。
- 时机：主分支一轮回答成功结束、且 `prefs.suggestions !== false` 时，在后台做一次侧调用（不进对话历史、不带工具），用回答这一轮的同一个模型和凭据，`maxTokens` 约 300、关掉 thinking/reasoning。用量照常记进 ledger。失败、超时（20 秒）或解析为空都不推送。
- 只保留每棵树最新一轮的结果（内存或 `space.sqlite` 一行都行）；新一轮开始时清掉。推送 `suggestions`：生成后发给该用户全部连接；watch 时若有就发一次。
- 临时对话照样生成；飞书渠道不生成。
- 阶段 C 接入 DeepSeek App API 后若能随回答一起拿到追问，再改为直接用它，那时另说。

### D-3 收件箱已读

- `space.sqlite` 新表 `inbox_read(id PRIMARY KEY, readAt)`，只保留最新 `INBOX_READ_KEPT` 条。`inbox.read { ids }` 合并写入（每个 id 截断到 200 字符，单次最多 500 个），之后向全部连接推送 `inboxRead`；连接建立时推送一次。
- id 由网页端生成，服务器不解析。（与 roadmap 原文“未读数由服务器给出”略有不同：服务器只存已读集合，未读数由网页端按它算，这样服务器不需要知道收件箱里有什么。）

### D-4 资料库

- `library.list` 返回 `LibraryPage`：遍历该用户全部非临时对话的工作区和全部项目文件（不含 skills 等只读挂载、隐藏文件和 `node_modules` 之类的目录），按 `mtime` 降序。`kind` 按协议的 `fileKind` 过滤；`query` 对文件名做不区分大小写的子串匹配；`limit` 默认 50、最大 200；`cursor` 是不透明字符串（例如 `mtime:path` 编码）。
- 文件很多时不要每次全量扫描：可以缓存每个工作区的列表、按目录 mtime 失效，做法你定，在汇报里说明。

### D-5 导出

- `export.create`：同一用户已有 `running` 的就报错“已有一个导出在进行”。立即返回 `ExportInfo`（`running`），后台生成 zip 放到 `files/exports/<id>.zip`：
  - `conversations/<日期>-<标题>/conversation.md`：主分支的问答（用户消息、回答正文；工具调用只写一行名字）；同目录 `files/` 放该对话工作区文件。
  - `projects/<名字>/`：`project.json`（指令等）和文件；`memories.json`；`preferences.json`。
  - 不含临时对话、凭据、API key。
- 完成或失败后更新状态并推送 `exports`；只保留最近 3 个（删多余的文件）。`export.delete` 删记录和文件。连接建立时推送一次。
- `GET /api/exports/:id`：需要登录且属于该用户，`Content-Disposition: attachment; filename="gense-export-<日期>.zip"`。
- 网页端会把完成的导出显示在收件箱里，服务器不用另做收件箱消息。

### D-6 用量

- `GET /api/usage?from&to`：返回 `UsageReport`（见 C-5），与 `/api/admin/usage` 同一查询，但只限当前登录用户；普通用户可访问。若先于 C 做，`services` 先返回空数组。

### D-7 收尾

- 测试按 D1–D6：真实 SQLite、文件和 HTTP（反馈改值和清除、他人树拒绝、admin 汇总；faux 模型返回 JSON 和乱码时的追问；已读截断到 500；资料库分页、按类型、搜索、不含临时对话；导出 zip 的目录结构和内容、并发拒绝、他人下载 403/404；用量只含自己）。
- 提示词快照加追问侧调用一节（`SUGGEST_SYSTEM` + 一个 `suggestInput` 示例）。
- `docs/design/architecture.md` 补上新表、导出文件位置和追问的侧调用。

## 汇报

### A-1 记忆（2026-11-14）

- `space.sqlite` 新增 `memories`，提供增删改、来源与会话关联、开关、200 条 / 每条 500 字符限制；同用户全部连接首次和变化时推送，其他用户隔离。偏好默认 `useMemory: true`、`memoryWrites: auto`，请求校验并持久化。
- 每轮通过原样的 `memorySection` 渲染靠后的记忆节，按偏好提供 `MEMORY_TOOL` 并拼接原文写入说明。工具返回英文确认及 `MemoryToolDetails`，更新/删除的撤销值与写操作串行取得；拒绝疑似密钥、私钥、长数字和密码。
- A1–A6 / A11 测试覆盖真实 SQLite、双设备 WebSocket、双用户、重启、faux 工具结果、上限和敏感内容，以及真实飞书 SDK 对本地 HTTP / protobuf WebSocket 平台的收发；基础提示词快照已更新。
- 适配 faux 模型：动态提示词可能在工具结果后插入 system 消息，脚本改为从最后一条非 system 消息识别结果，避免重复执行工具。临时对话的禁用判断留在公共会话查询位置，阶段 B 接入。
- 验证：`env -u https_proxy -u http_proxy -u all_proxy -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY npm run check:server` 通过，80 项测试全部通过（含真实 Docker 与本地飞书平台），无跳过。

### A-2 项目（2026-11-14）

- `space.sqlite` 新增 `projects` 与 `trees.projectId`，接通项目增改删和首次/变化广播；`tree.create`、`tree.update` 支持项目归属及移出，分叉始终随树读取。创建/移动与删除串行，避免对话落入正在删除的项目。
- 项目资料在 `files/projects/<projectId>/`，提供 list/add/delete/read。上传文件按原名移入，重名保留两份；批量先校验实际文件大小、20 MB 单文件及 200 MB 总量，再执行移动，出错时回移已移动的文件。并发新增共用队列，避免超过总量。
- 使用原样 `projectSection`，项目指令和文件清单每轮读取；记忆现在校验项目存在并按作用域过滤，默认项目记忆和显式全局记忆都已验证。`treeId` 按协议可选，保留提供的来源（包含撤销恢复的 `model`）。
- 删除项目可保留并移出对话，或终止并删除其对话和工作区；两种方式都删除项目文件与项目记忆，并推送受影响的 trees/memories/projects。
- 沙箱取舍按 t4h 确认：每用户一个容器，整个 `/data/projects` 只读挂载；read/write/edit/delete 与文件面板只读取当前项目，项目资料不可由文件工具修改。bash 可以读取同用户其他项目；不增加容器。
- 验证：清除代理后 `npm run check:server` 通过，84 项全部通过，无跳过。新增验证涵盖双设备/双用户、重启、删除两种选项、分叉与移入移出、真实稀疏文件的容量/并发限制、真实 Docker 的挂载只读及工具访问范围；飞书已验证从网页移入项目后也带指令与项目记忆。
- 内部 API 调整：`UserSpace.createTree(projectId?, ctx?)`，原有无参数调用不变；显式传 Context 的调用方应使用第二个参数。无其他协议改动。

### A-3 收尾（2026-11-14）

- 提示词快照新增“Research 项目对话、两条记忆（全局 / 项目各一）、一个项目文件”的场景。测试使用真实 SQLite 和文件，固定条目 id；对比两个真实模型请求，断言其余提示词节与工具完全相同，快照只追加有变化的 memory / project 两节，避免重复基础内容。`memory-prompt.ts` 原文未改。
- `docs/design/architecture.md` 新增记忆与项目的数据表、文件位置、限额、动态提示词和删除行为。按 t4h 明确授权，同时校正与旧单所有者布局相关的段落：状态和结构说明、HTTP / WebSocket 路由、登录/密钥/模型来源、数据目录与 Trigger id 范围、飞书所属用户、工作区/沙箱/备份、验证范围的多用户排除项；其他路线图 5 内容保留。
- 验证：`UPDATE_SNAPSHOT=1` 的提示词单测通过。首次完整并行检查受机器高负载影响，84 项中仅现有 R51/R52/R56 的 spawn-answer 等待超时；没有改断言或超时。用 `taskset -c 0 env -u https_proxy -u http_proxy -u all_proxy -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY npm run check:server` 降低本任务并发后，84 项全部通过，无跳过，包含真实 Docker 与本地飞书平台。
- 无新的协议问题或设计偏离。阶段 A 完成，按 t4h 指示停下，等待合并和阶段 B 的任务。

- C-1（2026-11-14）：共享提供方持久化 kind，DeepSeek 的空地址/模型列表使用官方默认；共享及 BYOK DeepSeek 改用 Messages 工厂，能力按模型白名单及提供方类型判断。新增真实 SQLite 重新打开、加密凭据、BYOK 登录及刷新测试，旧共享模型测试按新契约显式发送 kind。`npm run check:server` 通过。原生请求字段和流处理留在 C-2；未进行真实 DeepSeek 请求，无协议偏离。

- C-2（2026-11-14）：已基于 `feat/r7-int` 集成 A。Messages 包装保留原生块、引用与签名，按提供方/模型/上下文回放；`app.native` 与助手条目同事务相邻保存，提供分支范围的节流推送。共享安全强制 high、BYOK 可关；拒答清空正文/思考/客户端调用并正常结束，飞书等待终态后使用固定拒答说明；手动改标题有持久标记。SSE error 和输入 400 的用量从 fetch 包装补齐。原生 5 项测试覆盖本地 HTTP→真实 SDK→SQLite、重启、分叉、两种拒答、错误用量、标题竞争和侧调用。清除代理并用 `taskset -c 0` 跑 `npm run check:server`，90 项全部通过；先前一次高负载运行仅旧 V6 短等待超时，未改测试。无真实 API 验证；压缩/跨模型及协议推送的额外验收留 C-6。

- C-3（2026-11-14）：已基于 `19feb91` 集成版本接通发送前附件解析。本地支持的 Office/PDF 写相邻 `.txt`；PDF 有效文字少于 32 字符、旧 DOC/PPT 或非视觉模型的图片，使用共享 DeepSeek 的独立 OCR，去除 ref/box 与坐标；失败保留原路径继续发送。按原件哈希在 `space.sqlite.attachment_parses` 缓存，重启复用，不重复收费；OCR 成功页数写 `app.sqlite.service_usage`。因此服务用量的基础表/写入先在 C-3 落地，C-5 再补全统计接口与联网计账。附件协议直接使用 t4h 的 `9e08e9f`：`path -> path.txt (text)` / `path -> path.txt (ocr, N pages)`；未修改 protocol。新增真实文件、SQLite 重开和 multipart HTTP 测试，OCR 错误、无视觉图片、页数和缓存均覆盖。清代理且 `taskset -c 0-3 npm run check:server`，92 项全部通过。未实测真实 OCR 的识别质量、延迟或计费；Files API 不用于跨模型文本提取，与 C0 结论一致。

- C-4（2026-11-14）：新增登录后的 GET `/api/speech`、POST `/api/speech/asr` / `tts`，只使用共享提供方凭据，浏览器不接触 key；按用户每分钟 20 次并校验来源。ASR 校验 WAV/Ogg Opus 容器、8 MiB / 120 秒边界，返回协议的 text/durationMs；TTS 校验 4000 字符、音色，HTTP 转发 WAV 流并开启 filter_markdown。主机 HTTP 输出改为带背压的流式管道，ASR 请求单独扩大 body 上限；超限返回 413。服务账务记录 ASR 向上取整秒数、TTS 汉字×2 的 Unicode 字符数。新增真实 HTTP、SQLite、WAV/Ogg、登录/跨用户限流、首段音频先于上游结束到达的测试；`taskset -c 0-3` 清代理 `check:server` 94 项全部通过。只实现任务要求的 HTTP TTS，没有增加 WS TTS；未实测真实音频识别/合成质量和账单。

### B-1 分享链接（2026-11-14）

- 从集成分支 `feat/r7-int`（`1f7a2db`）建立 `feat/r7-b-server`，工作区为 `/mnt/data/linux/repos/gense-wt/r7-b`。未修改 web 或 protocol。
- 新模块 `platform/shares.ts` 在 `app.sqlite` 建立 shares 表和索引，保存前端快照，不解释正文、界面输入或结果语义。TypeBox 校验完整结构，检查 UTF-8 JSON 的 8 MB 上限、500 轮上限、图片 data URL 前缀，标题截断为 200 字符；token 为 16 字节随机数的 base64url。
- `share.create/update/delete` 校验所属用户和对话，更新保持原 token；首次连接和修改后向该用户全部连接推送 shares。共享链接变更与删除对话共用按用户的队列，删除对话时撤销其全部链接，避免并发创建留下孤立链接。
- 公开 `GET /api/share/:token` 在登录检查之前读取全局库，不解析 cookie，返回快照与 updatedAt；设置 noindex / no-store / JSON 头，按 socket IP 限制每分钟 60 次。`/s/:token` 返回网页入口并设置 noindex / no-referrer。
- 验证：3 组 B1–B4 专项测试覆盖真实 SQLite / HTTP / 双用户及双设备 WebSocket、原样保存及后续消息不进入旧快照、更新/撤销/重启、删除对话撤销、全局库位置、无效 cookie、限流及伪造转发头、结构/UTF-8 大小/轮数/图片校验与精确 8 MB 边界。按要求用 `taskset -c 0` 并清除代理运行 `npm run check:server`，88 项全部通过，无跳过。
- 无协议问题或设计偏离。临时对话的拒绝逻辑将在 B-2 接入 expiresAt。

- C-5（2026-11-14）：已合入 `3b5c33c`。模型账务增加 searches/fetches，使用最终 `tool_search + tool_image_search` / `tool_fetch`，包括 SSE error 的收费用量；独立 web Search/Fetch 成功且非空才计数，记在共享 DeepSeek 提供方的 `web-tools` 行，calls 为 0。仅有插件 key 时使用 `deepseek-tools` / BYOK 行。按 t4h 的口径，service_usage 仅记 OCR/ASR/TTS，不重复记联网。管理员与当前用户接口统一返回 UsageReport，两组数据均按 UTC 日期筛选，普通用户只见自己。真实本地 HTTP、SDK 与 SQLite 测试覆盖显示数/计费数不同、错误用量、空结果/失败不计账、无额外模型调用、双用户隔离；清代理并用 `taskset -c 0-3` 跑 `check:server`，99 项全部通过。未实测真实 DeepSeek 账单；无协议修改。

## 协议问题



- A-1：`memorySection` 的 8000 字符预算只计条目，不包含前导说明和标签。t4h 已明确接受，照用原文与现有预算，不修改。
- A-1：原 `memory.add.source` 不接受 `model`，撤销删除模型记忆会丢失来源。t4h 明确授权本次唯一的协议改动：将其放宽为 `MemorySource`；后端照存并测试删除后恢复来源。
- A-2 沙箱取舍已获 t4h 确认：仍每用户一个容器，整体只读挂载 `projects/`，read/write/edit/delete 只允许当前项目；bash 可以读取同用户其他项目，不拆分容器。

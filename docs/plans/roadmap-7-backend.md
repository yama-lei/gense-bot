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

- `GET /api/usage?from&to`：返回 `UsageSummary[]`，与 `/api/admin/usage` 同一查询，但只限当前登录用户；普通用户可访问。

### D-7 收尾

- 测试按 D1–D6：真实 SQLite、文件和 HTTP（反馈改值和清除、他人树拒绝、admin 汇总；faux 模型返回 JSON 和乱码时的追问；已读截断到 500；资料库分页、按类型、搜索、不含临时对话；导出 zip 的目录结构和内容、并发拒绝、他人下载 403/404；用量只含自己）。
- 提示词快照加追问侧调用一节（`SUGGEST_SYSTEM` + 一个 `suggestInput` 示例）。
- `docs/design/architecture.md` 补上新表、导出文件位置和追问的侧调用。

## 汇报

（在这里按阶段追加：做了什么、测试结果、偏离之处）

## 协议问题

（在这里记录）

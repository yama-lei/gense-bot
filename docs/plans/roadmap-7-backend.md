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

## 汇报

（在这里按阶段追加：做了什么、测试结果、偏离之处）

## 协议问题

（在这里记录）

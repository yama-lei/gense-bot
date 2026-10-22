# 路线图 2：从首个闭环到日常可用

状态：2026-10-21 制定，按阶段开发中（阶段 1–5、7 已完成；阶段 6 等端点开通）。来源是仓库根目录的 `goal.md`（用户的新功能清单），这里把它整理成 Intent → Spec → Design，并给出分层和开发顺序。所有取舍由开发者决定，理由写在各节；有长期成本的决定另见 [ADR-0003](../adr/0003-free-plan-agent-features.md)。

依据：[首版 Spec](../specs/personal-assistant.md)、[网页界面 Spec](../specs/web-ui.md)、[架构](../design/architecture.md)。

## Intent（整理自 goal.md）

| 编号 | 用户原话（摘要） | 整理后的目标 |
| --- | --- | --- |
| G1 | 每一处 UI/UX 细节对标 ChatGPT 网页版，每个页面都考虑是不是最好的设计 | 贯穿所有阶段：每个阶段交付时附带对应页面的打磨，最后整体走查一遍 |
| G2 | web_fetch / web_search，先接 DeepSeek；搜索要复合使用；加入类似 pi-gpt-search 的 GPT 搜索，但走我们 `.env` 的端点 | 网页插件：快速搜索、读取网页、深度搜索三个工具，模型按需组合 |
| G3 | 文件上传（PDF、Word 和其他文件） | 任意文件可上传和附加到消息；能转成文本的都能被助手读取 |
| G4 | 重试、fork/branch、树状对话：从主线分出支线，支线可以总结成 md 补充回主线，并提醒主线有这份 md | 会话树：重新生成、编辑消息、版本切换查看、分支为新会话、支线面板与“总结回主线” |
| G5 | Intelligent UI（open-intelligent-ui） | 生成式界面：助手可以用卡片、表格、图表等组件回答 |
| G6 | Codemode 与工具按需加载 | 工具变多后不把所有工具塞给模型；能用的部分在 Free 计划内实现 |
| G7 | 图片生成工具 | 用提示词生成图片 |
| G8 | Skills | 可复用的做事方法，用户可增改 |
| G9 | 输入框中 `/` 命令和 `@` 插件 / 资料文件 / 其他会话 | 输入框的命令与提及 |

## 分层

```text
L3 进阶      生成式界面(G5)    Codemode(G6，Free 计划不可用，见 ADR-0003)
L2 交互      会话树与支线(G4)  / 命令与 @ 提及(G9)   Skills(G8)
L1 能力插件  网页(G2)          文件格式(G3)          图片(G7)
L0 平台改造  工具注册表与按需加载 · 附件管线 · 会话树存储 · 输入框扩展点
横切         UI/UX 对标(G1)
```

下层是上层的前提：命令和 @ 依赖输入框扩展点与工具注册表；支线依赖会话树存储；文件上传依赖附件管线。

## 现状调研（2026-10-21 实测）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| DeepSeek 搜索 | 独立 REST 接口，不是模型内置工具，任何模型都能用。`POST /v1/tools/search`（query ≤128 字，支持 `site:`、`after:` 等语法，返回 title/url/summary/date/authority）与 `POST /v1/tools/fetch`（返回 Markdown）。用 `.env` 的 `DEEPSEEK_API_KEY` 实测两个接口都可用 | <https://api-docs.deepseek.com/guides/search/> |
| pi-gpt-search | 调用 ChatGPT 内部接口 `chatgpt.com/backend-api/codex/alpha/search`，需要个人订阅登录 token，伪造 UA。非公开接口，不适合放进服务端 | <https://github.com/mateusdcc/pi-gpt-search> |
| 我们端点的 GPT 搜索 | OpenAI 端点的 Responses API 带 `{type:"web_search"}` 工具可用（`gpt-6.1-sol` 实测：自动搜索、打开页面，回答带 URL 注释）。这就是“类似 pi-gpt-search 的逻辑”的正规做法 | 本地 curl |
| 图片生成 | OpenAI 端点有 `gpt-image-*` 模型，但 `/images/generations` 和 Responses `image_generation` 都返回 `Image generation is not enabled for this group` | 本地 curl |
| Codemode | `@cloudflare/codemode` 需要 Worker Loader（Dynamic Workers），官方写明只在 Workers Paid 计划提供 | <https://developers.cloudflare.com/dynamic-workers/pricing/> |
| 按需加载工具 | Think 没有工具搜索；但有 `beforeStep`（即 AI SDK `prepareStep`），每一步都可以改 `activeTools` | `@cloudflare/think` 0.21 `beforeStep` |
| 会话树 | Think 的消息本来就是树：`regenerate()` 保留旧回答为兄弟节点，`session.getBranches(id)` 可读出各版本。活动路径永远是最后插入的叶子，没有切换活动分支的公开接口 | `agents` `SessionsCore.getLatestLeaf`（按 `seq` 取最新） |
| Skills | Think 内置 Agent Skills：`getSkills()` 返回 `SkillSource`（`list/load/readResource`），自动提供 `activate_skill`、`read_skill_resource`。脚本执行需要 Worker Loader | `agents/skills` |
| 附件 | Think 把消息里的二进制部分（图片、PDF）按哈希存到消息行外，默认 8 条消息后从上下文中逐出 | `agents/docs/sessions.md` |
| Drive 转换 | 上传或复制时把 `mimeType` 设为 Google 文档即可转换：Word/RTF/HTML → 文档，Excel → 表格，PowerPoint → 幻灯片，PDF/图片 → 文档（OCR，可传 `ocrLanguage`） | <https://developers.google.com/workspace/drive/api/guides/manage-uploads> |
| open-intelligent-ui | 两周大的 Next.js 演示，核心是 OpenUI Lang（行式 DSL，系统提示约 8k token），`react-ui` 包 16 MB | <https://github.com/thesysdev/openui> |

## Spec（行为与验收）

编号接首版 Spec 的 S1–S10。

### 网页插件（G2）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R1 | 搜索 | 问一个需要最新信息的问题 → 助手调用 `web_search`，回答带来源链接；过程摘要中能看到查询词和结果列表 |
| R2 | 读取网页 | 发一个 URL 让助手总结 → 调用 `web_fetch`，回答基于网页正文 |
| R3 | 深度搜索 | 问一个需要多步检索的问题（或用 `/深度搜索`）→ 调用 `web_research`，结果是带来源的综述 |
| R4 | 来源展示 | 回答下方显示来源卡片（站点图标、标题、域名），点击在新标签页打开 |
| R5 | 插件开关 | 在“定制”页关闭“网页” → 三个工具都不会被调用（S8） |
| R6 | 外部内容是数据 | 网页中写“忽略之前的指令”→ 助手不执行（沿用“外部操作”规则） |

### 文件（G3）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R7 | 上传任意文件 | 在资料页或输入框（回形针、拖放、粘贴）上传 PDF / Word / Excel / PPT / 图片 / 文本，≤ 20 MB → 原文件保存到 `GenseBot/资料/`；超过上限 → 拒绝并说明 |
| R8 | 附加到消息 | 输入框中附加文件后发送 → 用户消息上显示文件卡片；助手能读取它 |
| R9 | 读取格式 | 让助手读取 PDF、Word、Excel、PPT → 读到文字（PDF 扫描件经 OCR）；读取图片 → 支持图像输入的模型能看到图片，不支持的模型得到明确说明 |
| R10 | 不改原文件 | 转换过程不修改原文件，转换产生的临时文件不留在 Drive |

### 会话树与支线（G4）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R11 | 重新生成 | 点任意一条回答的“重新生成”→ 产生新回答，不新增用户消息；旧回答（及其后的对话）保留为上一版本 |
| R12 | 编辑消息 | 编辑任意一条用户消息并发送 → 从该处产生新分支，之后的消息换成新分支的内容 |
| R13 | 版本 | 有多个版本的消息显示 “‹ 2 / 2 ›”，可以翻看旧版本（只读）；在旧版本上点“从这里分支”→ 以该版本为止的内容创建新会话 |
| R14 | 分支为新会话 | 任意一条回答的菜单中“分支到新会话”→ 新会话包含到此为止的全部消息，标题标注来源，可跳回原会话 |
| R15 | 支线 | 回答菜单中“开支线”→ 右侧（手机全屏）打开支线面板，在其中提问不影响主线上下文 |
| R16 | 总结回主线 | 支线中点“总结回主线”→ 生成 Markdown 总结，Drive 已连接时另存到 `GenseBot/Artifacts/`；主线出现一条“支线总结”卡片，消息正文就是总结全文，之后主线的助手直接在上下文中看到它 |

### 命令与提及（G9）、Skills（G8）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R17 | `/` 命令 | 输入框行首输入 `/` → 弹出命令列表（键盘上下选择、回车确认、Esc 关闭）；内置命令包括深度搜索、读网页、总结会话、开支线；Skills 也出现在列表中 |
| R18 | `@` 提及 | 输入 `@` → 弹出插件、资料文件、其他会话三组候选。提及插件 → 本轮优先用该插件；提及文件 → 等同附加该文件；提及会话 → 助手读取该会话内容作为上下文 |
| R19 | Skills | 定制页列出 Skills（内置 + `GenseBot/Skills/<名称>/SKILL.md`），可开关；助手在合适时激活 Skill，过程摘要中可见；用户可在 Drive 中新增或修改 Skill，刷新后生效 |

### 生成式界面（G5）、按需加载（G6）、图片（G7）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R20 | 生成式界面 | 让助手“用表格和图表对比三款手机”→ 回答中出现由组件渲染的卡片、表格、图表；深色模式下可读 |
| R21 | 界面交互 | 生成的界面中点按钮 → 作为一条用户消息发给助手 |
| R22 | 按需加载 | 模型首轮只看到核心工具和 `tools_find`；需要其他工具时先搜索再加载，过程摘要可见；同一会话后续轮次保持已加载 |
| R23 | 图片生成 | 让助手画一张图 → 消息中显示图片，可保存到 `GenseBot/Artifacts/`；端点不支持时，插件在定制页显示“端点未开通”，不能开启 |

## Design

### L0-1 工具注册表与按需加载

- 工具在 `worker/tools.ts` 的 `createTools` 中按组声明：`core`（Skill 与会话读取，始终提供）、`meta`（`tools_find` / `tools_load`，只在按需加载时提供）和各插件组。前端 `plugins/catalog.ts` 只描述展示信息。
- 元工具 `tools_find(query)` 按关键词（英文单词与中文二字片段）给候选工具打分，返回名称和说明；没有命中时列出全部候选。`tools_load(names)` 把工具加入本会话的已加载集合（Chat 的 KV `loadedTools`），之后的轮次一直可用。
- `beforeTurn` 决定本轮是否按需加载；`beforeStep` 在每一步把 `activeTools` 设为“核心 + 元工具 + 已加载工具”，所以同一轮中加载后下一步立即可用。候选只来自已启用的插件（S8）。
- 系统提示附一行一个插件的工具名清单（不含参数结构）。实测（GPT 端点）：只说“可以查找工具”时，模型看不到图表工具，转而调用端点自带的 `image_generation` 画了一张图；加上清单后，模型会按 `tools_find` → `tools_load` → 调用的顺序进行。
- 用户 `@` 提及的插件、所选 `/` 命令需要的插件，在本轮开始时直接加载，不必让模型再找一次。
- 过程摘要显示“加载工具：…”。
- 门槛：启用的插件工具少于 12 个（`DEFER_MIN_TOOLS`）时不启用按需加载，直接全部提供，因为工具不多时多一次往返只会更慢。目前一共约 10 个，所以默认不触发；验证时临时把门槛调低。
- 前端解析工具结果时容忍不是 `{content}` 形状的输出（端点自己执行的工具会返回其他结构）。
- 不用 Codemode 的理由见 ADR-0003。

### L0-2 附件管线

- 上传走 `POST /api/files`（`multipart/form-data`，Worker 校验 Access 后经 RPC 交给 UserHub 的 `uploadFile`），比通过 WebSocket 传大文件更稳；原来只收文本的 `uploadFile` callable 已删除。单文件上限 20 MB（前后端共用 `MAX_UPLOAD_BYTES`），类型不限，原样写入 `GenseBot/资料/`。Drive 的 multipart 上传只到 5 MB，所以统一用 resumable 上传（先 POST 拿上传地址，再一次 PUT 全部字节）。
- 输入框：回形针、拖放、粘贴都能附加文件，文件先上传，上传中显示进度、失败显示原因，上传完才能发送；只有附件没有文字时用“请看附件。”作为正文。资料页的上传按钮同样接受任意类型、可多选。
- 读取 `files_read` 按类型分流：
  - 文本类（含 HTML、Markdown、CSV、JSON）：直接下载，沿用 2 MB 上限。
  - Google 文档/表格/幻灯片：导出（已实现）。
  - PDF、Word、Excel、PowerPoint、OpenDocument、RTF：`files.copy` 到 `GenseBot/.cache/` 并转换成对应的 Google 文件（PDF 带 `ocrLanguage=zh`，扫描件也能读），导出文本后在 `finally` 中删除副本，原文件不变。表格只能导出第一个工作表，结果里会注明。转换结果按 `fileId:modifiedTime` 缓存在 UserHub 的 SQLite 表 `converted_text`（单条超过 50 万字不缓存，只保留最近 200 条），同一文件不重复转换。
  - 图片：工具结果只带文件信息，异步的 `toModelOutput` 再取图片，作为 `image-data` 内容部分交给模型。图片取 Drive 缩略图（长边 1024 像素）；没有缩略图时下载原图，限 4 MB。每个对话实例在内存里保留最近 8 张，避免每轮重复下载。模型不支持图像输入时（models.dev 的 `modalities.input`，即 `capabilities.image`）只返回文字说明，提示换模型。
- 消息中的附件：用户消息 `metadata.attachments = [{id,name,mimeType,size}]`，界面据此在气泡上方显示文件卡片（点击在 Drive 中打开）；同时追加一个以 `[附件]` 开头的文本部分告诉模型文件 ID，界面渲染时隐藏这部分。这样历史消息里的附件在任何模型下都能被重新读取，而不依赖 Think 的媒体逐出。编辑带附件的消息时保留附件。

### L0-3 会话树

- 重新生成用 Think 原生的 `regenerate({messageId})`（非破坏性），任意一轮都可以；原来的“重试”（再发一条相同的用户消息）已删除。
- 编辑消息：Chat 新增 callable `editMessage(messageId, text, body)`，以原消息的父节点为 parent 用 `addMessages` 追加新用户消息，再用 `saveMessages([])` 运行一轮（本轮的模型与思考强度经 KV `pendingBody` 交给 `beforeTurn`）。新消息成为最新叶子，即活动路径。客户端 WebSocket 发来的消息总是接在最新叶子上，所以编辑必须走服务端 callable。根消息没有父节点，`getBranches` 查不到根的兄弟，编辑根消息时把新根记在 KV `roots`。
- 版本：Chat 新增 callable `versions()` 返回活动路径上每个有兄弟的消息的兄弟列表，`view(messageId)` 返回经过该消息的最新叶子路径（只读查看）。由于 Think 的活动路径只能是最新叶子，旧版本只读；要在旧版本上继续，就“从这里分支”。这样不用改 Think 的内部状态，代价是旧版本不能原地复活。ChatGPT 允许原地切换，我们用分支替代，见 ADR-0003。
- 分支与支线都是新的 Chat：UserHub 的会话元数据增加 `parent: {chatId, messageId, kind: 'fork' | 'side'}`。创建时把到 `messageId` 为止的活动路径消息用 `addMessages` 复制进新 Chat（不触发模型）。
  - fork：普通会话，出现在侧栏，标题加“分支：”前缀，会话页顶部显示“分支自 …”。
  - side（支线）：不出现在侧栏，只在主线消息旁显示入口和右侧面板。
- 总结回主线：UserHub 的 callable `summarizeSide(sideId)` 让支线 Chat 用其当前模型总结分支点之后的对话 → Drive 已连接时写入 `GenseBot/Artifacts/支线总结 - <主线标题> - <支线标题>.md`（失败只记日志）→ 在主线 Chat 用 `addMessages` 追加一条助手消息，正文是总结全文，带 `metadata.branchNote = {sideChatId, title, summary, fileId?, fileName?}`，界面渲染成可展开的卡片。总结全文直接进入主线上下文，比“列出文件、需要时再读”少一次工具调用，也不依赖 Drive。写到 Artifacts 而不是新建 `GenseBot/支线/`，是因为 V3 的写权限只覆盖 GenseBot/ 下已建好的目录，总结本身也是一种产物。
- 删除主线会话时一并删除它的支线；分支（fork）是独立会话，保留。

### L0-4 输入框扩展点

- 输入框识别行首 `/` 与空白后的 `@`，弹出候选菜单（与 ChatGPT 一致：上下键选择、回车或 Tab 确认、Esc 关闭、失焦关闭；空输入框里退格删除最后一个芯片）。`@` 菜单分插件、资料文件、会话三组，每组最多 5 条，按输入过滤；只列出已开启的插件。
- 选中后在输入框上方显示芯片。文件提及直接变成附件（与上传的附件同一条管线）；命令和插件、会话提及随消息发送。只选了命令也能发送，正文默认是命令名。“开支线”是客户端命令：选中即对最后一轮开支线，不发消息。
- **实际实现与原设计不同：** 命令和提及不放在请求 `body` 里，而是和附件一样写进用户消息本身——`metadata` 供界面显示芯片，另加以 `[命令]`、`[提及]` 开头的隐藏文本段供模型阅读（`src/message.ts`）。理由：`body` 只属于一次请求，重新生成、编辑、分支和支线复制消息时都会丢；写进消息后这些操作自动保留，`beforeTurn` 也不需要任何特殊处理。编辑消息时只替换正文，隐藏段原样保留。
- 提及会话 → 助手调用 `chats_read` 读取该会话活动路径的文本（每次 2 万字，可用 offset 续读；不能读当前会话；只能读本人的会话，由 UserHub 校验）。提及插件 → 隐藏段提示本轮优先用它的工具。命令 → 隐藏段写入该命令的完整指令。

### L1 网页插件

| 工具 | 实现 | 用途 |
| --- | --- | --- |
| `web_search` | DeepSeek `/v1/tools/search`，`count` 默认 8，返回 title、url、date、summary | 快速查事实、找链接 |
| `web_fetch` | DeepSeek `/v1/tools/fetch`，正文按 2 万字分段（与 `files_read` 一致） | 读具体网页 |
| `web_research` | 用 OpenAI 端点 Responses API + `web_search` 工具，模型取 `.env` 的 `DEFAULT_OPENAI_MODEL`，返回综述和来源 URL | 多步检索、对比、调研 |

- “复合使用”写进系统提示：先 `web_search`，需要细节再 `web_fetch`，问题复杂或前两者结果不够时用 `web_research`。
- 结果的 `structuredContent.sources` 被前端收集成回答下方的来源卡片，与文件引用并列。
- 未配置 `DEEPSEEK_API_KEY` 时 `web_search` / `web_fetch` 不注册；未配置 OpenAI 端点时 `web_research` 不注册。插件三者都没有时不可开启。

### L1 图片（阻塞）

- 插件 `image`，工具 `image_generate(prompt, size)`：调用 OpenAI 端点 `/images/generations`，模型取 `IMAGE_MODEL`。生成的图片直接存到 `GenseBot/Artifacts/`（PNG），消息里显示图片（经 `/api/files/<id>/content` 读取，Worker 校验 Access 后代理 Drive）。
- 当前端点返回“未开通”，所以排在最后，并在 hub 刷新模型时探测：探测失败则插件标记为不可用。

### L2 Skills

- 来源两类：
  - 内置：随代码打包（`src/skills.ts`）：“周报整理”“论文速读”“邮件起草”。
  - Drive：`GenseBot/Skills/<文件夹>/SKILL.md`（YAML 开头写 `name`、`description`）以及同文件夹中的参考文件（最多一层子文件夹）。UserHub 在启动、连接 Drive 和用户点“刷新”时读取，按 SKILL.md 的 `modifiedTime` 缓存解析结果；与内置重名、缺少 SKILL.md 或开头无效的文件夹会跳过，原因显示在定制页。
- **不用 Think 的 `getSkills()`，改用自己的三个工具（`skill_activate`、`skill_read`）和系统提示里的目录。** 实测 Think 0.21 的 skills 会注册自己的上下文块，此后 `getSystemPrompt()` 不再生效，与我们在 `beforeTurn` 拼系统提示（语言、记忆、项目说明）冲突；它还在每轮刷新所有来源（每轮多次 Drive 请求），工具名也是固定的。自己实现只多约一百行，开关、缓存和错误显示都能按我们的需要做。
- `skill_activate`、`skill_read`、`chats_read` 属于始终开启的核心工具组，不受插件开关影响；关掉的 Skill 不出现在目录里，也不能被激活。激活过的 Skill 显示在过程摘要中（“使用 Skill：…”）。
- 每个 Skill 也是一条 `/` 命令（命令提示模型先激活它）。
- 定制页新增“Skills”分组：列表、来源标签（内置 / Drive）、开关、刷新按钮、错误信息、在 Drive 中新建的说明。
- 不支持 Skill 脚本（需要 Worker Loader）；带脚本的 Skill 只用其中的说明和参考文件。

### L3 生成式界面

- 不引入 OpenUI：它的 DSL 系统提示约 8k token，又依赖网关纠错，而用户自备模型的质量差别很大。改为自定义的 `ui` 插件和显示工具 `ui_render`（`resourceUri` 为 `ui://ui/render`）。参数是一棵用 Zod 校验的组件树（`src/plugins/ui/schema.ts`，前后端共用）：
  - 顶层是块列表，外加 `grid`（2–4 列）和 `card`（标题、副标题、配图、块）两种容器；
  - 内容块有 heading、text（Markdown）、stat、badges、list、table、chart（bar / line / pie）、image、link、callout（info / success / warning / error）、buttons。
  - 每个字段的中文 `.describe()` 就是给模型的组件说明。不做任意嵌套的 Row/Col，因为层级浅一些，模型更不容易出错。
- 工具结果告诉模型“已在界面中显示，不要在文字里重复数据”。只有在对比、数据、趋势、请用户选方向时才用它（写在系统提示中）。
- 渲染（`src/plugins/ui/views.tsx`）：
  - 使用现有的 CSS 变量；遇到不认识或不合法的节点就跳过，不让整体失败；
  - 图片只接受 https，并设 `referrerPolicy=no-referrer`，加载失败时隐藏。
- 图表是手写的 SVG，没有引入图表库：
  - 只有一个 y 轴。柱状图从 0 开始，折线图贴合数据范围。
  - 系列颜色取 `--series-1…8`，固定顺序，浅色和深色两套都用 dataviz 校验脚本验证过。对比度有 WARN 的颜色由直接数值标签和表格视图兜底。
  - 柱宽最多 28px，顶端 4px 圆角，同组柱间隔 2px；折线 2px，数据点 8px 带表面色描边；末端数值标签自动错开。
  - 悬停显示对应列和提示框，可以切换成表格；两个及以上系列显示图例。
  - 饼图（环形）超过 8 块时，多出的并入“其他”。
- 按钮只有一种动作：`message`，作为用户消息发送，对应 MCP Apps 的 `ui/message`。按下后整组按钮停用，并高亮所选那个，所选按钮存在 viewState 里。

### 横切：UI/UX 对标

每个阶段交付时走查涉及的页面，按 ChatGPT 网页版的对应行为核对：键盘操作、加载与空状态、错误文案、悬停操作、移动端抽屉与安全区、深色模式。最后一轮整体走查侧栏、首页、会话页、资料页、定制页。

## 开发顺序

| 阶段 | 内容 | 依赖 | 退出条件 |
| --- | --- | --- | --- |
| 1 | 网页插件（含来源卡片）+ 工具注册表元数据 | — | R1–R6 本地实测通过；部署 |
| 2 | 会话树：重新生成、编辑、版本、分支、支线与总结回主线 | — | R11–R16 |
| 3 | 附件管线与任意文件上传 | — | R7–R10（Mock 已验证；真实环境需要用户连接 Drive 后验证） |
| 4 | `/` 命令、`@` 提及、Skills | 1、3 | R17–R19（Mock 与本地真实模型已验证；Drive Skills 需要用户连接 Drive 后验证） |
| 5 | 按需加载、生成式界面 | 1 | R20–R22（Mock 浅色/深色/窄屏与本地真实模型已验证；按需加载用临时调低的门槛实测） |
| 6 | 图片生成 | 端点开通 | R23（2026-10-21 复测：`/images/generations` 和显式声明的 Responses `image_generation` 仍返回 `Image generation is not enabled for this group`。端点偶尔会自行注入该工具并返回图片，但这不是受支持的途径，不依赖它；前端只保证这类结果不会导致崩溃） |
| 7 | 整体 UI/UX 走查 | 全部 | 每个页面的走查记录（见下节） |

每个阶段单独提交；Mock 模式同步提供演示数据，保持 Mock 部署可用。

### 阶段 7 走查记录（2026-10-21）

用 Mock 和本地真实模型截取每个页面：浅色 1300px、深色 1300px、移动端 400px（触屏模拟），再加上移动端抽屉。

| 页面 | 核对结果 | 改动 |
| --- | --- | --- |
| 侧栏 / 抽屉 | 搜索无结果和无会话都有提示。置顶项目与最近会话分组清楚。移动端抽屉带遮罩，切换路由后自动收起。深色模式对比度足够 | 新对话的悬停提示写出快捷键 |
| 首页 | 问候语、输入框和建议词居中，移动端输入框和建议词贴近底部 | — |
| 会话页 | 输入法组字时按 Enter 不会发送。`/` 和 `@` 菜单可以用方向键、Enter、Tab、Esc 操作。空输入框按退格会删掉最后一个标签。消息有复制、重新生成和更多操作。错误卡片写清原因和下一步，并提供重试。标题栏下的内容渐隐 | 加上 ChatGPT 同款全局快捷键：Ctrl/⌘+Shift+O 新对话，Shift+Esc 聚焦输入框。触屏键盘上 Enter 改为换行，由发送按钮发送（与 ChatGPT 移动端一致） |
| 资料页 | 资料和 Artifacts 两种空状态都有说明，上传按钮旁注明大小和格式限制 | 内容宽度原来固定为 1100px，与其他页面不一致。改为只在打开预览时加宽，平时与其他页面同为 880px |
| 项目页 / 项目详情 | 空状态说明了项目的作用。标题可以就地编辑，按 Enter 确认 | — |
| 定时任务 | 顶部提示这里只是 Mock 演示 | — |
| 定制页 | 插件开关、外部写操作标记、Skills 刷新，深色和窄屏都正常 | — |
| 生成式界面 | 阶段 5 已走查浅色、深色和 420px 三种情况 | — |

## 不做

- Codemode 与 Skill 脚本：需要 Workers Paid 计划（ADR-0003）。
- pi-gpt-search 的 ChatGPT 内部接口：非公开、需要个人订阅 token。
- 原地切换旧版本继续对话：用“从这里分支”替代。

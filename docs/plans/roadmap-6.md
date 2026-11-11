# 路线图 6：插件页重做、Skill 瘦身、上下文压缩、多用户

状态：草案，2026-11-11，待用户确认。来源：`known-bugs-or-gap.md`、`docs/inbox/`。

依据：[ADR-0006](../adr/0006-multi-user.md)（多用户）、[路线图 5](roadmap-5.md)、[网页界面](../specs/web-ui.md)。

## Intent（2026-11-11 讨论记录）

| 编号 | 用户的话 / 选择 | 整理后的目标 |
| --- | --- | --- |
| I1 | “UI 还是太丑了，先重构插件和 Skills 界面”，参考 `docs/assets/ui-reference/connector-{1,2}.png` | 插件页按 Claude / ChatGPT 的连接器页重做：分页签、已安装 / 发现、搜索、卡片网格 |
| I2 | “把 Skills 的例子删去，内置一些 Skills”；zh-humanizer“只是一个例子，让一个 agent 去找一些不错的、可以用的” | 删掉现有的示例 Skill；从社区挑一批许可允许再分发、能在我们的沙箱里跑的 Skill 内置 |
| I3 | “结合 open-intelligent-ui 优化 ui render：默认加载时上下文短，把更多信息放在 UI Skill 里” | 生成式界面的语法和组件说明移出系统提示词，做成内置 Skill，按需读取 |
| I4 | “加上 `docs/inbox` 里的支持”；发现页“先预置静态模板，以后迁到 MCP Registry” | alphaXiv、高德作为发现页的预置 MCP；`compact.md` 进 I7；`tailscale.md` 进 I6 |
| I5 | “多用户，邮箱登录和注册（暂不接码）”；BYOK + 管理员共享的模型，以后收费；Bot 每人一个；MCP、Skills 隔离；资源先不考虑 | 见 ADR-0006 |
| I6 | “让一个 agent 调研 herdr-connect，将来能否让 GenseBot 通过 Tailscale 直连本地的 hc” | 只调研，产出 `docs/research/herdr-connect.md` |
| I7 | “上下文压缩” | 长对话自动压缩；手动 `/compact`；界面上看得到压缩发生在哪里 |

不在本轮范围：邮箱验证码与找回密码邮件、订阅与支付、配额、MCP Registry、连接用户本地的 hc（I6 只调研）。

## 阶段

```text
A  Skill 与生成式界面瘦身（I2 + I3）   后端 + 提示词，先做
B  插件页重做 + 发现页（I1 + I4）     前端由 Claude 写；可与 C 并行
C  上下文压缩（I7）                    后端交给 hc + codex，前端由 Claude 写
D  多用户（I5）                        最大的一块；后端交给 hc + codex，登录页和后台由 Claude 写
E  调研（I6）                          已在后台进行，只出文档
```

每个阶段一个分支（`feat/r6-a-skills` 等），验收通过后合并到 `main`。

## Spec

验收都用真实的 SQLite、文件和 faux 模型；MCP 用本地假服务器，不用 mock 对象。

### A. Skill 与生成式界面

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| A1 | 内置 Skill 是真的目录 | 内置 Skill 和安装的 Skill 是同一种东西：仓库里 `packages/server/skills/<name>/SKILL.md`（加上可选的 `scripts/`、`references/`），全部符合 Agent Skills 命名规范；`skills.ts` 里写死的 `builtinSkills` 消失 |
| A2 | 示例删除 | 现有的示例 Skill 不再出现 |
| A3 | 精选 Skill | 内置调研选出的 Skill（名单见“内置 Skill 候选”），每个都带原许可证文件和来源；在沙箱里能实际跑通一个示例任务 |
| A4 | UI Skill | 新增内置 Skill `generative-ui`：`SKILL.md` 讲什么时候用界面、怎么写；`references/language.md` 是语法和组件签名，`references/practices.md` 是好做法和完整示例，两者都由 `npm run genui -w @gense/web` 从网页端的组件库生成；`metadata.plugin: ui` 表示它随 ui 插件提供，不能单独关闭，也不进通用的 Skill 列表 |
| A5 | 系统提示词变短 | 开启 ui 插件时，系统提示词里关于界面的部分不超过 1k token（改前是整份组件说明，约 3.6 万字符、9–10k token）；只保留“何时用 `ui_render`”和“第一次用前先读 `generative-ui` Skill” |
| A6 | 不读也能纠错 | 模型没读 Skill 就调用 `ui_render` 且程序无效 → 错误信息里给出具体问题和要读的 reference 文件路径 |
| A7 | 质量不退步 | 用一组固定提示（对比、地点、步骤、数据、计算器各一个）在真实模型上跑一遍，人工对比改前改后的截图；记录到 PR 描述 |
| A8 | 提示词可审阅 | 第一轮发给模型的完整内容（系统提示词各节、全部工具的说明和参数）生成一份快照 `packages/server/test/prompt.snapshot.md`，测试比对；改提示词必须同时更新快照，评审看它的 diff |
| A9 | 提示词统一 | 系统提示词和工具说明（包括 pi 自带的 read、write、edit、bash）统一用英文，同一种写法：先说做什么，再说什么时候用、什么时候改用别的工具、关键限制；不和实际行为矛盾（例如 bash 默认超时） |
| A10 | 回答的基本规矩 | 系统提示词告诉模型今天的日期和用户时区（网页端自动同步浏览器时区），以及回答的规矩：用用户的语言、先给结论、篇幅随问题、不编造事实和链接、清楚的请求直接做 |
| A11 | Skill 列表变短 | 列表里每个 Skill 的描述最多 250 个字符，超出截断；完整描述在 SKILL.md 里 |

### B. 插件页

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| B1 | 布局 | `/plugins` 顶部是“插件 / Skills”页签，下面是“已安装 / 发现”切换、搜索框和右上角“添加”下拉（添加 MCP 服务器、从 Git 安装 Skill、上传 zip）；条目是两列卡片：图标、名称、一行描述、来源，右侧是 `+`（未添加）或 `⋯`（已添加） |
| B2 | 详情 | 点卡片打开详情（桌面端是对话框，手机端全屏）：说明、设置表单、逐个工具的开关、连接状态和错误原因、移除 |
| B3 | 发现页 | 静态目录：内置插件、预置 MCP（alphaXiv：OAuth；高德：填 key）、精选 Skill（从 Git 一键安装）。一份数据文件维护，结构上能换成 MCP Registry |
| B4 | 预置 MCP 一键添加 | 点 alphaXiv 的 `+` → 走 OAuth → 列出工具；点高德的 `+` → 只要求填 key，地址由模板拼出 |
| B5 | 搜索 | 搜索框同时过滤已安装和发现，按名称和描述匹配，中英文都可以 |
| B6 | 通用要求 | 满足 web-ui 规范的 N40–N44：token、浅色 / 深色、390px、空 / 加载 / 出错三种状态、键盘操作 |

### C. 上下文压缩

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| C1 | 自动压缩 | 对话接近模型上下文窗口时自动压缩（pi-durable 的 `CompactionTask`，阈值和预留量按模型设置），回答不中断 |
| C2 | 压缩提示词 | 摘要用 `docs/inbox/compact.md` 的“交接摘要”要求：进展与关键决定、约束和偏好、剩余工作、需要的数据和引用 |
| C3 | 手动压缩 | 网页和飞书里都可以用 `/compact [补充要求]` |
| C4 | 界面 | 会话里在压缩处显示一条分隔线“上文已压缩”，可展开看摘要；压缩进行中和失败都有状态提示 |
| C5 | 不丢信息 | 压缩后网页上仍能看到完整历史（只是模型上下文变了）；分叉和版本在压缩之后仍然可用 |

### D. 多用户

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| D1 | 注册与登录 | 邮箱 + 密码注册、登录、退出、改密码；第一个注册的人成为 admin；admin 关闭注册后，注册页说明“暂不开放” |
| D2 | 隔离 | 两个用户互相看不到对方的会话、文件、插件、MCP、Skills、定时任务、飞书渠道；用 A 的会话 token 访问 B 的任何资源都失败（WebSocket、`/api/*`、文件下载、webhook、MCP Apps） |
| D3 | 共享模型 | admin 在后台登记提供方（地址、密钥、模型列表）→ 所有用户的模型选择器里出现，标记“共享”；用户看不到密钥 |
| D4 | BYOK | 用户在设置里填自己的密钥 → 模型选择器里出现，标记“自带”；其他用户看不到 |
| D5 | 记账 | 每次模型调用记录用户、模型、来源和 token；后台按用户、按天汇总 |
| D6 | 每人一个 Bot | 两个用户各配一个飞书应用，同时在线，各自的消息进各自的会话 |
| D7 | 后台 | `/admin`（只有 admin 能进）：用户列表（停用 / 启用、提升 admin）、共享模型、注册开关、用量 |
| D8 | sandbox | 每个用户的 `bash` 跑在自己的容器里，看不到别人的文件 |
| D9 | 迁移 | `npm run user:import-owner <email>` 把现有单所有者数据变成该用户的空间 |
| D10 | 重启 | 重启后所有用户的飞书连接、定时任务、未发出的 outbox 都恢复 |

## Design

### A. Skill 与生成式界面

- `packages/server/skills/` 放内置 Skill 的目录，启动时扫描，`source: 'builtin'`，和安装的 Skill 走同一条加载路径；第三方 Skill 原样复制并保留 `LICENSE` 和来源说明（`SOURCE.md`：仓库、提交、许可证）。
- `npm run genui` 改为生成 `packages/server/skills/generative-ui/references/components.md`，不再生成 `generated.ts`；`check` 继续校验它没有过期。
- 沙箱 `full` 镜像补上内置 Skill 需要的依赖（qpdf、pdfplumber、reportlab、markitdown，见下表）。另装 LibreOffice（writer、calc、impress 的无界面版，约 300MB）：`xlsx` Skill 的核心规则“零公式错误”靠它重算，`docx` 用它转 PDF 预览、转换 `.doc`、接受修订；`docx` 还要全局可用的 npm 包 `docx`（`NODE_PATH`）和 `defusedxml`。
- `display.ts` 里的 `UI_PROMPT` 换成两三句话；`ui_render` 的工具描述写清楚“先读 Skill”。

### A8–A11. 提示词

- 模型看到的文字只有两种来源：各模块的 `section(...)` 和工具定义。保留就近放置（工具说明写在工具旁边），用快照保证能整体审阅。
- 快照用 faux 模型、固定时间、全部插件打开、有沙箱，从 provider 收到的 system 消息里取出各节和 `toolsAdded`；`UPDATE_SNAPSHOT=1 npm test` 重写。
- 英文的理由：pi 自带工具和大部分第三方 Skill 本来就是英文，混用两种语言的指令更难写得一致；回答语言由“用用户的语言”这条规矩决定。报错信息不在这次范围内，保持中文。
- 工具选择的指引写在工具说明里（“不适合……，改用……”），不在系统提示词里重复。
- 时区存进偏好（`Preferences.timeZone`），日期只精确到天，系统提示词每天才变一次，不影响缓存。
- 验收 A7 的真实模型对比在改完后重跑一遍。
- 教训（A7 重跑）：通用回答规矩里写“对比用表格、步骤用列表”会和 ui 一节抢活，页面从 5/5 掉到 1/10；通用规矩只管文字本身，什么时候改用页面只在 ui 一节说。pi 自带的 tool_search 说明会诱导模型去“找工具”，换成只在需要 MCP 工具时才搜的说法。

### B. 插件页

- 页面拆成 `PluginsLayout`（页签、切换、搜索、添加）、`CatalogGrid`、`PluginCard`、`PluginDetail`；现有 `SettingsForm` 搬进详情。
- 发现目录放在 `packages/protocol/src/discover.ts`（类型）和 `packages/server/src/plugins/discover.ts`（数据）：`{ kind: 'mcp' | 'skill' | 'builtin', id, name, description, icon, by, install }`，`install` 是 MCP 地址模板（含要用户填写的字段）或 Git 地址。以后换成 MCP Registry 时只换数据来源。
- 图标：预置条目带 SVG；用户自己加的 MCP 用名称首字母生成。
- 实现（2026-11-11）：客户端用 `discover` 请求取目录，和已安装的按插件 id、Skill 名、MCP 地址模板（`fromTemplate`）对上，所以从预置添加的条目在“已安装”里保留图标。图标 SVG 以 `<img>` 显示、不作为标记执行；其中的品牌色是内容图片，不受 N40 的 token 约束。地址里的 `key=`/`token=` 在界面上打码。

### C. 上下文压缩

- 在 `UserSpace` 的 harness 设置里打开 pi-durable 的压缩策略（`reserveTokens`、`keepRecentTokens`、`backgroundTokens`），按模型的 `contextWindow` 设置；先确认现在的默认值是不是已经开启。
- 摘要提示词通过 `CompactionInput.instructions` 传入。
- `compaction_start` / `compaction_end` 事件和摘要条目经协议发到前端；`/compact` 在网页命令和飞书 Bot 命令里各加一个。

### D. 多用户

```text
data/
  app.sqlite              users, sessions, shared_providers, usage, settings(注册开关)
  users/<userId>/
    space.sqlite          现在 gense.sqlite 里的一切
    files/                现在 data/files/
```

| 模块 | 变化 |
| --- | --- |
| `platform/auth.ts` | `owner` 表换成 `users(id, email, password, role, disabled, createdAt)`；`sessions` 加 `userId`；`/api/register`、`/api/login` 按邮箱 |
| `platform/spaces.ts`（新） | 启动时为每个未停用用户打开 `UserSpace`；新用户注册时创建；停用时关闭 |
| `platform/server.ts` | 每个请求和 WebSocket 先由会话解析出用户，再取它的空间；webhook 和 OAuth 回调路径带 `userId` |
| `agent/models.ts` | relay 从 `.env` 改为读 `shared_providers`，每次解析时读取（admin 改了立即生效） |
| `agent/ledger.ts` 或新 `usage` 表 | 模型调用完成时写一条用量（写在 `app.sqlite`，方便汇总） |
| `platform/sandbox.ts` | 容器按用户命名，只挂载该用户的 `files/` |
| `platform/backup.ts` | 备份 `app.sqlite` 和每个用户的库 |
| `web` | 登录 / 注册页；`/admin` 后台；模型选择器标出共享和自带 |

## 内置 Skill 候选

详见 [调研报告](../research/builtin-skills.md)。`packages/server/skills/import.py` 按锁定的上游提交拉取并整改，附原许可证；保留上游名字，方便以后更新。

| Skill | 来源 | 许可证 | 沙箱 `full` 镜像还缺 |
| --- | --- | --- | --- |
| `generative-ui` | 自写（A4） | — | — |
| `humanizer-zh` | op7418/Humanizer-zh | MIT | — |
| `pdf` | anthropics/skills | Apache-2.0 | qpdf、pdfplumber、reportlab、pypdfium2、pdf2image、tesseract（加 CJK 字体注册说明） |
| `markitdown` | K-Dense-AI/scientific-agent-skills | MIT | markitdown |
| `xlsx` | anthropics/skills | Apache-2.0 | LibreOffice calc、openpyxl、pandas |
| `docx` | anthropics/skills | Apache-2.0 | LibreOffice writer、npm `docx`、defusedxml、pandoc |
| `baoyu-translate` | JimLiu/baoyu-skills | MIT | —（分块脚本用 `npx -y bun` 运行；没有偏好文件时直接用默认值） |
| `md-report-summary` | xstongxue/best-skills | Apache-2.0（仓库级，发布前向作者确认） | — |
| `paper-lookup`、`literature-review` | K-Dense-AI/scientific-agent-skills | MIT | — |

`xlsx`、`docx` 来自 anthropics/skills，原样导入。暂不内置：`pptx`（依赖最重，先由 artifact 工具承担）、`paper-write`（含“降 AIGC 率”，需要产品决定）。不能内置：`humanize-chinese`（非商业许可）、`office-file-process`（专有许可）。旅行规划、学习辅导、会议纪要没有够好的开源 Skill，以后自己写。

统一整改：去掉 Claude Code 专有的 front matter（`allowed-tools`、`argument-hint` 等）；正文里的 `AskUserQuestion`、`WebSearch` 换成我们的工具；`description` 补中文触发词（“去 AI 味”“翻译”“周报”）。

## 风险

- **A 可能让界面质量下降**：模型不读 Skill 就直接写。用 A6 的错误提示兜底，用 A7 的对比来发现问题。
- **D 改动面最大**：所有的路径、回调和容器名都要带上用户。D2 的越权测试要覆盖每一类入口。
- **社区 Skill 的许可证**：只内置明确允许再分发的。

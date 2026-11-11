# 路线图 5：聊天 + Bot、插件生态、界面重写

状态：已确认，2026-11-10。阶段 0–5 已实现（`feat/r5-web`，含合并进来的 `feat/r5-backend`）；阶段 6 的走查做了浏览器冒烟（浅色 / 深色、390px、命令面板、生成式界面），真实飞书应用和真实 MCP 服务器的验收还没做。前后端的契约是 `packages/protocol`；后端任务见 [roadmap-5-backend.md](roadmap-5-backend.md)。

依据：[ADR-0005](../adr/0005-event-driven-vps.md)、[架构](../design/architecture.md)、[路线图 4](roadmap-4.md)。

## Intent（2026-11-10 讨论记录）

| 编号 | 用户的话 / 选择 | 整理后的目标 |
| --- | --- | --- |
| F1 | “Chat web + Bot 的功能” | 同一个助手有两个入口：网页聊天和 IM Bot。首批 Bot 平台只做**飞书** |
| F2 | “插件生态和兼容性（最好能兼容其他的生态）” | 兼容 **MCP 服务器 + MCP Apps** 和 **Agent Skills**。不做 Claude Code 插件包和第三方 pi 扩展包 |
| F3 | “细节打磨好” | 界面换设计系统重写（Tailwind + shadcn/ui），聊天协议层保留；按清单验收细节 |
| F5 | “ChatGPT/Claude Web + GrokBot 风格的作品” | 网页对标 ChatGPT / Claude 的聊天体验；Bot 对标 Grok：在群里被 @ 时读懂上下文（被回复的消息、话题里前面的消息），直接、简短地回答 |
| F6 | “代码后续由你负责，无需保证兼容性，历史决策你也可以否定” | 不保留旧数据与旧接口；与本文冲突的旧决定以本文为准 |
| F4 | 与路线图 4 的关系：“合并精简” | 只保留 Bot 需要的事件驱动部分：Source/Channel、准入 gate、outbox。Ticket、Mandate、GitHub、GitLab、面板推后 |

不在本轮范围：多用户、Ticket/Mandate/Subscription、GitHub/GitLab Source、内置日历、smail、Google Drive、Telegram 等其他 IM。

## Spec

验收都用真实的 SQLite、文件和 faux 模型；飞书和 MCP 用本地假服务器（实现它们的真实协议），不用 mock 对象。

### 聊天与 Bot

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| N1 | 网页聊天行为不变 | 现有 core / hosts 测试在重构后全部通过：发言、中止、分叉、版本、子 agent、定时任务、重启恢复 |
| N2 | 飞书私聊 | 所有者给 Bot 发消息 → 得到回答；回答过程在同一张卡片上更新（节流），结束后是最终内容 |
| N3 | 飞书会话与网页同源 | 飞书里的对话出现在网页侧栏，带来源标记；网页上能看到完整过程（工具调用、文件） |
| N4 | 准入 | 不在名单里的人给 Bot 发消息 → 不调用模型，记录一条被拒绝的 Trigger；所有者用网页生成的配对码绑定自己的飞书身份 |
| N5 | 群聊 | 只有 @Bot 的消息才响应；同一话题（thread）的后续 @ 进入同一个会话 |
| N6 | 不丢不重 | 飞书重复投递同一事件 → 只回答一次；回答发送前进程崩溃 → 重启后补发一次 |
| N7 | Bot 命令 | `/new` 开新会话，`/stop` 中止，`/model` 查看或切换模型 |
| N8 | 附件 | 飞书里发的图片和文件进入会话工作区的 `attachments/`；助手生成的图片和文件能发回飞书 |
| N9 | 富界面降级 | 飞书显示不了的工具界面（生成式界面、Artifact）显示为摘要加“在网页中打开”的链接 |

### 插件

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| N20 | 添加 MCP 服务器 | 在插件页填远程地址（Streamable HTTP）和可选的请求头 / OAuth → 列出它的工具，可以整体或逐个开关；下一轮起模型可以调用 |
| N21 | 工具多时不撑爆提示词 | 一个服务器的工具超过阈值时标记为 deferred，由 `tool_search` 按需加载 |
| N22 | MCP Apps | 工具声明了 `ui://` 资源（`text/html;profile=mcp-app`）→ 在独立来源的沙箱 iframe 里渲染，能收到 tool-input / tool-result，能 `tools/call` 本服务器的工具、`ui/message` 发消息；拿不到主站 cookie |
| N23 | 断线与错误 | MCP 服务器不可达 → 插件页显示原因，它的工具从下一轮起不提供；恢复后自动回来 |
| N24 | 安装 Skill | 上传 zip 或填 Git 地址 → 按 Agent Skills 规范校验（`SKILL.md`、`name`、`description`）→ 出现在 Skills 列表；附带的 `scripts/`、`references/`、`assets/` 原样保留，模型可以读取，脚本可以在沙箱里运行 |
| N25 | Skill 兼容 | 能直接安装公开的社区 Skill 仓库里的任一 Skill，不需要改动 |
| N26 | 内置插件同一套接口 | artifact、email、ui、web、image、sandbox 改用与 MCP 相同的声明方式；`catalog.ts` 里按 id 写死的分支（`pluginIssue`）消失 |

### 界面

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| N40 | 设计系统 | 颜色、间距、圆角、字号只来自一套 token；浅色 / 深色都完整；没有手写的一次性颜色 |
| N41 | 手机 | 390px 宽可用：侧栏是抽屉，面板全屏，输入框不被键盘遮住，考虑安全区 |
| N42 | 流式 | 回答流式出现时不抖动；用户上滚后不再自动跟随，并出现“回到底部” |
| N43 | 状态 | 每个页面和列表都有空、加载、出错三种状态；断线时有提示并自动重连 |
| N44 | 键盘 | 所有菜单、对话框、下拉可用键盘操作（Radix）；`⌘K` 命令面板：新对话、搜索会话、跳转页面 |
| N45 | 信息架构 | 见 Design“前端”；路径路由，刷新后停在原处 |

## Design

### 包结构

`core` 与 `hosts/node` 的分界是为 Cloudflare 留的，ADR-0005 之后已无意义，建议合并：

```text
packages/
  protocol/   浏览器与服务端共用的类型（现 core/protocol.ts、catalog 的类型、notes）
  server/     一个 Node 进程
    platform/   config、db、auth、http、backup、sandbox
    agent/      space（拆分）、branches、subagents、workspace、ledger、documents、models、credentials
    events/     triggers、gate、schedules、webhooks、outbox
    channels/   channel 接口、web（现 connection.ts）、feishu
    plugins/    host（注册、设置、密钥）、builtin/*、mcp/*、skills/*
  web/        见“前端”
```

`space.ts`（1104 行）按现有的注释分节拆开：trees、branches/send、events、subagents、schedules、webhooks；`UserSpace` 只做组装。行为不变，测试原样搬过去。

### 事件与 Channel

沿用 ADR-0005 的词，但只取 Bot 需要的部分：

```text
飞书长连接 ─┐                                   ┌─► 网页（WebSocket，现状）
网页 WS   ─┼─► Trigger（落库、去重）─► gate ─► 会话 ─► 运行 ─┤
定时/webhook ┘        │                拒绝则记录            └─► outbox ─► 飞书回复
                      └ threads：(source, threadKey) → treeId
```

| 模块 | 职责 |
| --- | --- |
| `Channel` 接口 | `start()` 接收入站消息并交给 `ingest(trigger)`；`deliver(item)` 发出一条 outbox 消息；`render(run)` 决定怎么显示进行中的回答 |
| `triggers` 表 | `(id, source, thread_key, actor, payload, decision, tree_id, created_at)`；id 用来源的投递 id，主键即去重。取代 `app.event` 的独立记录（ADR-0005 已决定合并） |
| `gate` | 确定性判断：每个 Source 一张允许名单，默认只有所有者。本轮没有模型研判 |
| `threads` 表 | 把来源的线程映射到会话树；`/new` 改写映射 |
| `outbox` 表 | 与产生它的写入同一事务入队，提交后发送，带重试与回执；同一 id 不排两次 |
| `channels/web` | 现在的 `Connection`，协议基本不变；`send` 改为先生成 Trigger |
| `channels/feishu` | 官方 SDK 的长连接模式（不需要公网回调）；入站：消息、@、附件；出站：流式更新的卡片、最终消息、文件 |

飞书上的进行中回答直接更新卡片，不经 outbox（丢了无妨）；只有最终回答和文件走 outbox（N6）。

网页聊天的体验不变：所有者的消息过 gate 后直接送入会话，`requestId` 就是 Trigger id。

### 插件

一个插件 = 一份声明 + 一个提供者。三种提供者共用同一张注册表、同一套开关和设置界面：

| 提供者 | 工具来自 | 界面来自 | 运行位置 |
| --- | --- | --- | --- |
| builtin | pi-durable extension | 前端内置 React 组件 | 宿主进程 |
| mcp | MCP 服务器的 `tools/list`，命名 `mcp__<server>__<tool>` | MCP Apps 资源，沙箱 iframe | 远程服务器 |
| skill | 无（只有说明与文件，模型用 `read` / `bash`） | 无 | 沙箱 |

- **声明**：`definePlugin({ id, name, description, settings, issue(config), extension(config) })`，每个内置插件一个目录，自己带设置和可用性判断。目录页的列表由注册表生成，MCP 服务器是运行时加入的条目。
- **MCP 客户端**（`plugins/mcp`）：官方 TypeScript SDK；每个服务器一个连接，带重连和状态；工具转成 pi-durable 的 tool，返回值本来就是 `CallToolResult`，与现有约定一致。凭据（请求头、OAuth 令牌）沿用 `Sealer` 加密。
- **MCP Apps**：前端 `ViewHost` 接口不变，新增 iframe 实现，把 `ViewProps` 翻译成 MCP Apps 的 postMessage 消息。iframe 放在独立来源：正式环境用第二个域名（Caddy 多一个站点），按资源的 `_meta.ui.csp` 下发 CSP；没有第二个域名时退回到不带 `allow-same-origin` 的 `srcdoc` iframe。
- **Skills**（`plugins/skills`）：完整解析 front matter（`name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`）；整个目录存到 `/data/skills/<name>/`；来源记录为 builtin / upload / git。现有的中文内置 Skill 名不符合规范的命名规则（小写字母、数字、连字符），内置的继续放行，安装的按规范校验。

### 前端

技术：React 19 + Vite 保留；新增 Tailwind v4、shadcn/ui（Radix）；图标继续用 lucide。`pi/store`、`pi/socket`、`pi/turns` 保留。生成式界面（`plugins/ui/genui`）自带一套主题，改为读同一套 token。

```text
src/
  app/        外壳、路由、Provider、命令面板
  ui/         shadcn 基础组件
  lib/        socket、pi store、工具函数
  features/
    chat/        Thread、Turn、ToolCall、EventCard、Composer、BranchMap、WorkspacePanel
    plugins/     已安装（内置 / MCP / Skills）、添加 MCP、安装 Skill、单个插件的设置
    automations/ 定时任务、webhook
    channels/    飞书：凭据、配对、名单、最近的 Trigger（含被拒绝的）
    settings/    模型账户、外观、登录
  plugins/    ViewHost：内置 React 视图 + MCP Apps iframe
```

| 路由 | 页面 |
| --- | --- |
| `/` | 首页：输入框 |
| `/c/:treeId` | 会话；右侧面板放文件、Artifact、全屏视图 |
| `/plugins` | 插件与 Skills |
| `/automations` | 定时任务与 webhook |
| `/channels` | Bot 渠道 |
| `/settings` | 模型、外观、登录 |

`ChatView.tsx`（765 行）和 `Pages.tsx`（892 行）不迁移，按上面的目录重写。

### 不兼容的改动

- 目录结构与包名变化（`@gense/core` → `@gense/server` + `@gense/protocol`）。
- URL 从 hash（`#/c/…`）改为路径。
- `app.event` 条目改由 Trigger 渲染；旧数据库不迁移（beta）。
- “定制”页拆成 `/plugins` 和 `/settings`。

## 阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 0 | 包结构合并，拆 `space.ts`，行为不变 | N1 |
| 1 | 设计系统、外壳、会话页、设置页重写 | N40–N45（插件、渠道页先接现有数据） |
| 2 | 插件注册表、内置插件改造、Skills 完整支持与安装 | N24–N26 |
| 3 | MCP 客户端、插件页、MCP Apps iframe | N20–N23 |
| 4 | Trigger / gate / threads / outbox，网页改走 Trigger | N1 仍通过 |
| 5 | 飞书 Channel | N2–N9 |
| 6 | 细节走查：手机、深色、键盘、各状态 | N40–N45 全部逐条过 |

每个阶段一个分支，`make check` 通过后再进下一个。

## 决定（2026-11-10，用户同意全部建议）

1. `core` 与 `hosts/node` 合并为 `packages/server`，共用类型在 `packages/protocol`。
2. MCP 本轮只支持远程 Streamable HTTP；stdio 以后放专用容器。
3. 飞书：私聊是一个持续会话，`/new` 开新的；群里只响应 @，按话题分会话；默认只有所有者，用配对码绑定。
4. 回答只回到消息来的地方；网页上追问飞书发起的会话，不发回飞书。
5. 删除前端的项目、资料（Drive）页面与 `drive` 插件条目。
6. 路线图 4 的阶段 3–8 搁置。
7. 飞书凭据在渠道页填写，`Sealer` 加密入库。

另加三项（协议里已有）：

- **偏好**（`prefs`）：所有者的称呼和“希望助手怎样回答”，进入每个会话的提示词；对应 ChatGPT 的自定义指令。
- **会话搜索**（`trees.search`）：按标题和消息内容搜索，给命令面板用。
- **Bot 人设**：渠道的一项设置（长文本），只加在该渠道发起的会话里，默认是简短、直接的风格。

## 分工

- 前端（`packages/web`）与 `packages/protocol` 由 Claude 实现和维护。
- 后端（`packages/server`）由 codex 按 `roadmap-5-backend.md` 实现，Claude 评审后合并。

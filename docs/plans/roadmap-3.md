# 路线图 3：pi-durable 核心、树形会话、Event 与 sandbox

状态：用户评审通过，2026-10-23。决策依据见 [ADR-0004](../adr/0004-pi-durable-portable-core.md)。[路线图 2](roadmap-2.md) 的功能（R1–R30）在本路线图的阶段 3 迁移到新架构，那里的 Spec 继续有效，下面另有说明的除外。

## Intent（2026-10-22 讨论记录）

| 编号 | 用户的话（摘录） | 整理后的目标 |
| --- | --- | --- |
| H1 | “一棵树才对应一个侧边栏的显示会话；用户 fork 出去的应该保持在树内部” | 侧栏一项就是一棵树；分叉、重新生成、子 agent 都是树里的节点，不在侧栏另开会话 |
| H2 | “小地图是展示大致的 tree 进度”“active 的 node 在小地图上就是绿色”“小地图点开是可以放出一个居中的大矩形的” | 会话页右上角有树的小地图，当前节点为绿色；点开是居中的大弹窗，在里面看历史、切换分叉 |
| H3 | “子 Agent 异步吧，主 Agent 被这个 event 唤醒了而已”“后面我们还会有定时任务……之后 webhook……也是要有 Event 这个思想的” | 一个统一的 Event 概念：子 agent 汇报、定时任务、webhook 都通过它投递给会话，可以唤醒会话 |
| H4 | “不要弄 worktree……Agent 的两次写操作之间如果文件发生了变动……那就报错，要求 read before write……也不要 merge” | 树内所有节点共用一个文件系统，没有合并；文件在 agent 读过或写过之后被别人改过，再写就报错，要求先读 |
| H5 | “默认 fork 吧，让 agent 可选 fork 或者 new” | 子 agent 默认带着当前上下文 fork 出去，agent 也可以选择从空白开始 |
| H6 | “限制子 Agent 的时候……不要把 tool schema 移除（这会导致 cache miss），而是要在上下文中 append 一个 tips + 在调用工具的时候给其报错” | 树里所有节点的工具集合相同；不允许的调用返回错误，角色说明作为一条消息追加在上下文里 |
| H7 | “支线去掉，和用户 fork 合并……subagent 在 fork 的时候，必须要用 report 汇报结果；用户这一侧是不必要的，除非用户主动选择 summary to main” | 用户分叉和子 agent 是同一种东西，只有提示词不同；用户分叉可以“总结给主线” |
| H8 | “Pi Durable 将会是一个很伟大的框架，我们一定要主动集成它”“我预感未来我们会选择自己部署……（当然都要支持）” | 核心用 pi-durable；同时支持 Cloudflare 和自部署 |
| H9 | “肯定还要支持完整的 sandbox”“cloudflare 沙盒是要付费的，我们在 cloudflare 上就先不做……区别其实就是有没有 bash 工具” | 自部署提供完整 sandbox（`bash`）；Cloudflare Free 部署只读写文件，其余功能相同 |
| H10 | “GoogleDrive 也要作为 Plugin” | Drive 从内置能力改成插件：文件来源、Skills 来源、Drive 工具 |
| H11 | “按照用户的话，感觉也不错啊。一个 session 就是一个 dir？……是否要做权限隔离？” | 每个用户一个 sandbox，每棵树一个目录；会话之间只做软隔离（见 D6） |

已确认：Event 卡片默认折叠；子 agent 最多同时 3 个、只能派生一层、唤醒有频率限制；密钥不进 sandbox；迁移时先迁移现有功能，再做新功能；不考虑兼容旧数据。

2026-10-23 确认：

- 仓库改成 monorepo（见“分层”）。
- 深度搜索做成普通工具，接搜索 API，不依赖 Responses 的托管 `web_search`。
- 前端不显示推理过程。中转不返回思考摘要，这一点不再追。
- 登录简化为邮箱加密码（D1）。
- sandbox 权限给全，网络出口不限制；提供精简和完整两种镜像（D7）。这推翻了 2026-10-22 的“网络出口默认关闭”。

## 术语

- **树**：侧栏里的一个会话。包含一条主线和若干分叉，共用一个工作区目录。
- **分叉（branch）**：树里的一条对话，对应一个 pi-durable conversation。主线是树的根 conversation。
- **节点**：分叉中的一条记录（pi-durable entry）。分叉从某个节点长出来。
- **角色**：
  - `main`：主线。
  - `user`：用户分叉。重新生成和编辑消息也产生这种分叉。
  - `agent`：子 agent。
- **模式**：
  - `fork`：带着分叉点之前的上下文。
  - `new`：从空白上下文开始，只带任务说明。
- **Event**：投递给某个分叉的一条外部输入，带来源和是否唤醒。

## 分层

monorepo，用 npm workspaces 管理。旧版（Think）和验证脚本已在 2026-10-23 按用户要求提前删除，迁移时从 git 标签 `legacy-final` 查阅旧代码。

```text
packages/core/       平台无关，pi-durable + pi-ai
  extensions/        会话树 · Event · 子 agent/report · 文件工具（读前检查）· 插件 · Skills · 生成式界面
  env/               ExecutionEnv：文件读写，可选 exec
packages/web/        前端：订阅 watch() 推来的变化，渲染消息、树、小地图、文件面板
hosts/node/          自部署：SQLite 文件 · setTimeout · HTTP/WS · 本地目录 · Docker sandbox（bash）
hosts/cf/            Cloudflare Free：DO SQLite · 闹钟唤醒 · Worker 路由 · DO SQLite 里的工作区（无 bash）
sandbox/             Docker 镜像：slim 和 full
```

## Spec（行为与验收）

编号接路线图 2 的 R1–R30。

### 迁移（阶段 1–3）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R31 | 两种部署方式同一套功能 | 同一组 E2E 在 Node 部署端和 Cloudflare 部署端都通过；唯一的区别是 Cloudflare 上没有 `bash` |
| R32 | 断点恢复 | 回答过程中杀掉 Node 进程（或让 DO 被驱逐）→ 重启后回答从中断处继续，已显示的部分不丢 |
| R33 | 现有功能 | 路线图 2 的 R1–R12、R17–R29 在新架构上重新通过。R13–R16、R30 由 R34–R41 替代；R22 改用 `deferred` 工具和 `tool_search` |
| R34 | Drive 插件 | 定制页里 Drive 是一个插件，可开关、可配置。开启后：附件选择和 `@` 里有 Drive 文件，Skills 可以来自 Drive，有搜索和读取 Drive 的工具；关闭后这些都消失 |
| R62 | 模型凭据 | 设置里每个 provider 可以“填 API key”或“登录订阅”。填 Kimi 或 OpenRouter 的 key → 模型列表出现它们的模型，能对话。自部署上点“登录 ChatGPT”→ 页面显示授权链接，授权后把授权码粘回 → 能用订阅里的模型；token 过期后自动刷新，对话不中断。Cloudflare 部署上只有 API key。退出登录后该 provider 的模型从列表消失。没配任何凭据时仍可用 `.env` 里的默认中转 |

### 树形会话（阶段 4）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R35 | 一树一会话 | 任意分叉、重新生成、编辑、子 agent 都不会让侧栏多出会话；侧栏标题是主线的标题 |
| R36 | 用户分叉 | 任意一条消息的菜单里点“从这里分叉”→ 页面切到新分叉，输入框可以直接继续；主线不受影响 |
| R37 | 版本切换 | 重新生成或编辑后，消息上显示 “‹ 2 / 2 ›”。翻到哪个版本，页面就显示那条分叉，并且可以直接在上面继续（对标 ChatGPT，不再只读） |
| R38 | 小地图 | 有分叉的树在会话页右上角显示小地图：主线是一条主干，分叉从对应位置长出；当前节点绿色；正在运行的分叉有动效；子 agent 和用户分叉的样式不同。只有主线时不显示 |
| R39 | 树的弹窗 | 点小地图 → 居中弹出大矩形（手机上全屏），节点可以缩放、拖动；悬停或点一下看摘要；点节点 → 关闭弹窗，切到那条分叉并滚到该节点。Esc 或点遮罩关闭 |
| R40 | 总结给主线 | 用户分叉的顶栏或菜单里有“总结给主线”→ 这个分叉的 agent 再跑一轮，把分叉点到最新节点的内容整理好，用 `report` 发给主线；主线出现一张折叠的 Event 卡片，不唤醒主线 |
| R41 | 返回主线 | 在任何分叉上都能一键回到主线最新节点 |

### 共用文件系统与读前检查（阶段 5）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R42 | 树内共用目录 | 子 agent 写的文件，主线和其他分叉立刻能读到；文件面板显示的是整棵树的目录 |
| R43 | 先读后改 | agent 没读过一个已存在的文件就直接 `write`/`edit`/`delete` → 报错“请先 read”；新建文件不需要先读 |
| R44 | 改动冲突 | 分叉 A 读了文件 f 之后，分叉 B 改了 f，A 再改 f → A 收到“文件在你读过之后被修改，请重新 read”；A 重新读之后可以改。用户在文件面板删除或上传文件也算修改 |
| R45 | 软隔离 | 文件工具只能访问本树目录和只读的 Skills 目录，越界报错；用户用 `@` 引用其他会话的文件时允许读取那个文件 |

### Event（阶段 6）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R46 | Event 卡片 | 所有不是用户直接输入的消息（子 agent 汇报、定时任务、webhook、系统通知）都显示成折叠卡片：图标、来源、标题、时间；展开看正文 |
| R47 | 唤醒 | `wake` 为真的 Event 送达空闲的分叉 → 立即开始一轮；分叉正在运行 → 排在当前这一轮之后。`wake` 为假 → 只出现卡片，下次用户发言时模型能看到 |
| R48 | 不重复 | 同一个 Event 因为重试或重启被投递两次 → 只出现一张卡片，只唤醒一次 |
| R49 | 定时任务 | 在定时任务页新建“每天 9 点总结昨天的邮件”，选一个会话 → 到点后该会话出现一张定时任务卡片，并开始一轮；可以暂停、删除；重启服务后照常触发 |
| R50 | Webhook | 为某个会话生成 webhook 地址和密钥 → 用 `curl` 带正确签名 POST → 会话出现 webhook 卡片；签名错误返回 401，不产生 Event；可以重新生成或撤销 |

### 子 agent（阶段 7）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R51 | 派生 | 让主线“分头调研这三家公司”→ 主线调用 `agent_spawn` 三次，立即回复“已派出”，不等结果；小地图上出现三条子 agent 分叉，正在运行 |
| R52 | 汇报唤醒 | 每个子 agent 完成后用 `report` 汇报 → 主线出现汇报卡片并被唤醒，综合已有结果回复；三份汇报陆续到达时，主线不会同时跑多轮，而是排队 |
| R53 | 未汇报 | 子 agent 没调用 `report` 就结束（或出错、被中止）→ 系统替它向主线发一张“未完成”卡片，附上最后一条回答和原因 |
| R54 | 限制 | 已有 3 个子 agent 在运行时再 `agent_spawn` → 工具返回错误，说明上限；子 agent 调用 `agent_spawn` → 返回“子 agent 不能再派生”；主线调用 `report` → 返回“主线无需汇报”。三种情况下发给模型的工具列表都不变 |
| R55 | 查看和中止 | 在小地图或弹窗里点子 agent 分叉 → 能看它的完整过程；可以中止它，中止后按 R53 汇报 |
| R56 | fork 与 new | `agent_spawn` 默认 `fork`，子 agent 知道之前的对话；指定 `new` 时子 agent 只看到任务说明 |

### Sandbox（阶段 8，只在自部署）

| 编号 | 行为 | 验收操作 → 期望结果 |
| --- | --- | --- |
| R57 | bash | 自部署上让助手“用 Python 画个图存成 png”→ 助手用 `bash` 运行，png 出现在文件面板。Cloudflare 部署上模型看不到 `bash`，助手说明这里不能运行代码 |
| R58 | 网络与环境 | sandbox 可以访问外网，不设白名单：`curl https://example.com`、`pip install`、`uv add`、`npm install` 都能成功。精简镜像里有 Python、Node、git、`rg`、`zip`、`uv`；完整镜像另有常用 Python 包和编译工具链。设置里可以切换镜像，切换后下次启动容器生效 |
| R59 | 密钥不进 sandbox | 在 sandbox 里 `env`、读文件都找不到任何插件密钥或模型密钥 |
| R60 | 资源与休眠 | 死循环或占满内存的命令到时间被终止，返回错误，服务本身不受影响；空闲一段时间后容器停止，下次 `bash` 时自动启动，文件都在 |
| R61 | 用户之间隔离 | 两个用户的 sandbox 互相看不到文件和进程 |

## Design

### D1 core 与部署层

- 每个用户一个 pi-durable `Harness`，一份存储：
  - Node 上是 `data/users/<userId>/pi.sqlite`。
  - Cloudflare 上是该用户 UserHub DO 的 SQLite，表名加前缀 `pi_`。
  - 宿主自己的表（树索引、Event、定时任务、插件配置）和 pi 共用同一个数据库适配器，保证在同一个事务队列里（pi-durable README “Storage” 一节）。
- 部署层接口：

```ts
interface Host {
  storage(userId): Promise<Storage>          // pi-durable Storage
  onWake(userId, wake): void                 // Node：什么也不做（Harness 自己用 setTimeout）；CF：设 DO 闹钟
  env(userId, treeId): ExecutionEnv          // 文件读写；Node 上带 exec
  secrets: SecretStore                       // 插件密钥，只在宿主侧解密
  publish(userId, frame): void               // 推给前端
}
```

- Node 端：一个进程按用户懒加载 Harness，空闲一段时间后关闭。启动时打开所有存在未完成任务或定时任务的用户，调用 `resume()`。
- Cloudflare 端：UserHub DO 持有 Harness，Chat DO 不再存在。按 pi-durable README 的 DO 示例：
  - 在 `blockConcurrencyWhile` 里打开 Harness。
  - 有任务运行时，用闹钟每 60 秒心跳一次，同时不晚于最早的 sleep。
  - 闹钟触发时调用 `resume()`。
- 模型：默认 provider 是 `.env` 里的中转（`PROVIDER_BASE_URL`、`PROVIDER_AUTH_TOKEN`、`DEFAULT_PROVIDER_MODEL`），用 `createProvider` 注册为 OpenAI Responses 接口。2026-10-23 起只有这一个中转，它兼容 Responses 和 Chat Completions，不提供 Anthropic 接口，模型是 GPT 系列和 GLM。用户自己的凭据见 D11。
- 深度搜索：普通工具 `deep_search`，调用搜索 API（具体服务在阶段 3 选），由模型自己读结果、整理答案。不用 Responses 的托管 `web_search`，所以任何模型都能用。
- 登录（2026-10-23 决定）：两种部署方式都用同一套邮箱加密码登录，实现在 `core` 里。
  - 用户表：`email`、密码哈希（scrypt，Workers 上用 WebCrypto 的 PBKDF2 也可以，二选一在阶段 1 定）、`createdAt`。不开放注册，用户由命令行或管理员页面创建。
  - 会话：登录后发一个 HttpOnly、Secure、SameSite=Lax 的 cookie，服务端存会话记录，可以吊销。WebSocket 握手时校验同一个 cookie。
  - 登录接口按 IP 和邮箱限速。
  - Cloudflare 上 Access 可以继续挡在前面做第二层，但不再是必需的；`userId` 来自我们自己的会话，不再来自 Access JWT。

### D2 树的数据

- 一棵树就是一个 pi-durable 根 conversation，加上从它（或从它的分叉）`fork(entryId)` 出来的 conversation。`new` 模式的子 agent 用 `createConversation()`，在树索引里记它的发起节点。
- 宿主表 `branches`：

```text
id, treeId, conversationId, parentBranchId, forkEntryId,
role(main|user|agent), mode(fork|new), title,
status(idle|running|done|failed|aborted), createdAt
```

- 宿主表 `trees`：`id, title, rootBranchId, activeBranchId, updatedAt, pinned, projectId`。侧栏读 `trees`。
- 重新生成：在被重新生成的回答之前那个节点 fork，再提交同一条用户输入。编辑消息：在被编辑消息的前一个节点 fork，提交新内容。所以“版本”就是从同一个节点长出的、`role=user` 的兄弟分叉。“‹ 2 / 2 ›”在它们之间切换，切过去就是普通分叉，可以继续（R37）。
- `activeBranchId` 记住用户上次所在的分叉，打开会话时回到那里。

### D3 提示词和工具集不变

- 树里所有 conversation 选择同一组 extension，system prompt 和工具列表完全一样，所以 fork 出来的分叉和主线前缀相同，可以命中 prompt cache（是否真的命中见 V3）。
- 角色差异用一条追加的记录表达，自定义 entry kind `app.brief`，模型把它当作一条用户输入：
  - `agent`：“你是子 agent，任务是……；完成后必须调用 `report`；不能调用 `agent_spawn`。”
  - `user`：“这是用户开的分叉；除非用户要求，不要调用 `report`。”
- 不允许的调用由一个 `beforeTool` 钩子拦截，返回 `{ block: "原因" }`（R54）。不使用 `configure({ extensions: { remove } })`，因为它会改变发给模型的工具列表。
- 部署方式之间工具集可以不同（Cloudflare 没有 `bash`），同一部署内不变。

### D4 Event

```text
Event {
  id, userId, target: { treeId, branchId },
  source: { kind: agent | schedule | webhook | system, id, label },
  type: report | tick | webhook | notice,
  title, body, data?,
  wake: boolean,
  status: pending → delivered | failed,
  idempotencyKey, createdAt, deliveredAt?
}
```

- `core.emit(event)`：先写宿主表 `events`（`idempotencyKey` 唯一，重复写入直接返回已有的那条），再投递：
  - `wake=true`：`conversation.submit({ type: "input", requestId: event.id, ... })`，内容是渲染后的事件文本，记录为自定义 entry kind `app.event`，附带 Event 的元数据。分叉忙时排在当前这一轮之后。
  - `wake=false`：作为一条写入（不触发运行）追加到 transcript。
  - `requestId = event.id` 保证重启重投不会重复（R48）。
- 唤醒频率限制：同一个分叉 1 分钟内最多被唤醒 N 次（默认 6）。超出的 Event 改成 `wake=false` 写入，并追加一条系统 notice。
- 前端把 `app.event` 记录渲染成折叠卡片（R46）。
- 来源：
  - **agent**：`report` 工具。
  - **schedule**：用 pi-durable 的自定义任务实现。定时任务是一个 `defineTask`，`sleepUntil(下次时间)` 之后 `emit`，再算下一次。它的持久化、重启后继续、DO 闹钟唤醒都由 pi-durable 和 D1 的唤醒机制负责，两种部署方式通用。宿主表 `schedules` 只存定义：`id, target, cron | at, prompt, enabled`。
  - **webhook**：`POST /hooks/:hookId`。请求头带 HMAC-SHA256 签名和时间戳，宿主校验后 `emit`。密钥加密保存，只在生成时显示一次。
  - **system**：例如子 agent 未汇报（R53）。

### D5 子 agent 与“总结给主线”

- 所有 conversation 都有 `agent_spawn({ task, mode = "fork", title })` 和 `report({ summary, status: done | partial | failed, files? })`。
- `agent_spawn` 按 pi-durable 示例 `23-subagent-background` 的写法：
  1. 检查限制：调用者是主线；同时运行的子 agent 少于 3 个。
  2. 在一个后台锚点任务下创建分叉：`fork` 模式从当前节点 fork；`new` 模式新建 conversation。
  3. 写入 `branches`（`role=agent`），追加 `app.brief`，提交任务。
  4. 立即返回分叉 id。主线不等结果。
- `report`：
  - 在子 agent 里调用：`emit` 一个 `type=report`、`wake=true`、目标为主线的 Event，并把分叉标记为 `done`。
  - 在用户分叉里调用：`wake=false`。
- 未汇报：锚点任务等子 agent 的运行结束。如果期间没有 `report`，就 `emit` 一个“未完成”的 report，附最后一条回答和结束原因（R53）。
- 中止子 agent：中止它的 conversation。锚点任务看到中止后同样发“未完成”。
- **总结给主线**：用户在分叉里点按钮 → 给这个分叉提交一条 `app.brief` 输入：“把从分叉点到现在的内容整理成：目标、结论、关键决定、改过的文件、未解决的问题，然后调用 `report`。”
  - 格式参考 Pi 的 branch summary（Goal / Constraints / Progress / Key Decisions / Next Steps 加文件列表）。
  - 这一轮显示在分叉里，结果作为折叠卡片出现在主线，不唤醒主线（R40）。

### D6 文件系统

- 目录布局（每个用户一份）：

```text
<userRoot>/
  sessions/<treeId>/     树的工作区，agent 的 cwd
  skills/                启用的共享 Skills（只读）
```

  - Node 上 `<userRoot>` 是 `data/users/<userId>/files`。sandbox 容器把它挂载到 `/data`，所以 agent 看到的路径是 `/data/sessions/<treeId>` 和 `/data/skills`。
  - Cloudflare 上的 `ExecutionEnv` 用 DO SQLite 模拟同样的路径。
- 会话自己的 Skills 放在 `sessions/<treeId>/skills/<名字>/SKILL.md`，规则同 R29。
- 读前检查（R43、R44）由我们的 extension 包装 pi-durable 的 `read`/`write`/`edit`，加上自己的 `delete`：
  - 每个 conversation 有一份账本，存在 pi-durable 的自定义文档 `app.ledger` 里，内容是“路径 → 内容哈希”，记录它最近一次读到或写入的内容。重启后账本还在。
  - `read`：读取后记录哈希。只读了部分行的，也记录整个文件的哈希。
  - `write`/`edit`/`delete`：
    - 文件不存在时，`write` 直接新建。
    - 文件存在但账本里没有 → 报错“请先 read”。
    - 当前哈希和账本不同 → 报错“文件在你读过之后被修改：<谁、何时，如果知道>，请重新 read”。
    - 成功后更新账本。
  - `bash` 修改文件不会更新账本，所以之后用工具写这个文件时，需要先重新读。这正是期望的行为。
  - 同一路径的并发写由 pi-durable 按 env id 和路径串行。检查哈希和写入要在同一个串行区间里完成。
- 软隔离（R45）：文件工具把路径解析成真实路径，必须落在本树目录或 `skills/` 之内（`skills/` 只读），否则报错。`@` 引用的其他会话文件由前端把内容作为附件传入，或在本轮临时放行这一个路径。`bash` 不受这层限制，见 D7。
- 删除会话时删除 `sessions/<treeId>/`。

### D7 Sandbox（自部署）

- 镜像有两种，在设置里选，默认精简：
  - `slim`：Debian + Python 3 + Node LTS + `uv` + git、`rg`、grep、find、zip/unzip、tar、curl、wget、jq、`file`、`less`、vim。
  - `full`：`slim` 加上 build-essential、ffmpeg、ImageMagick、poppler-utils、pandoc，以及 Python 包 numpy、pandas、matplotlib、requests、beautifulsoup4、lxml、pillow、openpyxl、python-docx、python-pptx、pypdf、pyyaml。
- 每个用户一个 Docker 容器，`sleep infinity` 作为入口，`/data` 绑定挂载 `<userRoot>`，`skills/` 以只读方式挂载。
- 隔离：
  - 用户之间的隔离靠容器（可选 gVisor `runsc`）。容器名由登录身份推导，不从 URL 取。
  - 同一用户的会话之间不做安全隔离。sandbox 是最小的信任单位。容器里的进程以宿主用户的 uid 运行（2026-10-23 实现时调整：以 root 运行会让写出的文件归 root，宿主进程删不掉），可以 `pip install --user`、`uv`、`npm`，不能 `apt install`。
  - 权限给全只限容器之内：不挂载 Docker socket，不用 `--privileged`，不挂宿主的其他目录。
- `bash`：
  - `docker exec`，cwd 是本树目录。
  - 带超时（默认 120 秒）。
  - 输出有上限，超出部分截断后写入文件。
  - 进程数、CPU、内存设上限。
- 网络：普通 bridge 网络，出口不限制（2026-10-23 用户决定）。
  - 代价：被网页或文件里的提示注入诱导时，agent 可以把工作区文件发到外部。可以接受，因为密钥不在 sandbox 里，工作区里只有用户自己放进去的东西。
  - 容器不能访问宿主服务端口和内网地址（iptables 拒绝私有网段），避免绕过登录调用宿主 API。规则由一个临时的辅助容器（带 NET_ADMIN，共用沙箱的网络命名空间）写入；沙箱本身没有 NET_ADMIN，改不了这些规则。
  - 密钥不进 sandbox（R59）。需要密钥的操作走宿主侧的工具，不走 `bash`。
- 生命周期：第一次 `bash` 时启动，空闲 15 分钟后停止。文件在宿主目录里，容器停止不丢文件。在容器里 `apt install` 的软件包会丢；`uv`、`pip --user`、`npm` 的缓存和用户级安装放在 `/data/.cache`、`/data/.local` 下，随用户目录保留。
- `ExecutionEnv` 的文件读写始终直接访问宿主目录，不经过容器，所以文件面板和读前检查不依赖容器是否在运行。

### D8 插件即 extension

- `src/plugins/catalog.ts` 的声明（名称、说明、设置项）保留。每个插件对应一个 pi-durable extension（工具、system prompt 段落、钩子）。
- 插件开关通过 `configure({ extensions })` 生效。这会改变工具列表，所以只在用户改设置时发生，下一轮生效，可以接受。
- 解密后的密钥只在宿主侧传给工具，不写进 transcript，也不进 sandbox。
- 工具多的插件（例如 MCP、Drive）的工具标成 `deferred`，模型通过 `tool_search` 加载，取代路线图 2 的 `tools_find`/`tools_load`。
- Drive 插件（R34）：
  - 设置项：OAuth 连接、搜索范围、Artifacts 自动保存。
  - 提供 Drive 文件来源（附件、`@`）、Skills 来源（把 Drive Skills 同步到 `skills/`）和 `drive_search`/`drive_read` 工具。

### D11 模型凭据（R62）

- 用 pi-ai 内置的 provider 和认证，不自己写：每个 provider 自带 API key 解析、OAuth 登录和刷新（pi-ai README “OAuth Providers”“Credential Store”）。
- 每个用户一个 `Models`，`credentials` 传入我们实现的 `CredentialStore`：存在宿主的 `SecretStore` 里，用 `TOKEN_ENCRYPTION_KEY` 加密。`list()` 只返回 provider 和类型，不解密。token 刷新在 `modify` 里串行，pi-ai 保证不会重复刷新。
- 设置页：
  - 列出 pi-ai 内置的 provider，每个显示“填 API key”，支持 OAuth 的另有“登录订阅”。
  - 已配置的 provider 的模型进入模型选择列表；`.env` 的中转始终在列表里。
- 订阅登录只在自部署上提供（pi-ai 的 OAuth 流程只能在 Node 上跑）：
  - `models.login(provider, 'oauth', interaction)` 在服务端跑，`interaction` 通过 WebSocket 转给前端：`notify` 的 `auth_url`、`device_code` 显示成链接和验证码，`prompt` 显示成输入框。
  - Anthropic 和 ChatGPT 默认回调到 `localhost`，服务器上收不到。走 `manual_code`：用户授权后把授权码粘回输入框。GitHub Copilot、xAI、Kimi 用设备码，不受影响。
  - Cloudflare 上隐藏“登录订阅”。设备码流程能否在 Workers 上跑，到时候再验证。
- 风险：把 Claude Pro/Max 这类个人订阅接到第三方应用，可能违反对方的服务条款。只给自己用；多用户部署时可以在配置里关掉订阅登录。
- 密钥只在宿主侧使用，不进 transcript，也不进 sandbox（R59）。

### D9 前端协议

- 每个浏览器连接一个 WebSocket 到用户的 Harness。前端订阅“当前树的树索引”和“当前分叉的 `watch()`”。
- 服务端转发 `watch()` 的 Chord 操作，前端在本地应用这些操作，再把 entries 和 `pi.live` 文档整理成消息列表。
- 流式输出来自 `pi.live`。pi-durable 默认每 100 ms 提交一次，Cloudflare 上可以放宽到 300–500 ms。
- 断线重连从当前视图重新开始（pi-durable 不回放历史帧）。
- 发言、中止、fork、版本切换、总结给主线、文件操作都是 WebSocket 上的请求，服务端校验后调用 core。
- 树弹窗的布局：节点按时间纵向排列，主线居中，分叉向两侧展开。超过一定数量时折叠成“+N”，点开再展开。

### D10 测试

- E2E 用 Playwright，跑在 Node 部署端上，模型用 pi-ai 的 faux provider（按脚本返回回答和工具调用）。前端 Mock 引擎和 Mock 部署删除。
- 同一组用例在 `wrangler dev` 上跑一遍 Cloudflare 部署端（R31），`bash` 相关用例跳过。
- 真实模型的冒烟测试在部署前手动跑，覆盖 V1 中列出的中转问题。

## 实现前验证

脚本曾在 `spikes/pi/`（见标签 `legacy-final`），依赖 pi-durable、pi-ai、chord 1.4.0。

| 编号 | 要验证的事 | 结果（2026-10-22） | 不通过时 |
| --- | --- | --- | --- |
| V1 | pi-ai 能通过我们的中转调用模型 | **基本通过。** OpenAI 中转（Responses API）和 Anthropic 中转都能：流式输出、工具调用、带工具结果继续对话、设置思考强度。用 `createProvider` 配置 `baseUrl` 和 `apiKey` 即可，不需要自定义 provider。**未验证：** Responses 的托管 `web_search` 工具（pi-ai 的工具只有函数形式，深度搜索可能要自己写一个 provider 或改成普通工具）；中转没有返回思考摘要（`reasoning` 用量为 0，与旧版行为一致）；OpenAI 中转的缓存读取只在极短的提示下测过（为 0，没有结论）。2026-10-23 换成单个中转（只有 OpenAI 兼容接口）后重跑：流式、工具调用、工具结果、思考强度都通过。2026-10-23 决定：深度搜索改成普通工具（D1），不显示推理过程，这两项不再验证 | 给 pi-ai 写自定义 provider，或在中转前面加一层修正 |
| V2 | pi-durable 能在 Workers Free 计划上运行：打包体积、CPU 时间、DO SQLite 适配器 | 本地部分已验证（2026-10-23）：`wrangler deploy --dry-run` 打包 1.9 MiB / gzip 354 KiB，远低于上限；DO SQLite 适配器在 `wrangler dev` 下跑通 R31、R32（`hosts/cf/test`）。待线上验证：长任务的子请求数（Free 每次调用 50 个）与 CPU 时间 | Cloudflare 部署端降级，或评估 Workers Paid |
| V3 | fork 出来的分叉能命中主线的 prompt cache | **通过。** Anthropic 中转上，主线和 fork 在同一前缀上的 `cacheRead` 都是 5191 个 token；fork 虽然有新的 provider session id，但缓存仍命中。因此子 agent 和用户分叉可以共用前缀，不必特意共享 session id 2026-10-23 在新中转（OpenAI Responses）上重跑：主线 `cacheRead` 2338，fork 只有 444，只命中一部分。OpenAI 的缓存按 `prompt_cache_key`（会话 id）路由，fork 换了 id 就可能落到别的机器。2026-10-23 阶段 4 前验证“同一棵树共用 cache key”：用 `conversationCreated` 把分叉的 `pi.provider.sessionId` 设成父会话的，两次对照中 fork 的 `cacheRead` 都约 1500（不共用约 1400–1600，主线约 7000），没有改善。所以分叉保留各自的 session id，接受部分未命中 | 让同一棵树的分叉共用 session id，或接受缓存未命中 |
| V4 | 自定义 entry kind 能作为“用户输入”提交，也能作为不触发运行的写入追加 | **通过。** `submit({type:"input", entry:{kind:"app.event",...}})` 照常触发一轮并得到回答，transcript 里记录的是 `app.event`；`submit({type:"write", entry:{kind:"app.note",...}})` 空闲时立即追加、不触发运行，模型看不到它的内容。fork 只带到 fork 点为止的记录。关闭并重新打开同一个 SQLite 文件后，根会话、历史和 fork 都在 | Event 改用普通用户输入，元数据另存宿主表 |
| V5 | `watch()` 推给前端的数据量 | **通过。** 一轮 4000 字的流式回答约 26 帧、10.5 KB，最大一帧 4.6 KB；在已有 120 多条记录的会话里同样的回答是 26 帧、10.7 KB，所以帧大小不随历史增长。新连接拿到的完整快照约 57 KB（122 条记录）。多个分叉同时运行的情况未测 | 前端改为按需拉取，或合并帧 |
| V6 | 后台子 agent 的写法（示例 23）在进程被杀后能正确恢复，并且只汇报一次 | **通过。** 2026-10-23：锚点任务用固定的 requestId 提交任务说明、等运行结束，“未完成”通知用固定的去重键。Node 上关闭再打开、Cloudflare 上 SIGKILL workerd 后，子 agent 的回答都接着写完，主线只收到一张卡片（示例在 pi-durable 1.4.0 里编号为 22） | 调整锚点任务的写法 |

## 开发顺序

| 阶段 | 内容 | 依赖 | 退出条件 |
| --- | --- | --- | --- |
| 0 | ADR-0004、本路线图 | — | 用户评审通过 |
| 1 | `core` 骨架 + `hosts/node`：pi-ai 接中转、一个会话的对话、`watch()` 推到前端、faux provider 的 E2E 框架 | V1、V4、V5（已验证，见上） | 本地能流式对话；R32 在 Node 上通过 |
| 2 | `hosts/cf` 追平阶段 1 | V2 | R31、R32 在 Cloudflare 上通过；在独立的预览地址上部署，线上仍是旧版 |
| 3 | 现有功能迁移成 extension：网页、图片、插件配置、附件、`/` 和 `@`、Skills、生成式界面、文件面板、Drive 插件、模型凭据 | 1、2 | R33、R34、R62；替换线上旧版（2026-10-23 替换：`bot.rayama.site` 改由 `gense-v3` 提供，旧版 `gensebot` 保留但不再绑定域名；R34 等 Drive 授权） |
| 4 | 树形会话：树索引、分叉、版本切换、小地图、弹窗、返回主线 | 3、V3 | R35–R39、R41（2026-10-23 完成；侧边“支线”界面改为树的分叉） |
| 5 | 共用文件系统、读前检查、软隔离 | 4 | R42–R45（2026-10-23 完成；用 `@` 引用其他会话的文件时，先复制到本会话的 `attachments/` 再读；读一个已删除的文件后可以重新创建它） |
| 6 | Event：卡片、唤醒、去重、定时任务、webhook；总结给主线 | 4 | R46–R50、R40（R40 要用 `report` 和 Event 卡片，从阶段 4 挪到这里；2026-10-23 完成。每个分支每分钟最多被唤醒 6 次，超出的 Event 只记进对话；webhook 请求体最多 64 KiB，每个会话一个 webhook，密钥只显示一次、加密保存（需要 `TOKEN_ENCRYPTION_KEY`），签名是 `x-gense-signature: sha256=hex(HMAC(密钥, 时间戳.请求体))` 加 `x-gense-timestamp`，可选 `idempotency-key`；错过的定时运行直接跳过，不补发） |
| 7 | 子 agent：`agent_spawn`、`report`、限制、未汇报处理 | 5、6、V6 | R51–R56（2026-10-23 完成。`fork` 模式从本轮回答之前的那条记录分叉，子 agent 看不到主线这一轮还没得到结果的工具调用；“未完成”卡片来源记为系统；`report` 的参数沿用阶段 6 的 `{title, body}`，没有 `status`/`files`） |
| 8 | 自部署 sandbox：两种镜像、Docker、`bash`、资源限制、休眠 | 5 | R57–R61（2026-10-23 完成。沙箱是插件“代码沙箱”，自部署上默认打开，设置里选镜像；容器以宿主用户的 uid 运行，不是 root，所以不能 `apt install`，但写出的文件归宿主所有；网络规则由一个临时的、带 NET_ADMIN 的辅助容器写进沙箱自己的网络命名空间，不改宿主的 iptables；空闲后容器被删除，下次重建；宿主 Docker 的代理设置不传进沙箱；完整镜像另加了 `fonts-noto-cjk`，matplotlib 画中文图表需要它；镜像用 `npm run sandbox:build` 构建，配置见 `.env.example` 的 `SANDBOX_*`） |
| 9 | 整体 UI/UX 走查 | 全部 | 走查记录（2026-10-23 完成，记录见下） |

### 阶段 9 走查记录（2026-10-23）

用 faux 模型的本地 Node 实例（打开代码沙箱），以无头 Chrome 在 1280×800 和 390×844 两种宽度下走了一遍：登录（含密码错误）、首页、对话、`bash` 的成功和失败、工具调用详情、文件面板、编辑消息产生分叉、小地图和会话树弹窗、定时任务和 Webhook、资料、项目、定制（模型、插件及沙箱设置、Skills、记忆、偏好）。页面没有脚本错误。

已修：

1. 工具结果里露出运行时写给模型的 `<harness>` 标记（如命令的退出码）：详情里去掉标记，只留文字。
2. 文件面板“工作区”标题被长路径挤成两行：标题不再收缩，路径自行换行。
3. 代码沙箱的“镜像”设置说“下次启动沙箱时生效”，实际从下一条命令起生效：改了说明。
4. 定时任务列表和“新建定时任务”标题贴在一起：加了间距。
5. 没有记忆时，记忆列表留下一条空的边框：没有记忆就不显示列表。

6. 两个会话同名时，定时任务和 Webhook 的会话下拉框分不清：同名的会话在下拉框和列表里附上最近活动时间。
7. 服务器没配 `TOKEN_ENCRYPTION_KEY` 时要点了“生成 Webhook”才报错：`webhooks` 消息带上 `canCreate`，页面直接提示，不显示生成按钮。

没改：faux 模型直接回显工具结果，所以对话正文里仍能看到 `<harness>`；真实模型不会这样回答。

## 待定

1. 工作区和 Drive 的关系（功能清单问题 8）：工作区是工作目录、Drive 是长期存储，产物什么时候同步到 Drive？
2. 删除会话时是否先提醒导出工作区（功能清单问题 11）。
3. “总结给主线”默认不唤醒主线（本文的建议）。是否要在按钮旁边提供“并唤醒”？
4. 定时任务的时区：默认用浏览器时区记在定时任务里，还是使用全局设置？

## 不做

- Cloudflare 上的 sandbox：需要 Workers Paid 计划。以后改用付费计划时接 Sandbox SDK，`ExecutionEnv` 接口不变。
- worktree、分叉合并：树内共用一个目录，用读前检查代替（H4）。
- 旧数据迁移：实验阶段，旧会话、工作区和插件配置不保留。
- 前端 Mock 部署：由 Node 部署端加 faux provider 代替。
- 子 agent 再派生子 agent：只允许一层（H6）。

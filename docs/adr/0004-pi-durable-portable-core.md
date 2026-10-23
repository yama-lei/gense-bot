# ADR-0004：以 pi-durable 为核心，Cloudflare 与自部署两种部署方式

状态：已决定，2026-10-22。替代 [ADR-0002](0002-think-google-drive.md) 中“运行时用 Think”的部分，并修改 [ADR-0001](0001-cloudflare-free-tier.md)：Cloudflare Free 计划不再是唯一的部署方式，而是其中一种部署方式的约束。行为与开发顺序见[路线图 3](../plans/roadmap-3.md)。

## 背景

路线图 3 要做四件事：树形会话（一棵树对应侧栏里的一个会话，fork 留在树内）、Event（子 agent 汇报、定时任务、webhook 都通过同一个事件唤醒会话）、异步子 agent，以及以后的完整 sandbox。用 `@cloudflare/think` 0.21 做这些有几个硬限制：

- 一个 Chat DO 只有一条对话，活动路径永远是最新叶子，没有切换接口。每个分叉只能是一个单独的 DO，再由 UserHub 拼成树（ADR-0003 第 2 条）。
- Think、`agents` SDK 和 `@cloudflare/computer` 都只能跑在 Cloudflare 上。用户预计将来会自己部署（2026-10-22：“我预感未来我们会选择自己部署，而非用 cloudflare 部署（当然都要支持）”）。
- Cloudflare 的 sandbox（Containers / Sandbox SDK）和 Worker Loader 都只在 Workers Paid 计划提供。

ADR-0002 当时放弃 Pi Durable 的理由是：要拼多个 beta 组件，聊天协议和 UI 映射要自己写。现在的需求正好落在 pi-durable 擅长的地方，而这些代价仍然存在，我们选择承担。

## 考虑过的方案

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| 继续用 Think，分叉各占一个 DO | 不用迁移；有现成聊天协议和 React 客户端 | 树要自己拼；只能跑在 Cloudflare 上 |
| `agents` 0.29 的 `ThinkHarness`（实验性） | 一个 DO 里多个 session，`sessions.fork()`，`beforeToolCall` 可以拦截；仍是 AI SDK，有 `ThinkChat` 协议 | fork 只能复制整条活动路径；不支持运行中插话（steer）；只能跑在 Cloudflare 上 |
| `agents` 0.29 的 `PiHarness`（beta） | 是 pi-durable 的薄封装，帮我们接好 DO 存储和唤醒 | 依赖 `agents` 的 Lifecycle，只能跑在 Cloudflare 上 |
| **直接用 pi-durable，自己写部署层** | 不绑定平台；可以从任意记录 fork；extension 有工具、system prompt 段落、钩子、包装、可恢复任务；有后台子 agent 的示例；支持 steer；pi-ai 对各家模型集成更好 | 实验性，API 无预告变化；没有聊天协议和 UI；现有后端和前端协议要重写 |

## 决定

1. **核心用 `@earendil-works/pi-durable` 和 `@earendil-works/pi-ai`，锁定版本**（2026-10-22 npm 上是 1.4.0，`chord`、`pi-env` 同版本）。不用 `PiHarness`，自己写部署层。
2. **代码分成 `core` 和 `hosts`。** `core` 不引用任何平台 API。部署层只提供四样东西：
   - 存储：pi-durable 的 `Storage`。
   - 唤醒：pi-durable 的 `onWake` 和 `resume()`。
   - 执行环境：`ExecutionEnv`，即文件读写，以及可选的 exec。
   - 传输：HTTP 和 WebSocket。
3. **两种部署方式，功能相同，只差 `bash` 工具：**
   - `hosts/node`（自部署）：
     - 存储：每个用户一个 SQLite 文件。
     - 唤醒：`setTimeout`。
     - 工作区：本地目录。
     - sandbox：每个用户一个 Docker 容器，提供 `bash`。
   - `hosts/cf`（Cloudflare Free 计划）：
     - 存储：每个用户一个 DO，用它的 SQLite。
     - 唤醒：DO 闹钟。
     - 工作区：存在同一个 DO 的 SQLite 里。
     - sandbox：没有，不提供 `bash`。
   - 以后如果 Cloudflare 上改用付费计划，再接 Sandbox SDK，接口不变。
4. **工作区的权威副本在持久存储里，sandbox 只是挂载它。** 文件面板、读前检查都不需要启动容器。
5. **前端协议改为订阅 pi-durable 的 `watch()`**，不再用 Think 的 `useAgentChat`。
6. **砍掉前端 Mock 引擎和 Mock 部署。** E2E 用 Node 部署端加 pi-ai 的 faux provider，测试的是真实后端。

## 后果

- **这是破坏性重写。** 现有会话、工作区文件和插件配置都不迁移（用户 2026-10-22 确认：实验阶段，可以做任何破坏性修改）。迁移期间线上继续跑旧版，Cloudflare 部署端追平之后再替换。
- **pi-durable 是实验性的。** `core` 里直接调用 pi-durable 的地方要集中，升级时按版本记录验证结果。
- **一份存储同一时间只能由一个进程打开。** Cloudflare 上天然满足。自部署要由一个进程管理所有用户的 Harness；将来要横向扩展，得按用户把请求路由到固定的进程。
- **sandbox 内部没有安全边界。** Cloudflare 的文档写明“sandbox 是最小的信任单位”，容器里的进程等同 root。所以一个用户一个 sandbox，会话之间只做工具层面的软隔离。2026-10-23 用户决定 sandbox 权限给全、出口不限制，安全只靠“密钥不进 sandbox”和容器不能访问宿主与内网。
- **登录改成自己做。** 2026-10-23 决定两种部署方式都用邮箱加密码，`userId` 来自我们自己的会话；Cloudflare Access 可选，不再是必需的（路线图 3 D1）。
- **ADR-0003 的几项决定随之失效：**
  - 按需加载改用 pi-durable 的 `deferred` 工具和 `tool_search`。
  - 会话树不再受 Think 活动路径的限制。
  - Codemode 在自部署上可以重新评估。

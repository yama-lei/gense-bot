# ADR-0005：事件驱动、单机 VPS 自部署，借鉴 dsh-superagent

状态：草案，2026-10-31，待评审。替代 [ADR-0004](0004-pi-durable-portable-core.md) 中“Cloudflare 与自部署两种部署方式”的部分；pi-durable 作为核心的决定继续有效。参考实现：[`ref/dsh-superagent-prototype`](../../ref/dsh-superagent-prototype/)（只读参考，其文档 000–003、007 是本 ADR 的依据）。

## 背景

用户 2026-10-31 的决定：

- 聊天本身也是一种事件，整个应用改为事件驱动。
- 来源（Source）需要 GitHub、GitLab、飞书和内置日历。
- 部署目标是 2 核 2 GB 的 VPS 或云主机，不再以 Cloudflare 为约束。
- 这是个人项目，用户很少，可当作单用户。
- 以 superagent 的理念为准：**占用尽可能少的人的注意力，给出尽可能多的价值。** 只在被允许的人请求、或团队写下的规则允许时行动；只在有人必须处理或能用上结果时说话。

dsh-superagent 的核心模型（Source → Trigger → Thread → Eval → Ticket/Mandate → Assignment → Channel）正是这样一个事件驱动的授权与执行模型。本项目已有的 `core/events.ts`（Event）、`schedules`（定时任务）、子 agent 分支和 webhook 已经是它的一半。

## 决定

1. **技术栈保持 TypeScript / Node，单进程，SQLite。** 工作负载是 I/O 等待（模型调用、webhook、SSE），不是计算；2 GB 内存的大头是 sandbox 容器，不是宿主语言。换 Go/Rust 约省 100 MB，不值得重写核心和 pi-durable。Python 没有优势：模型在远端，我们不需要本地 ML 库。
2. **删除 `hosts/cf`**，以及只为 Cloudflare 存在的抽象。`core` 与 `hosts/node` 合并的时机留给实现阶段决定。
3. **单所有者。** 一个数据目录、一个 pi-durable 空间、一个登录凭据；去掉 `users/<id>/`、多用户注册和 `user:add`。以后要多用户，是新的 ADR。
4. **引入 superagent 的领域概念，按需取最小集合：**

   | 概念 | 本项目中的含义 |
   | --- | --- |
   | Source | 事件流：聊天（网页）、GitHub、GitLab、飞书、内置日历。每个 Source 持有自己的读取位置和 bot 身份，丢弃自己发出的消息 |
   | Trigger | 一条不可变事件，带 Source 的原始元数据（actor 等）。同一 Trigger 重复到达只产生一个 Ticket |
   | Thread | 按时间排列的 Trigger，由 Source 定义；同一时刻最多一个 Eval |
   | Eval | 两层：确定性的**准入（gate）**先判断谁能发起工作；只有不明确的情况才调用模型**研判**。决定为 accept / stop / ignore / unavailable |
   | Mandate | accept 授予的权限：范围、强度、Policy 版本、发送者身份。不可变，范围变宽就新开 Ticket |
   | Ticket | 一个获得授权的工作单元。**用树里的一个子 agent 分支实现**，另加 Mandate、Channel 和自己的状态；不另建平行系统 |
   | Subscription | Ticket 与 Thread 的多对多关系；订阅线程上的后续消息直接作为上下文送达 Ticket，不再 Eval，也不增加权限 |
   | Channel | Thread 的写入端：网页回复、评论、PR、飞书回复 |
   | Policy | 每个 Source 的允许名单（该 Source 自己的身份，不跨 Source 映射）、bot 名单与评估规则；带版本号 |

   聊天消息是 Source `chat` 的 Trigger：所有者本人的消息经 gate 直接得到 explicit 的 Mandate，不调用模型研判，体验与现在一致。
5. **执行：完全按 superagent 的做法，每个 Ticket 一个目录和一个执行器会话**，目录由可配置的准备命令（通常是 `git worktree`）创建。这**取代**路线图 3 H4 中“树内共用一个文件系统、不用 worktree”的决定（2026-10-31 用户：冲突时以 superagent 的想法为准）。并发用 worker 槽位限制（2 GB 下默认 2），另留一个额外槽位给人的消息，使新工作不会挤掉人的追问。
6. **密钥与 git 访问（取最简单的做法）：** sandbox 内不放任何令牌。push、开 PR、评论由宿主上的工具完成，令牌只在宿主进程里。
7. **Source 的出站身份：** 默认使用独立的 bot 账号（GitHub、GitLab、飞书各一个），这样别人一眼可知是 agent；每条 GitHub/GitLab 消息以固定一行声明自动化身份，沿用 superagent 的做法。
8. **入站 webhook：** 每个 Source 验证自己的签名（GitHub / GitLab 的 secret、飞书的 token）；用投递 id 去重（GitHub 和 GitLab 会重试）；Trigger 先落库再确认，保证不丢。
9. **出站消息：** 用 outbox 表保存每条消息的回执，写入与排队在同一事务，发送在提交之后。同一 id 绝不排两次；崩溃后继续发送。直接采用 superagent 的设计。
10. **日历：** 先做内置日历，复用现有 `schedules`（规则、时区、幂等触发），增加带时间的事件和提醒。外部日历同步（CalDAV、Google）暂不做。日历是一个普通 Source：需要等待的条件由 Source 产生 Trigger，Eval 不自己排期。
11. **注意力：** 面板和通知只显示需要人处理的事。通知渠道默认是网页面板；飞书私信是否作为推送渠道留待评审（见“待定”）。
12. **成本：** 每个 Source 设速率上限和每日预算上限；超出时 Eval 以 `unavailable` 结束并记录，不静默丢弃。
13. **运维：** Docker Compose + Caddy（TLS）。SQLite 开 WAL，夜间 `.backup`。旧记录的保留策略在实现阶段定；superagent 自己承认没有清理，表会无限增长，我们不重复这一点。

## 考虑过的方案

| 方案 | 结论 |
| --- | --- |
| 重写为 Go / Rust | 内存更省，但丢掉 pi-durable 和现有前端协议，收益约 100 MB，否决 |
| Python（asyncio） | 内存和并发都不占优，没有本地 ML 需求，否决 |
| 直接采用 dsh-superagent | 它绑定 DeepSeek Harness、`danger-full-access`、以 GitHub 仓库为中心，没有聊天界面，否决；只借鉴设计 |
| 保留 `hosts/cf` | 用户不再要求，且阻碍核心简化，否决 |
| 令牌放进 sandbox | 最少代码，但 worker 可读取令牌，与“密钥不进 sandbox”冲突，否决 |

## 后果

- **破坏性改动。** 多用户数据布局、登录方式、`hosts/cf` 都会变化，不迁移（beta 阶段允许）。
- **pi-durable 仍是实验性依赖。** 它没有 Cloudflare 假设（Storage 是普通接口，自带 SQLite 适配），自部署无需额外改动；按 ADR-0004 继续锁定版本。
- **一份存储同一时间只能由一个进程打开**，所以不能多副本。对个人项目这是可接受的。
- **新增外部面：** 公网 webhook 端点。签名校验、去重与速率限制是必须项，不是可选项。
- **与 superagent 的差异（有意为之）：** 有聊天界面；所有者是唯一默认的授权来源；sandbox 使用 Docker 并且不带令牌；不绑定 DeepSeek Harness。

## 原待定问题的决定（2026-10-31，用户授权由我决定）

- **允许名单：** 默认只有所有者。每个 Source 在设置里可以加自己的名单（用该 Source 的身份）；名单之外的人的消息被 gate 忽略并记录，不进入研判，沿用 superagent “从窄开始”的原则。
- **飞书私信推送：** 默认只在网页面板显示“需要你”的事；配置了飞书 Source 后，可以单独打开私信推送，默认关闭。
- **`app.event` 与 Trigger：** 合并为一个概念。Trigger 是持久化的事实，Event 只是模型看到的 `<event>` 文本，由 Trigger 渲染，不再是两种记录。
- **Ticket 与分支：** 一对一，Ticket id 就是分支 id；Mandate、Channel、状态放在按这个 id 索引的表里，不另建平行的存储。

# 路线图 4：事件驱动与 VPS 自部署

状态：阶段 1 已完成（2026-10-31）；阶段 2 的事件驱动部分并入[路线图 5](roadmap-5.md)，阶段 3–8 按路线图 5 的决定搁置；单所有者已被[路线图 6](roadmap-6.md) 的多用户取代（ADR-0006）。决策依据见 [ADR-0005](../adr/0005-event-driven-vps.md)。

## Intent（2026-10-31 讨论记录）

| 编号 | 用户的话（摘录） | 整理后的目标 |
| --- | --- | --- |
| E1 | “Chat itself is a event. Switch to event-driven.” | 网页聊天消息与 webhook、定时任务一样，都是 Source 产生的 Trigger |
| E2 | “github, gitlab and feishu and builtin calander is needed” | 四个 Source：GitHub、GitLab、飞书、内置日历 |
| E3 | “switch to VPS/Cloud deploy (about 2H2G) rather than cloudflare only” | 以 2 核 2 GB 为预算；Cloudflare 不再是约束 |
| E4 | “Assume its a personal project without many user” | 单所有者 |
| E5 | “Use ticket” / “Follow superagent” | 工作单元是 Ticket；执行方式（每 Ticket 一个目录与执行器会话）按 superagent |
| E6 | “If you dont know what is the best practice, do the simplest way” | 不确定时取最简单的做法（密钥不进 sandbox，由宿主工具代做） |
| E7 | “choose one that best fits the idea of superagent… If you dont know how to design leave it as compatible” | 有成熟方案的问题取最符合 superagent 理念的；没想清楚的留出兼容空间 |

## 阶段（草案）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 1 | 单所有者清理：去掉 `hosts/cf` 与多用户；Docker Compose + Caddy 部署；SQLite 备份 | 在 2 GB 机器上启动，内存余量可测 |
| 2 | 聊天变成事件：`chat` Source，Trigger 落库，所有者 gate | 现有聊天行为不变，e2e 通过 |
| 3 | Eval gate、Mandate、Ticket（对应子 agent 分支）、Subscription；outbox；worker 槽位 | 非所有者消息默认被拒绝并记录；Ticket 重启后可恢复 |
| 4 | GitHub Source：webhook 验签与去重、评论回复、PR；bot 账号；宿主工具代为 push | 在测试仓库里 @agent 能得到 PR |
| 5 | 内置日历 Source：事件、提醒、重复规则 | 到点产生 Trigger，崩溃后不重复也不丢 |
| 6 | GitLab Source | 同阶段 4 |
| 7 | 飞书 Source | 同阶段 4，并能作为通知渠道（若评审同意） |
| 8 | 面板：只显示需要人处理的 Ticket；预算与速率上限 | 面板首屏回答“现在有什么要我处理” |

## 阶段 1 记录（2026-10-31，分支 `chore/single-owner`）

- 删除 `hosts/cf`、`SqliteFiles`（SQLite 里的工作区）、`arm`（DO 闹钟）、`oauth` 开关和 `/api/admin/users`。
- 单所有者：只有密码，没有邮箱，用 `npm run passwd` 设置；改密码会退出所有登录。登录、会话、app 表与 pi-durable 存储放在同一个 `data/gense.sqlite`，文件在 `data/files/`。Webhook 路径改为 `/hooks/<id>`，沙箱容器只有一个 `gense-sandbox`。
- 旧的 `data/app.sqlite` 与 `data/users/` 不迁移（用户决定从零开始），新服务不读它们。
- 部署：`Dockerfile`、`compose.yaml`（app + Caddy，沙箱镜像用 `--profile sandbox` 构建）、`deploy/Caddyfile`。app 容器 `mem_limit` 768 MB，沙箱默认 1 GB。
- 备份：每小时检查，最新副本超过一天就 `VACUUM INTO` 一份到 `data/backups/`，默认保留 7 份；重启不会多拷。
- 内存（faux 模型，不含沙箱，本机 Node 24.14）：空闲 RSS 142 MB；10 个会话同时回答时峰值 168 MB。

## 与路线图 3 的差异

- H8、H9 中“同时支持 Cloudflare”作废。
- H4 作废：冲突时以 superagent 为准，每个 Ticket 一个目录与执行器会话。
- 多用户登录（D1）改为单所有者。

## 参考：superagent 中不采用的部分

- 绑定 DeepSeek Harness、tmux、`danger-full-access` 的执行方式。
- 以单个 GitHub 仓库为中心的假设。
- 面板的七个标签页（我们已有聊天界面，只加“需要你”的视图）。

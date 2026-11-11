# 调研：GenseBot 能否直连用户本地的 hc

状态：2026-11-11，由调研 agent 完成，Claude 整理。对应 roadmap-6 的 I6。结论先行：主线用反向 WSS bridge（方案 A），Tailscale 只作为自托管用户的可选通道；Tailscale OAuth apps 不适合多用户产品。

## 0. 先更正:你给的链接和你在用的 `hc` 不是同一个东西

| 名称 | 是什么 | 与本任务的关系 |
|---|---|---|
| **Tomyail/herdr-connect**(你给的链接) | iOS 手机 App 加一个 Go 守护进程(`herdr-connect`)。守护进程包装的是 `herdr agent list` 之类的命令(herdr 是 `ogulcancelik/herdr`,另一个终端复用工具)。手机通过 mDNS 在局域网发现它,走 HTTPS 访问 TCP 9808。 | 不是 `hc`,也没有 `hc` 的调度能力。它只是一个手机遥控器。 |
| **herdrdev/herdr-core**(`hc`,本仓库 skill 里用的) | Rust 写的终端/agent 运行时。核心守护进程加每个终端一个 holder 进程。CLI 是 `hc run/send/read/wait/attach/machine/exec/file`。 | 这才是你要调度的对象。 |

两者的详细信息:

- **herdr-connect**
  - 配对:一次性二维码,之后每个设备一个 bearer token。
  - 传输:自签 ECDSA P-256 证书,按 SHA-256 指纹固定(pinned TLS)。
  - 限制:只在局域网或 VPN 内使用。官方明说"不要把 9808 暴露到公网";消息层 E2EE 和官方 relay 都是"未来里程碑"。
  - 它的 API 是为手机设计的,不适合给服务端当调度接口。

- **herdr-core / hc**
  - 许可证:Apache-2.0。协议状态是 preview(generation 1,0.x)。
  - 协议:JSON-RPC 2.0,在 Unix socket(Windows 是 named pipe)上每行一条消息。`hello {framed:true}` 之后切换为二进制帧,用来做终端 attach 流(可选)。
  - 方法集合(来自 `schema/hc.openrpc.json`):`terminal.run/list/get/send/read/wait/interrupt/kill/rm/put/attach`、`machine.exec`、`file.read/write/edit`、`events.subscribe`、`doc.get/set` 等。
  - 事件:`events.subscribe` 推送 `status/turn/finished/...` 事件,每 15 秒一个 heartbeat,落后时给 `missed` 加新快照。
  - **没有任何网络监听、没有鉴权**。`docs/security.md` 写得很直白:"There is no separate API password or per-client permission check";能连上 API 的人就等于该账户的 shell,"不是沙箱,也不是 agent 的权限代理"。
  - 唯一的跨机方式是 `hc machine add --via '<命令>'`,以及 `hc connect`(把同一协议搬到 stdin/stdout)。`ssh box hc connect` 就是一个远端 core。
  - 信任完全交给承载通道,hc 自己不加密、不认证远端用户。
  - 模板:`~/.config/herdr-core/templates/*.md`(本仓库 `.agents/skills/hc/templates`),用 `hc run --bg --name X --cwd D <template> "<task>"` 派发。

## 1. 可行性结论

**可行,但 hc 在今天不能"被动地被连"。** 它缺三样东西:网络入口、认证、授权范围。能直接复用的是 JSON-RPC 协议本身,以及 `--via` 和 `hc connect` 这两个"字节管道"接口。所以关键问题是:**谁来提供一条可信的、双向的字节管道,以及管道上的身份和授权。**

对你"OAuth apps 能不能解决"的回答:**基本不能,不适合做多用户 SaaS 的主路径。**

- 来源:`https://tailscale.com/docs/features/oauth-apps`、`https://tailscale.com/docs/features/oauth-apps/device-provisioning`。
- 要求:OAuth app 和每个授权用户必须在同一个 tailnet,官方明说"不支持其他 tailnet 的用户"。
- 作用:它只能给**你自己的 tailnet** 铸造设备 auth key(`auth_keys:create:once`,令牌 1 小时有效、单次使用、无 refresh)。
- 后果:每个用户有自己的 tailnet(个人 tailnet 是 Tailscale 默认形态),用户无法通过你的 OAuth app 授权。除非你把所有用户都拉进**你的**tailnet,也就是你自己托管所有用户的 tailnet 身份,这在多用户产品里既不现实,又改变了信任模型。
- 它只适合"自用或团队内部"。你笔记里"某天用它连用户桌面"的设想,只在"所有用户都是同一组织、同一 tailnet"时成立。

## 2. 候选架构

### A. 反向连接:hc 侧装一个出站 agent,不依赖 Tailscale(推荐主线)

```text
用户桌面                                      VPS (GenseBot)
hc core ─unix sock─ gense-bridge ──出站 WSS(TLS)──► /bridge  (Node, 认证后复用连接)
                    (小进程,持有该用户的 device token)       │
                                                     用户 A 的 HcSession(JSON-RPC 管道)
                                                     │
                              MCP server("hc" 工具集)或 Channel ◄── Agent 会话
```

- **做法**:桌面上跑一个小 daemon(Go/Node/Rust 皆可,约几百行)。它连本机 hc socket,并出站连到 GenseBot 的 WSS 端点,把 hc 的行 JSON-RPC 原样透传(或做一层白名单过滤)。VPS 一侧把这条 WS 当 `--via` 的等价物,直接向它发 JSON-RPC。
- **配对**:网页登录后生成一次性配对码,在桌面运行 `gense-bridge pair <code>` 换取一个设备令牌。服务端只存哈希,令牌可单设备撤销。和现有飞书配对码的体验一致(架构文档里已有"十分钟、一次性、不可重放"的机制可复用)。
- **安全模型**
  - 可达性:只有"持有该用户 device token 且已登录的那个会话"能到那台桌面;其他用户无路径。桌面不开任何入站端口,穿 NAT 无障碍。
  - 授权:**必须在 bridge 里做,因为 hc 自己不做**。建议默认只放行 `terminal.run`(限定模板与工作目录)、`send/read/wait/interrupt/list/get`,禁用 `machine.exec`、`file.*`、`terminal.attach`、`machine.add`,否则等同于把用户桌面的完整 shell 交给 LLM。
  - 吊销:网页上删除设备,服务端关闭连接并作废令牌;bridge 侧也可本地 `unpair`。
  - 风险:agent 被提示注入后可以对用户桌面发指令。需要用户可见的审批(高危操作确认)和审计日志。
- **hc 要改什么**:**不用改**。只新增 bridge 这个独立组件;`hc` 只当本地 socket 用。
- **GenseBot 要改什么**:WSS 端点和设备令牌表(新增 `devices` 表);`HcSession` 客户端;一个 MCP server 或内置插件暴露工具(见第 3 节);多用户隔离(目前架构明确是"单所有者、单 SQLite",见 `docs/design/architecture.md`)。
- **工作量**:M。最大的不确定项是多用户化本身,不是 bridge。

### B. VPS 以 tsnet 加入用户的 tailnet(每用户一个节点)

```text
VPS: GenseBot ─ 每用户一个 tsnet 节点(进程内/侧车) ─Tailscale─► 用户桌面: hc 经 sshd 或 socat 暴露
```

- **做法**:用户在自己的 tailnet 生成 auth key(或你引导他走 OAuth),VPS 用 tsnet 用这把 key 注册成该用户 tailnet 的一个设备;再通过 `hc machine add --via 'ssh ...'` 或自写的 TCP 桥访问桌面。
- **问题**
  - tsnet 是 Go 库;GenseBot 是 Node。需要写 Go 侧车,每用户一个 `tsnet.Server`,各自维护 state 目录。
  - 用户要把一把**长期有效、可访问其整个 tailnet** 的 auth key 交给第三方,这是很重的信任交换。除非配合 ACL 把该节点(打 tag)限制到只能访问那台桌面的一个端口。很多用户不会配置。
  - 桌面上仍然没有 hc 的网络入口,仍要靠 sshd、`socat`、或自写桥,等于 A 方案多了一层。
  - 自动化用户 tailnet 配置没有官方的跨 tailnet OAuth 路径。
- **安全**:靠用户自己的 ACL。吊销是在用户的 Tailscale 控制台删节点或 key。你对授权范围没有控制权。
- **工作量**:L,且运维负担最重。

### C. 节点共享(Node sharing):用户把桌面共享进**你的**tailnet

```text
用户 tailnet 的桌面 ──share──► 你的 tailnet(GenseBot VPS 在里面) ──► 桌面:sshd/桥
```

- 来源:`https://tailscale.com/docs/features/sharing`。
- **做法**:用户生成邀请链接,你的 tailnet 的某个账号接受。VPS 通过 `<host>.<用户tailnet名>.ts.net` 访问桌面。
- **限制**
  - 只有 Owner、Admin 或 IT admin 能分享和接受。
  - 被共享节点默认被隔离,只能收连接,不能发起连接,这正好对我们有利。
  - 带 tag 的机器不能共享。
  - 接收者是你的 tailnet 里的**一个账号**,你的 VPS 要同时拥有所有用户共享进来的节点。你的 tailnet 会混入大量陌生人的机器,在 ACL 上要非常小心(文档特别提醒 `*` 通配会无意包含受邀用户)。
  - 链接分享仍是 beta。
  - 同样需要桌面上有 hc 的网络入口。
- **安全**:隔离靠你自己写 grants。吊销是用户取消分享。
- **工作量**:M-L。用户体验差(要手动走分享流程),且依赖 Tailscale 账号。适合"少数高级用户的内测",不适合做产品主线。

### D. Tailscale Funnel / Serve(不推荐)

- 用户在桌面用 Funnel 把本机服务暴露到公网,GenseBot 作为公网客户端访问。
- hc 没有网络服务,要自己做 HTTP 代理,并且**自己做鉴权**,否则等于把 shell 放到公网(Funnel 公开可达)。
- 比 A 多了暴露面,又比 A 多了 Tailscale 依赖,没有优点。`Serve`(仅 tailnet 内)则只是 B 的变体。

### 对比

| 方案 | 谁能到桌面 | 吊销 | hc 改动 | GenseBot 改动 | 工作量 |
|---|---|---|---|---|---|
| A 反向 WSS bridge | 只有持令牌的 GenseBot 会话 | 删设备令牌,秒级 | 无 | 端点、设备表、MCP/插件 | M |
| B tsnet 每用户 | 取决于用户 ACL | 用户在 Tailscale 删 key | 无(要另加桥) | Go 侧车、key 管理 | L |
| C 节点共享 | 你的 tailnet 内 ACL | 用户取消分享 | 无(要另加桥) | 共享流程、ACL 运维 | M-L |
| D Funnel | 公网 | 关 Funnel | 要加鉴权代理 | 少 | M(风险大) |

## 3. 在 GenseBot 里怎么接

结合 `packages/server/src` 的现状:

- **`channels/channel.ts` 的 `Channel` 接口**(`start(ingest)/deliver/render`)是"外部消息进来触发会话,最终结果经 outbox 发出去"的模型。hc 的 `hc send` 汇报和 `events.subscribe` 的 `turn/finished` 事件,确实可以映射为"入站 Trigger"(子 agent 完成时唤醒主会话),用 `Channel` 比较自然。
- **MCP 路径**:`plugins/mcp/host.ts` 目前只支持**远程 Streamable HTTP**。因此可以把 hc 包装成一个 MCP server(工具如 `hc_run`、`hc_send`、`hc_read`、`hc_wait`、`hc_list`、`hc_interrupt`),部署在 VPS 上,背后经 A 方案的管道到用户桌面。这样 agent 一侧零改动,工具命名遵循现有的 `mcp__<server>__<tool>`。缺点:MCP 是请求/响应模型,"agent 完成后主动通知"要靠 `hc_wait` 轮询,或另走 Channel 补一条回调。
- **建议组合**:
  - 工具调用(派发、发消息、读屏)走 **MCP 或内置插件**。
  - 完成/阻塞/错误的异步通知走 **Channel 形式的 Trigger**(基于 `events.subscribe`)。
  - 这样既复用现有的准入、去重、outbox 恢复机制,又不用改 MCP host。
- **多用户前提**:`docs/design/architecture.md` 明确"一个进程、一个所有者、一个 SQLite",`roadmap-5.md` 把多用户划在本轮之外。设备令牌、`HcSession` 池、工具作用域都需要 per-user。**这是该功能的真正前置依赖**,比 bridge 本身的代价大。

## 4. 推荐

1. **主线选 A(反向 WSS bridge)**。理由:不依赖用户有 Tailscale;桌面零入站暴露;吊销和授权范围都在你手里;hc 不用改。
2. **bridge 必须做方法白名单与目录/模板限定**,默认不放行 `machine.exec`、`file.*`、`attach`。这是整个安全模型的核心,因为 hc 本身没有权限层。
3. **Tailscale 作为可选的"高级/自托管用户"路径**:让用户自己在 VPN 内跑 bridge,GenseBot 地址写成 tailnet 内地址。你的单所有者场景下,"你自己的 tailnet + 你自己的桌面"今天就能用,不需要 OAuth app:VPS 和桌面都装 tailscale,`hc machine add --via 'ssh user@desktop'`,从 VPS 上的 `hc` 去管桌面。**这是最低成本的验证路径(S)**,可以先于多用户化做。
4. OAuth apps 仅在"全员同一 tailnet(例如团队内部版)"时才有价值,不要作为 SaaS 方案的基础。

## 5. 开放问题

1. **多用户何时落地?** 它决定 A 的数据模型(设备表挂在用户上)。
2. **bridge 用什么语言和分发方式?** 候选:Node(与 GenseBot 同栈,但用户需装 Node)、Go 或 Rust 单二进制(分发友好)。是否要内置到 hc 里作为上游特性(例如向 herdr-core 提 `hc relay` 的 issue)?
3. **审批策略**:agent 派发到桌面是否每次需要用户在网页或飞书确认?默认策略是什么?
4. **跨平台**:Windows 用 named pipe,bridge 要兼顾。
5. **协议稳定性**:hc 是 preview(0.x),但有 `released.openrpc.json` 做兼容保证,`hello` 里有版本和 feature 协商。bridge 需要跟踪。
6. **Codex 须用 `--no-daemon`**(skill 里的约束),模板和 bridge 的 `terminal.run` 白名单要一并考虑。
7. 我没读到 `commands.md`、`herdr-connect` 的 `docs/` 协议细节和 tsnet 的多节点/state 目录说明,上面对 tsnet 的"每用户一个节点"属于推断,选 B 前需要原型验证。

## 来源

- herdr-connect:`https://github.com/Tomyail/herdr-connect`(README、`SECURITY.md`)
- herdr-core:`https://github.com/herdrdev/herdr-core`,其中 `docs/security.md`、`docs/machines.md`、`schema/README.md`、`schema/hc.openrpc.json`(通过 `gh api` 读取)
- 本地 skill:`/mnt/data/linux/repos/gense-personal-agent/.agents/skills/hc/SKILL.md`、同目录 `remote.md`、`install.md`
- Tailscale:`https://tailscale.com/docs/features/oauth-apps`、`.../oauth-apps/device-provisioning`、`.../features/sharing`、`.../features/tsnet`;本地 `/mnt/data/linux/repos/gense-personal-agent/docs/inbox/tailscale.md`
- GenseBot:`/mnt/data/linux/repos/gense-personal-agent/docs/design/architecture.md`、`packages/server/src/channels/channel.ts`、`packages/server/src/plugins/mcp/host.ts`、`docs/plans/roadmap-5.md`


## 6. 补充（2026-11-11，与用户讨论后）：每个用户各自的 Tailscale 连接

用户的目标：Agent 通过 Tailscale 操作用户电脑上的代码，或者连用户在本地暴露的 MCP 服务器。

- **“用 Tailscale 登录”的一键 OAuth 做不到跨 tailnet**：OAuth app 只接受和它同一个 tailnet 的用户（见 `docs/inbox/tailscale.md` 的 Limitations）。
- **但“每个用户一条连接”是做得到的**，只是由用户自己在**自己的** tailnet 里授权，而不是走我们的 OAuth app：
  1. 用户在自己的 Tailscale 后台建一个 OAuth client（client credentials，只给 `auth_keys` 权限，限定一个 tag，例如 `tag:gense`），把 client id / secret 填进 GenseBot。它不像 auth key 那样最多 90 天过期，用户随时可以在自己后台删除来撤销。
  2. GenseBot 用它为这个用户签发临时（ephemeral）auth key，以 `tag:gense` 的身份加入**该用户的** tailnet，每个用户一个独立节点。
  3. 用户在自己的 ACL 里只放行 `tag:gense` → 自己电脑的某个端口（例如本地 MCP 的 `:8931`）。能到哪里完全由用户控制。
- **接入方式**：节点由一个 userspace 模式的 `tailscaled`（每用户一个容器或进程，开 SOCKS5/HTTP 代理）提供；Node 侧的 MCP 客户端经这个代理访问 `http://<电脑名>:<端口>/mcp`。这样用户本地暴露的 **MCP 服务器直接走现有的 MCP 插件**（Streamable HTTP），只是多了“经由 Tailscale”这个网络选项。
- **操作代码**：在电脑上把 hc 包成一个本地 MCP 服务器（带第 4 节的方法白名单），就落到同一条路上。也就是说 Tailscale 路线和方案 A 的区别只在传输层：A 是电脑主动连出来，不需要 Tailscale；这条路线需要用户有 Tailscale 并配置 ACL，但不用我们分发 bridge 程序。
- **代价**：每个用户多一个 `tailscaled`（约几十 MB 内存）；用户要会建 OAuth client 和写 ACL（我们给分步指引和 ACL 片段）。

建议：两条路都做成“MCP 服务器的传输选项”。先做 Tailscale 路线（只需要用户已有的 Tailscale，加上通用的本地 MCP），bridge 作为不用 Tailscale 的用户的备选。时机在多用户（阶段 D）之后。

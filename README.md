# GenseBot
My implementation for [生成式软件工程](https://jyywiki.cn/GSE/2026/). 


## Roadmaps
- [] Memory
- [] Rountine Tasks
- [] Antifacts (Docs, Images)
- [] Emails 
- [] Google Worksapces
- [] Chat on APP
## 本地运行

`make` 列出所有命令。

```bash
cp .env.example .env           # 填 PROVIDER_*、TOKEN_ENCRYPTION_KEY
make install
make passwd                    # 设置登录密码（单所有者，ADR-0005）
make sandbox                   # 可选：bash 沙箱镜像；不用沙箱就在 .env 里设 SANDBOX=0
make dev                       # 前端 http://localhost:5173，服务端 :8787
make check                     # protocol/server 类型检查 + 服务端全部测试
```

`make docker-dev` 在本机跑和线上一样的 app 容器（不带 Caddy），地址 http://127.0.0.1:8787，数据放在 `data/docker/`，与 `make dev` 的数据分开；密码用 `make docker-passwd` 设置，`make docker-down` 停止。

数据都在 `DATA_DIR`（默认 `data/`）：`gense.sqlite` 是登录、会话与 pi-durable 状态，`files/` 是工作区文件，`backups/` 是每天一份的数据库副本（默认保留 7 份）。恢复：停服务，把一份副本放回为 `gense.sqlite`，删掉旁边的 `-wal`、`-shm` 文件后启动。

## 部署到 VPS

目标是 2 核 2 GB 的单机（[ADR-0005](docs/adr/0005-event-driven-vps.md)）。需要 Docker 与 Compose，域名的 A 记录指向这台机器。

```bash
git clone <repo> gense-bot && cd gense-bot
cp .env.example .env           # 另填 GENSE_DOMAIN、GENSE_DATA（绝对路径）、GENSE_UID/GID、DOCKER_GID
make deploy                    # 第一次会先构建沙箱镜像
docker compose exec app npm run passwd
```

- Caddy 自动申请 TLS 证书，并把 HTTPS 与 WebSocket 转给 `app`。
- `app` 通过挂载的 Docker socket 启动沙箱容器；能控制这个进程就能控制本机的 Docker。令牌只在 `app` 进程里，不进沙箱。
- 沙箱按文件在宿主上的路径挂载，所以 `GENSE_DATA` 在容器内外是同一个路径。
- 更新：在服务器上 `git pull && make deploy`；或在自己电脑上 `make deploy-remote DEPLOY_HOST=user@host`（默认目录 `~/gense-bot`，用 `DEPLOY_DIR` 改）。
- 日志：`make docker-logs`。

## 路线图 5 后端

后端在 `packages/server`（`@gense/server`），浏览器契约在 `packages/protocol`。`npm run check:server` 检查这两个包并运行服务端全部测试；不检查另一个分支正在重写的网页。旧版数据库不迁移，请为本版使用新的 `DATA_DIR`。

在 `.env` 中设置 `PUBLIC_URL=https://bot.example.com` 和稳定的 `TOKEN_ENCRYPTION_KEY`。飞书的 App ID / App Secret 在渠道页填写，Secret 加密入库，不放进 sandbox。飞书应用需启用机器人能力和**长连接**事件订阅 `im.message.receive_v1`，开启接收私聊/群 @ 消息、读取话题消息、发送/更新消息、下载/上传图片和文件所需权限，并发布应用版本。无需公网事件回调。

在渠道页启用飞书或 Lark，生成配对码，十分钟内私聊发给 Bot。之后私聊持续对话；群里需 @Bot，按话题分会话。支持 `/new`、`/stop`、`/model`、`/model <provider/id>`、`/help`。群回复留在原话题；网页继续对话不会发回飞书。卡片中的链接使用 `PUBLIC_URL`。附件下载上限 20 MB，发送文件上限 30 MB；超过平台限制时通过网页下载。

插件页可添加 Streamable HTTP MCP 地址和可选请求头；请求头及 OAuth 凭据加密保存。OAuth 使用 `PUBLIC_URL/api/mcp/callback`，需要服务器支持动态客户端注册。默认超过 20 个工具时由 `tool_search` 按需加载。界面资源由后端按固定协议提供，沙箱 iframe 由前端维护。

Skills 支持上传 ZIP（可含多个 Skill）或无凭据的 HTTP(S) Git 地址，可指定 ref/path。宿主需 Git（生产镜像已包含）。完整目录及来源保存在数据库，启用的文件位于 `<DATA_DIR>/files/skills/`；脚本可通过 sandbox 的 bash/Python/Node 解释器运行。安装最多 2,000 个文件、解压后 50 MB，拒绝符号链接和越界路径。安装临时文件位于 `<DATA_DIR>/skill-tmp/`，操作结束后清理。

架构与逐阶段测试记录见 [architecture](docs/design/architecture.md) 和 [backend notes](docs/plans/roadmap-5-backend-notes.md)。

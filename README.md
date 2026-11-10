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

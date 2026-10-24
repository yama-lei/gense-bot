# Cloudflare 部署

Worker 只处理 `/api/*` 和 `/ws`，其余请求由静态资源（`packages/web/dist`）直接返回。一个 `Accounts` Durable Object 存账号和登录会话，每个用户一个 `UserHub` Durable Object，里面是这个用户的 pi-durable Harness 和 WebSocket 连接。

- 本地：在仓库根目录运行 `npm run dev:cf`。不想调用真实模型时，用 `npx wrangler dev --var GENSE_FAUX:1` 换成假模型。
- 测试：`npm test -w @gense/host-cf` 会起 `wrangler dev`，覆盖 R31 和 R32。
- 添加用户：Workers 上没有命令行，设置 `ADMIN_TOKEN` 后调用接口：

  ```bash
  curl -X POST https://<host>/api/admin/users \
    -H "authorization: Bearer $ADMIN_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"email":"a@example.com","password":"..."}'
  ```

  同一个邮箱再调用一次就是重设密码。
- 部署：先用 `wrangler secret put` 设置 `PROVIDER_BASE_URL`、`PROVIDER_AUTH_TOKEN` 和 `ADMIN_TOKEN`，`DEFAULT_PROVIDER_MODEL` 可以作为 var 或 secret；然后在仓库根目录运行 `npm run build && npm run deploy -w @gense/host-cf`。Worker 名是 `gense-v3`，绑定正式地址 `bot.rayama.site`（2026-10-23 从旧版 `gensebot` 换过来），`workers.dev` 地址关闭。正式地址前面仍有 Cloudflare Access，先过 Access 再用邮箱和密码登录。

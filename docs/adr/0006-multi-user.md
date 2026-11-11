# ADR-0006：多用户，邮箱注册，BYOK 加管理员共享的模型

状态：草案，2026-11-11，待评审。替代 [ADR-0005](0005-event-driven-vps.md) 决定 3（单所有者）；ADR-0005 的其余决定（单进程、Node、SQLite、事件模型）继续有效。

## 背景

用户 2026-11-11 的决定：

- 实现多用户，用邮箱注册和登录，暂时不做邮箱验证码。
- 用户可以自带模型密钥（BYOK）；管理员也可以在后台登记一个所有人都能用的模型提供方。以后做成订阅制并收费。
- Bot 每人一个，不共享；MCP 和 Skills 按用户隔离。
- 暂时不考虑资源占用。

现状：`UserSpace` 已经是“一个人的全部状态”（会话、插件、Skills、凭据、飞书渠道、定时任务）；BYOK 已经由 `agent/credentials.ts` 按空间加密保存；主机的 relay（`.env` 的 `PROVIDER_*`）已经对空间可见。单所有者只体现在宿主层：`platform/auth.ts` 的 `owner` 表、`server.ts` 里唯一的 `space`、`data/files/` 这一个目录。

## 决定

1. **一个用户一个 `UserSpace`，各用各的 SQLite 文件和文件目录。** `data/app.sqlite` 只放账号、登录会话、共享模型和使用记录；`data/users/<userId>/space.sqlite` 和 `data/users/<userId>/files/` 放用户自己的一切。删除用户就是删除这个目录。不在同一个库里加 `user_id` 列：隔离靠文件边界，不靠每条查询都记得加条件。
2. **进程启动时打开所有未停用用户的空间。** 飞书长连接、定时任务和 webhook 不能等用户上线才开始。用户多到需要按需打开，那是以后的事（资源问题本轮不考虑）。
3. **账号**：邮箱 + 密码（沿用现在的 PBKDF2），不发验证码。角色只有 `admin` 和 `user`。第一个注册的人自动成为 admin；admin 可以关闭开放注册、停用用户。`npm run user:admin <email>` 在服务器 shell 里提升 admin，作为找回手段。
4. **模型来源有两种，用户在模型选择器里同时看到：**
   - **共享**：admin 在后台登记的提供方（取代 `.env` 的 `PROVIDER_*`），密钥用 `TOKEN_ENCRYPTION_KEY` 加密存在 `app.sqlite`，用户看不到密钥。
   - **自带（BYOK）**：现有的 pi-ai 凭据存储，不变。
5. **每次模型调用都按用户记账**：用户、模型、来源（共享 / 自带）、token 数。本轮只记录、在后台展示，不限额、不计费；订阅制在这份记录之上做。
6. **Bot、MCP、Skills、webhook 都属于用户的空间。** 每个用户在自己的飞书渠道里填自己的飞书应用；webhook 和 MCP OAuth 回调的路径带上用户 id。
7. **sandbox 每个用户一个容器**，只挂载这个用户的 `files/`。多用户之后它是租户之间的隔离边界，网络和挂载的默认值要重新审一遍。

## 后果

- 不兼容：`data/gense.sqlite` 和 `data/files/` 的单所有者布局不再读取。提供一个一次性命令 `npm run user:import-owner <email>`，把现有数据搬成第一个用户的空间（只是移动文件）。
- `.env` 的 `PROVIDER_*` 不再使用；部署后由 admin 在后台登记。
- 路线图 5 的“准入 gate 默认只有所有者”变成“默认只有这个空间的用户本人”，语义不变。
- 备份从一个库变成 `app.sqlite` 加每个用户一个库。

# 使用 Cloudflare Think 作为 Agent 运行时，Google Drive 保存用户文件

状态：已接受（2026-10-21）。部分替代 [ADR-0001](0001-cloudflare-free-tier.md)：仍托管在 Cloudflare Free 计划，但不再要求模型零支出，也不再把 Cloudflare 作为用户文件的主存储。

Agent 运行时改用 [`@cloudflare/think`](https://developers.cloudflare.com/agents/harnesses/think/)，不再组合 Pi Durable、PiHarness 和 Computer Workspace。Think 已经包含聊天协议、消息持久化、流恢复、重复提交去重、工具循环上限、恢复预算、定时任务和 React 客户端。原方案要把多个仍在变化的 beta 组件拼起来，聊天协议和 UI 映射还要我们自己写，复杂度高，收益不明显。

模型由用户自己提供。部署时从 `.env` 读取 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_MODEL`，通过 AI SDK 的 Anthropic provider 接入。模型费用由用户的模型供应商结算，不再受 Workers AI 免费额度约束。

用户文件（资料和助手产物）保存在用户自己的 Google Drive 中，通过 Google OAuth 访问。Drive 容量更大，文件可以在助手之外直接查看和编辑，而且日历、Tasks 等后续能力也会使用同一个 Google 授权。Cloudflare 只保存对话、任务状态、索引和凭据。登录使用 Cloudflare Access，身份提供方为 Google。

## Consequences

- Google OAuth 应用如果停留在 Testing 状态，refresh token 约 7 天就会过期。个人使用时，应把应用发布为 Production（未验证），并接受授权页上的“未经验证”提示。这一点需要在 V3 实测。
- Drive 是外部服务。文件读写可能因网络、配额或用户手动改动而失败，引用的原文也可能已经变化，所以引用改为保存原文摘录，不再使用行号。
- 依赖从 Pi 生态换到了 Think。Think 仍是 Experimental 阶段，接口可能变化，所以依赖必须锁定版本，验证结果按版本记录。
- 不使用 Computer Workspace 作为主存储。它是 Think 的 peer dependency，安装时仍会带上，但不承载用户文件。

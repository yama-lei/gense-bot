# ADR-0003：Free 计划下的工具加载、会话树和网页搜索

状态：已决定，2026-10-21。第 1、2 条随 [ADR-0004](0004-pi-durable-portable-core.md) 失效（2026-10-22）：按需加载改用 pi-durable 的 `deferred` 工具，会话树不再受 Think 活动路径限制，见[路线图 3](../plans/roadmap-3.md)。

## 背景

`goal.md` 要求 Codemode、工具按需加载、树状会话和类似 pi-gpt-search 的搜索。ADR-0001 约定只用 Cloudflare Free 计划。

## 决定

1. **不用 Codemode。** `@cloudflare/codemode` 和 Skill 脚本都需要 Worker Loader，而 Dynamic Workers 只在 Workers Paid 计划提供。按需加载改为自己实现：`tools_find` / `tools_load` 两个元工具加上 Think 的 `beforeStep` 逐步设置 `activeTools`。
2. **会话树沿用 Think 的消息树，不改它的活动路径。** Think 的活动路径永远是最新插入的叶子。重新生成和编辑会产生新叶子，所以能直接用；旧版本只读，要在旧版本上继续就“分支为新会话”。分支和支线都是独立的 Chat，元数据里记录父会话和分叉点。
3. **GPT 搜索走我们端点的 Responses API `web_search` 工具，不用 ChatGPT 内部接口。** pi-gpt-search 依赖个人订阅 token 和伪造的客户端标识，接口随时可能变化。
4. **生成式界面用自定义的组件树工具，不引入 OpenUI。** OpenUI 的 DSL 需要约 8k token 的系统提示，并依赖其网关纠错；用户自备的模型质量不一。

## 后果

- 升级到 Paid 计划后可以重新评估 Codemode：届时 `tools_find` / `tools_load` 可以换成 Codemode 的 `search` / `describe`。
- 旧版本不能原地继续，这和 ChatGPT 不同；如果以后 Think 提供切换活动叶子的接口，再改为原地切换。
- 分支复制消息会增加 DO 存储，个人使用量级可以忽略。

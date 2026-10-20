# Cloudflare 免费额度与依赖核查

核查记录：2026-10-20。本记录来自本次讨论中读取的官方文档、源码和 npm 发布元数据，不是账户上的部署测试。价格和产品可用性会变化，实施前必须再次核对官方页面与目标账户。

## 成本边界

| 能力 | 核查结果 | 对本项目的影响 |
| --- | --- | --- |
| Workers | Free 每天 100,000 请求，每次调用 10ms CPU；静态资源请求免费 | 不能只看请求数量，还要测量入口代码的 CPU；不能把这个限制直接套到所有 DO 调用上 |
| SQLite-backed Durable Objects | Free 可用；每天 100,000 请求、13,000 GB-s duration | 对话恢复可使用这一基础设施，但空闲计时器和活跃对象会消耗额度 |
| DO SQLite | 每天 500 万行读取、10 万行写入；总计 5GB | 对话、工具进度和文件共享账户资源，写入放大会比小文件容量更早成为瓶颈 |
| Computer Workspace | 文件系统使用 DO SQLite；可不配置执行后端 | 库没有把云资源变成无限免费；仍需验证最小依赖和实际读写消耗 |
| Dynamic Workers | 当前只支持 Workers Paid | 不使用依赖 Worker Loader 的 Computer JavaScript 或 Worker shell 后端 |
| Containers | 当前需要 Workers Paid | 不提供完整 Linux、任意进程或依赖安装 |
| Workers AI | 每天 10,000 Neurons 免费；部分模型要求付费计划或预充值 | 只能选择目标账户可免费调用、且通过工具测试的模型；免费模型效果仍未知 |
| Browser Run | Free 有每天 10 分钟、最多 3 个并发浏览器的额度 | 不能据此断言 Pi 浏览器集成免费，其动态执行依赖需要分别核查；不进入首版基线 |

Workers Paid 的起步订阅费为每月 5 美元，不能把付费计划里包含的用量称为本项目的免费方案。外部 API、MCP、搜索和 GitHub 自动评审也需要分别核查计费，不因部署在 Cloudflare 就免费。

DO 和 Workers AI 的官方文档说明，Free 计划超出相应免费额度后操作会失败。我们仍需要自己的预算和停止逻辑；平台拒绝不能代替清晰的任务状态，也不能把已经发生的外部副作用回滚。

## 已看到的实现与尚未验证的事项

- PiHarness 已有 npm 发布入口。它连接 Pi 的持久化存储、生命周期与唤醒，不负责完整聊天协议和 UI。
- Pi Durable 已发布的说明包含上下文压缩、工具重放策略、会话 fork 和子任务能力。不能把旧示例笔记中的缺失列表直接当成当前状态。
- 本轮对比时，Pi Durable `main` 包含发布版 README 尚未包含的 `onWake` 等内容。不能照抄 main 示例并假定当前 npm 版本具有相同接口。
- Computer 提供不带执行后端的 Workspace。文件系统方案是否能与选定 SDK、Pi 版本在 Free 账户组合运行，尚待验证。
- 没有验证当前目标账户的模型权限、免费部署、真实工具调用、CPU、休眠、重启恢复或 SQL 写入消耗。

本项目的技术验证清单位于 [架构草案](../design/architecture.md#实现前验证)。未通过验证不承诺可用性，也不通过付费服务绕过验证。

## 官方来源

### 价格与运行限制

- [Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects 价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Dynamic Workers 价格](https://developers.cloudflare.com/dynamic-workers/pricing/)
- [Containers 价格](https://developers.cloudflare.com/containers/platform/pricing/)
- [Workers AI 价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Browser Run 价格](https://developers.cloudflare.com/browser-run/pricing/)
- [Workers Node.js 兼容性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)

### 实现与发布信息

- [PiHarness 文档](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md)
- [PiHarness 示例](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi)
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- [Computer 包说明](https://github.com/cloudflare/computer/blob/main/packages/computer/README.md)
- [agents npm 元数据](https://registry.npmjs.org/agents/latest)
- [pi-durable npm 元数据](https://registry.npmjs.org/@earendil-works%2fpi-durable/latest)

上述 main 和 latest 链接会变化。正式验证时记录实际依赖锁定、compatibility date、账户计划、所用模型和测试结果，不能用这份调研记录代替可复现的部署证据。

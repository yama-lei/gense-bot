# 个人助手项目文档

本项目要做一个可持续扩展的个人助手。路线图 2 曾在 Think + Cloudflare 上完成，旧代码已删除（标签 `legacy-final`）；路线图 3 改用 pi-durable；路线图 4 去掉 Cloudflare，改为单所有者、单机 VPS 自部署，并逐步转向事件驱动。

## 阅读顺序

1. [产品 Intent](intents/personal-assistant.md)：用户要什么，以及已经确认的约束。
2. [产品 Spec 草案](specs/personal-assistant.md)：建议的首个闭环、行为要求和验收条件，待评审。
3. [架构 Design](design/architecture.md)：当前代码的组件、登录、数据与备份、sandbox、插件接口和验证方式。
4. [Cloudflare 托管决策](adr/0001-cloudflare-free-tier.md) 与 [Think + Google Drive 决策](adr/0002-think-google-drive.md)：早期方向，已被 ADR-0004、ADR-0005 取代，保留作为历史。
5. [免费额度与依赖核查](research/cloudflare-free-tier.md)：Workers / DO 额度依据（历史资料，Cloudflare 已不再使用）。
6. [网页界面 Spec](specs/web-ui.md)：页面、对话、插件与 Skill、渠道、设置和质量要求；2026-11-10 按路线图 5 重写，前端在 [`packages/web/`](../packages/web/)。
7. [助手功能清单](intents/agent-features.md)：goal.md 按能力拆开后的清单、状态和待商量的问题（含会话工作区）。
8. [路线图 2](plans/roadmap-2.md) 与 [ADR-0003](adr/0003-free-plan-agent-features.md)：网页搜索、文件、会话树、命令、Skills、生成式界面的分层计划和开发顺序。
9. [OpenAI 兼容中转站的已知问题](research/openai-relay.md)：注入的托管工具、`item_reference`、生图参数，以及现有的绕开方式。
10. [路线图 3](plans/roadmap-3.md) 与 [ADR-0004](adr/0004-pi-durable-portable-core.md)（2026-10-23 评审通过）：改用 pi-durable、树形会话、Event、子 agent、Docker sandbox。其中 Cloudflare 部署的部分已被 ADR-0005 取代。
11. [生成式界面改用 OpenUI](plans/openui.md)（2026-10-23）：OpenUI Lang 程序、从 open-intelligent-ui 移植的组件库、校验与纠错。安装依赖时设 `OPENUI_TELEMETRY_DISABLED=1`，否则 `@openuidev/lang-core` 的 postinstall 会发送安装统计。
12. [路线图 4](plans/roadmap-4.md) 与 [ADR-0005](adr/0005-event-driven-vps.md)（2026-10-31，草案）：改为事件驱动、单机 VPS 自部署，借鉴 [`ref/dsh-superagent-prototype`](../ref/dsh-superagent-prototype/)（git submodule，克隆后需 `git submodule update --init`）。

原始课程材料保留在 [实验 1](intents/lab1.md) 和 [实验 2](intents/lab2.md)。它们提供长期方向，不代表其中每项功能都属于第一版交付范围。

## 文档如何变化

- Intent 记录目标、使用场景和约束，不承担实现细节。
- Spec 记录外部可观察的行为和验收条件。新增 Intent 先检查并更新 Spec，再修改实现。
- Design 解释如何满足 Spec。技术方案若显著增加复杂度，可以提出小幅调整 Intent，但必须与用户讨论，不能擅自缩减目标。
- ADR 只记录有真实取舍、后续改变成本较高的决策。改变方向时用新 ADR 说明替代关系。
- 调研文档记录来源和证据，不把上游示例、免费额度或尚未部署的方案写成已经验证的能力。

这些是本轮建议的文档维护方式，不构成已经上线的自动化流程。GitHub Issues、PR 模板、评审门禁和部署流程仍需设计。

## 当前评审重点

[路线图 5](plans/roadmap-5.md)（聊天 + 飞书 Bot、插件生态、界面重写）的阶段 0–5 已在 `feat/r5-web` 上实现并合并了后端（记录见 [roadmap-5-backend-notes.md](plans/roadmap-5-backend-notes.md)）。还没做的验收：用真实的飞书应用和真实的 MCP 服务器走一遍，以及阶段 6 的逐条走查。路线图 4 中未被路线图 5 吸收的部分（GitHub / GitLab Source、内置日历）暂时搁置。

`AGENTS.md` 保留高层开发原则，不复制这里的产品需求和技术细节。开发用 Pi 插件的说明在 [`.pi/README.md`](../.pi/README.md)，它们不属于产品运行时。

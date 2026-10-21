# 个人助手项目文档

本项目要做一个可持续扩展的云端个人助手。M0 Mock 前端已部署；后端（Think + Google Drive）正在准备规格和设计，尚未实现。

## 阅读顺序

1. [产品 Intent](intents/personal-assistant.md)：用户要什么，以及已经确认的约束。
2. [产品 Spec 草案](specs/personal-assistant.md)：建议的首个闭环、行为要求和验收条件，待评审。
3. [架构 Design 草案](design/architecture.md)：技术职责、数据流、待定问题和实现前验证。
4. [Cloudflare 托管决策](adr/0001-cloudflare-free-tier.md) 与 [Think + Google Drive 决策](adr/0002-think-google-drive.md)：已确认的方向及取舍。
5. [免费额度与依赖核查](research/cloudflare-free-tier.md)：Workers / DO 额度依据（Pi 相关部分已过时）。
6. [网页界面 Spec](specs/web-ui.md)：页面、组件、移动端行为和交付阶段；M0 Mock 前端在 [`web/`](../web/)。

原始课程材料保留在 [实验 1](intents/lab1.md) 和 [实验 2](intents/lab2.md)。它们提供长期方向，不代表其中每项功能都属于第一版交付范围。

## 文档如何变化

- Intent 记录目标、使用场景和约束，不承担实现细节。
- Spec 记录外部可观察的行为和验收条件。新增 Intent 先检查并更新 Spec，再修改实现。
- Design 解释如何满足 Spec。技术方案若显著增加复杂度，可以提出小幅调整 Intent，但必须与用户讨论，不能擅自缩减目标。
- ADR 只记录有真实取舍、后续改变成本较高的决策。改变方向时用新 ADR 说明替代关系。
- 调研文档记录来源和证据，不把上游示例、免费额度或尚未部署的方案写成已经验证的能力。

这些是本轮建议的文档维护方式，不构成已经上线的自动化流程。GitHub Issues、PR 模板、评审门禁和部署流程仍需设计。

## 当前评审重点

先评审重写后的 Spec 与架构草案，再按架构草案的 V1–V6 逐项验证。验证通过之前不承诺完整方案可运行，也不通过开通 Cloudflare 付费服务绕过限制。

`AGENTS.md` 保留高层开发原则，不复制这里的产品需求和技术细节。开发用 Pi 插件的说明在 [`.pi/README.md`](../.pi/README.md)，它们不属于产品运行时。

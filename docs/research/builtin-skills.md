# 调研：可内置的 Agent Skills

状态：2026-11-11，由调研 agent 完成，Claude 整理。对应 roadmap-6 的 I2 / A3；采用的名单见 [roadmap-6](../plans/roadmap-6.md#内置-skill-候选)。

调研日期 2026-11-11。下表所列条目我都打开过 SKILL.md,并核对了 LICENSE 文件或 GitHub 的 license 元数据。

## 总体结论

1. **文档生成**:`anthropics/skills` 的 docx、pdf、pptx、xlsx 现在是 Apache-2.0。这些 skill 以前是 source-available 专有许可,所以打包前要锁定 commit 并再核对一次 LICENSE.txt。它们的规范性最好,但依赖 LibreOffice、pandoc、poppler 等系统工具,需要确认沙箱镜像里有没有。
2. **中文去 AI 味**:最合适的是 `op7418/Humanizer-zh`(MIT,22k star,纯提示词)和 `LifelongLazyLearner/qu-ai-wei`(MIT,纯提示词加 references)。`swaylq/humanize-chinese` 的许可证是 "MIT License (Non-Commercial)",不能打包。
3. **常见场景几乎没有现成的高质量开源 skill**:
   - 旅行规划、学习辅导、会议纪要只找到零星的小仓库,或星数很低的仓库。
   - 这几类建议自己写,或只借鉴它们的结构。
4. **K-Dense-AI/scientific-agent-skills**(MIT,177 个 skill)的研究与写作类 skill 质量很高,多数声明为离线、无需 API key。但偏英文和科研,需要挑选。
5. **兼容性问题**:很多 skill 的 frontmatter 带有 Claude Code 专有字段(`allowed-tools`、`argument-hint`、`disable-model-invocation`)。正文中常有 `AskUserQuestion`,需要改成"直接向用户提问"。

## 候选清单(已打开 SKILL.md)

「适配度」是对 GenseBot 的适配度。若无特别说明,"name 合规"指 name 符合小写加连字符规范。

### A. 文档生成(`github.com/anthropics/skills`)

| # | 名称与路径 | 许可证 | 用途 | 依赖 | 适配度与问题 |
|---|---|---|---|---|---|
| 1 | `docx` — `skills/docx` | LICENSE.txt 为 Apache-2.0(README 也写明 Apache 2.0) | 创建、编辑、审阅 Word 文档(tracked changes、comments) | pandoc、`docx` (npm docx-js)、LibreOffice (`soffice`)、pdftoppm;scripts 为 python | **高**。依赖 soffice 和 pandoc,沙箱需预装;SKILL.md 不提 CJK 字体,中文需要补一段字体指引。name 合规 |
| 2 | `pdf` — `skills/pdf` | Apache-2.0 | 读取、合并、拆分 PDF,表单,OCR,生成 | pypdf、pdfplumber、reportlab、qpdf、poppler、可选 pytesseract | **高**。reportlab 默认字体不支持中文,需要注册 CJK 字体并写进指引;FORMS.md 和 REFERENCE.md 要一起带上 |
| 3 | `pptx` — `skills/pptx` | Apache-2.0 | 创建、编辑 PPT | pptxgenjs、python-pptx、markitdown、LibreOffice、pdftoppm、npm(react-icons、sharp) | **中高**。依赖链最重;能做的事和 Gense 的"artifact"工具有重叠 |
| 4 | `xlsx` — `skills/xlsx` | Apache-2.0 | 读写 Excel/CSV,公式,格式 | openpyxl、pandas、LibreOffice 重算公式、markitdown | **高**。依赖最少。公式重算需要 soffice |
| 5 | `doc-coauthoring` — `skills/doc-coauthoring` | **该目录没有 LICENSE.txt**,SKILL.md 也没有 license 字段,仓库层面说明为 Apache。**许可证不明确,需要确认** | 分阶段协作写文档:收集上下文、迭代、读者测试 | 无 | **中**。纯提示词,适合写方案、规格。文中提到 MCP、Slack 等连接器(正文出现 4 次),要删改 |
| 6 | `internal-comms` — `skills/internal-comms` | Apache-2.0 | 公司内部沟通模板(3P 周报、通讯、FAQ) | 无 | **低到中**。偏企业场景,个人助理场景一般用不上 |
| 7 | `skill-creator` — `skills/skill-creator` | Apache-2.0 | 创建并评测 skill | 依赖 Claude Code 流程与评测脚本 | **低**。Gense 自己有创建流程,不建议内置 |

### B. 中文写作与去 AI 味

| # | 名称与路径 | 许可证 | 用途 | 依赖 | 适配度与问题 |
|---|---|---|---|---|---|
| 8 | `humanizer-zh` — `github.com/op7418/Humanizer-zh`,根目录 `SKILL.md` | **MIT**(LICENSE 文件存在;22.5k star,2026-09 更新) | 去除中文文章中的空话、模板句式,保留事实与作者声音 | 无,纯提示词,SKILL.md 约 20KB | **高**。内容扎实,明确"不保证过检测"。frontmatter 有 `allowed-tools: Read, Write, Edit, AskUserQuestion`,需要去掉 `AskUserQuestion` |
| 9 | `qu-ai-wei` — `github.com/LifelongLazyLearner/qu-ai-wei`,根目录 `SKILL.md` + `references/` | **MIT**(747 star,2026-09 更新) | 简体中文去 AI 味重写,按语体区分,附模式库、平台风格(brand-voice、platform-patterns、whitelists) | 无,纯提示词 | **高**。有"敏感信息门检"(遇到密码、key 先停止),对个人助理是加分项。description 中英混合;`tests/` 目录不要打包 |
| 10 | `humanizer-zh-next` — `github.com/Hyacehila/humanizer-zh-next`,根目录 | **MIT**(248 star) | 在 Humanizer-zh 基础上做结构化重写,按需加载商务营销、论文与审稿回复、基金申请三类专用 reference | 带 `scripts/check_structure.py` 校验脚本(可不带) | **中高**。功能最全,SKILL.md 约 44KB,偏大,但 reference 是按需加载的。可作为 #8 的替代,**二选一** |
| 11 | `human-tone` — `github.com/seacen/human-tone`,`skills/human-tone/SKILL.md` | MIT | 减法式去 AI 味,中英文双语 | 无 | **中**。仅 0 star,description 里写了"每次写完文本都主动运行",会让每次写作多走一遍,不建议默认开启 |
| 12 | `remove-ai-flavor` — `github.com/meikis/remove-ai-flavor-writing-skill`,根目录 | MIT(3 star) | 中文去 AI 味,小红书等平台,附 `scripts/audit_ai_flavor.py` | python 审计脚本 | **低到中**。质量没有被验证,体量小 |
| 13 | `humanizer` — `github.com/blader/humanizer`,根目录 | MIT(67.8k star) | 英文去 AI 味(v4.0.0),#8 的上游 | 无 | **中**。仅限英文;如果要做英文写作可以带 |
| 14 | `stop-slop` — `github.com/hardikpandya/stop-slop` | MIT(18.8k star) | 英文去 AI 套话,附 references | 无 | **低**。英文,和 #13 重复 |
| 15 | `humanize-chinese` — `github.com/swaylq/humanize-chinese` | **"MIT License (Non-Commercial)"**,GitHub 标为 NOASSERTION | 六段式去 AI 腔,离线 Python,含水印检查 | python | **不要打包**,许可证限制非商业用途。原作者仓库 `voidborne-d/humanize-chinese` 已 404 |
| 16 | `wechat-article-writer` — `github.com/xstongxue/best-skills`,`skills/wechat-article-writer` | 仓库根为 Apache-2.0(**目录内未单独声明**) | 公众号文章写作、封面图、插图 | 自动上传依赖微信 API(`.env.example`、node 脚本) | **中**。写作部分有价值,上传部分要删掉(需要已认证公众号和 API 密钥) |
| 17 | `md-report-summary` — `github.com/xstongxue/best-skills`,`skills/md-report-summary` | Apache-2.0(仓库层面) | 生成周报、工作汇报、总结、复盘;无草稿时联网搜索 | 无脚本,有 `reference/templates.md` | **高**。纯提示词、中文原生,适合直接带 |

### C. 翻译

| # | 名称与路径 | 许可证 | 用途 | 依赖 | 适配度与问题 |
|---|---|---|---|---|---|
| 18 | `baoyu-translate` — `github.com/JimLiu/baoyu-skills`,`skills/baoyu-translate` | MIT(LICENSE 文件存在;27k star) | 三档翻译(快翻、普通、精翻),术语表,分块,英中术语表 | **bun / `npx bun`**(`scripts/main.ts` 做 markdown 分块);精翻流程会启动 subagent | **中高**。分块脚本是 TypeScript,Gense 沙箱有 node 但未必有 bun;可以不用脚本,让模型自己分段,或改写成 python/node。要去掉 `AskUserQuestion`。frontmatter 的 `metadata.openclaw`、`version` 是额外字段,无害。**同仓库的其他 skill(wechat、x、gemini-web、url-to-markdown)依赖 Chrome 或专有二进制,不要带** |

### D. 研究与论文(`github.com/K-Dense-AI/scientific-agent-skills`,仓库 MIT,各 skill 均自声明 MIT)

| # | 名称与路径 | 许可证 | 用途 | 依赖 | 适配度与问题 |
|---|---|---|---|---|---|
| 19 | `literature-review` — `skills/literature-review` | MIT | 系统综述与叙述性综述,检索 PubMed、arXiv、Semantic Scholar | python 3.10+、requests;可选 parallel-cli;PDF 导出需 pandoc 和 XeLaTeX;AI 配图需 `OPENROUTER_API_KEY` | **中高**。核心可用,可选部分直接忽略。偏生物医学。`allowed-tools` 字段是空格分隔,符合规范 |
| 20 | `paper-lookup` — `skills/paper-lookup` | MIT | 按 DOI、标题查论文元数据 | python 3.11+ 标准库、curl、需联网;无需密钥 | **高**。依赖最轻 |
| 21 | `citation-management` — `skills/citation-management` | MIT | 在 OpenAlex、PubMed 搜索,验证引用,生成 BibTeX | python + requests;Google Scholar 需 `scholarly`;需联网 | **中**。`allowed-tools` 含 WebSearch、WebFetch,要对应到 Gense 的 web 搜索工具 |
| 22 | `scientific-writing` — `skills/scientific-writing` | MIT | 科研写作指引,附离线 CLI | python 3.11+(可选),无需密钥 | **中**。英文为主 |
| 23 | `peer-review` — `skills/peer-review` | MIT | 论文评审辅助 | python 3.11+ 标准库,本地运行 | **中到低**。小众,用户群较窄 |
| 24 | `markitdown` — `skills/markitdown` | MIT | 用微软 MarkItDown 把 Office、PDF 转为 Markdown | python 3.10 到 3.14、uv;核心转换可离线 | **高**。通用文档读取;沙箱要装 `markitdown` 包 |
| 25 | `paper-write` — `github.com/xstongxue/best-skills`,`skills/paper-write` | Apache-2.0(仓库层面) | 本科和硕士论文写作:大纲审核、仿写、润色、中英互译、**anti-aigc**、参考文献 | 无脚本,约 25 个 reference 文件 | **中高**。中文原生,目标用户明确(学生)。降 AIGC 率这类功能涉及学术诚信,需要产品层面决定是否对外展示 |
| 26 | `DeepPaperNote` — `github.com/917Dhj/DeepPaperNote`,`skills/deeppapernote` | MIT(1.3k star) | 单篇论文深度阅读笔记 | python 脚本较多;偏 Obsidian 与 Zotero 本地环境,下载 PDF | **低到中**。流程极重(十余步,多道质量门),依赖 Obsidian 与 Zotero Local API,在容器里不合适 |

### E. 数据分析

| # | 名称与路径 | 许可证 | 用途 | 依赖 | 适配度与问题 |
|---|---|---|---|---|---|
| 27 | `statistical-analysis` — K-Dense `skills/statistical-analysis` | MIT | 统计检验与分析 | python 3.12+ 科学计算环境 | **中**。偏科研;沙箱要有 scipy、statsmodels |
| 28 | `exploratory-data-analysis` — K-Dense `skills/exploratory-data-analysis` | MIT | 对 CSV/TSV/JSON 做有界的本地探索性分析 | python 3.11+,离线 | **中**。偏科研文件格式 |
| 29 | `statistical-analysis`、`explore-data`、`data-visualization` — `github.com/anthropics/knowledge-work-plugins`,`data/skills/*` | 仓库根 Apache-2.0(各 skill 目录无单独 license 字段) | 通用数据分析、画图 | python(matplotlib、seaborn、plotly) | **中**。`data-visualization` 引用 matplotlib 等且无 MCP 引用;`explore-data` 有两处 MCP/连接器提及,需要改 |
| 30 | `data-analyst` — `github.com/ailabs-393/ai-labs-claude-skills`,`packages/skills/data-analyst` | MIT(469 star,**最后更新 2025-11**) | CSV 缺失值检测、插补、仪表盘 | requirements.txt、python 脚本 | **低到中**。带 `index.js`、`package.json`(面向 npm 分发),质量一般 |

### F. 旅行、学习、会议

| # | 名称与路径 | 许可证 | 用途 | 依赖 | 适配度与问题 |
|---|---|---|---|---|---|
| 31 | `travel-planner` — `github.com/ailabs-393/ai-labs-claude-skills`,`packages/skills/travel-planner` | MIT | 行程、预算、打包清单、礼仪 | `scripts/travel_db.py` 存偏好(需要持久化目录)、`plan_generator.py` | **中**。英文,偏国际旅行;缺实时信息,需靠 web 搜索补充;偏好存储路径需适配沙箱 |
| 32 | `study-coach` — `github.com/Daniel-Sun-9527/study-coach-skill`,根目录 | MIT(**1 star**,2026-05 更新) | 学习计划、费曼法、主动回忆测验、错题复盘、Anki 导出 | `scripts/make_anki_tsv.py` 仅用标准库 | **中**。中文原生,功能对口,但仓库很新、社区验证为零;**建议审读后参考,或自己改写** |
| 33 | `take-notes` — `github.com/davertor/take-notes`,`skills/take-notes` | MIT | 把视频或文章整理成学习笔记 HTML | uv、yt-dlp、ffmpeg、联网 | **低**。`disable-model-invocation: true`,依赖 Claude Code 专有字段和 `AskUserQuestion` |
| 34 | `meeting-minutes` — `github.com/HbS66-pro/meeting-minutes`,根目录 | MIT(1 star) | 把转写稿整理成正式纪要(叙事、归纳、总结三种) | `scripts/md2docx.py` 需要 python-docx | **中**。中文原生,三种模式的思路好;社区验证为零,**建议审读后参考** |
| 35 | `office-file-process` — `github.com/xstongxue/best-skills` | frontmatter 写 **"Proprietary. LICENSE.txt has complete terms"** | Office 文档处理 | | **不要打包**。这是旧版 Anthropic 专有 skill 的拷贝,和同仓库 Apache-2.0 的声明矛盾,**许可证有冲突** |

## 未纳入或不推荐

- **ComposioHQ/awesome-claude-skills**:仓库无 license,约 864 个 skill 中大半是 SaaS 自动化(composio 连接器),需要付费或账号,不适用。
- **obra/superpowers**:MIT,但全部是软件开发流程,和个人助理场景无关。
- **openai/skills**:仓库无 license 元数据,内容偏开发与厂商集成。
- **JimLiu/baoyu-skills 的其余 skill**:`url-to-markdown` 需要 Chrome CDP 加 bun;`wechat-summary` 需要本地 `wx-cli` 二进制;`image-gen`、`post-to-*` 依赖外部服务或账号。
- **找不到的东西**:我没找到质量够高的"中文旅行规划"和"中文摘要/阅读"专用 skill。

## 推荐内置 shortlist(8 个)

| 优先级 | Skill | 来源 | 理由 |
|---|---|---|---|
| 1 | `humanizer-zh`(#8) | op7418,MIT | 中文用户刚需,纯提示词、零依赖、社区验证强。需去掉 `AskUserQuestion` 和 `allowed-tools` |
| 2 | `xlsx`(#4) | anthropics,Apache-2.0 | 数据与表格是个人助理高频需求,依赖最轻(openpyxl、pandas) |
| 3 | `docx`(#1) | anthropics,Apache-2.0 | Word 生成是高频需求;需沙箱有 pandoc 和 soffice,并补 CJK 字体说明 |
| 4 | `pdf`(#2) | anthropics,Apache-2.0 | 读取和处理 PDF 是高频需求;需补 reportlab 的中文字体注册 |
| 5 | `baoyu-translate`(#18) | JimLiu,MIT | 翻译质量流程成熟(分档、术语表)。建议去掉 bun 分块脚本,改成让模型自行分段或用 python 重写 |
| 6 | `md-report-summary`(#17) | xstongxue,Apache-2.0(仓库层面) | 周报、总结、复盘的中文原生纯提示词。发布前请向作者确认目录级许可 |
| 7 | `markitdown`(#24) | K-Dense,MIT | 通用文档转文本,是其他 skill 的底座。需确认沙箱能 `pip install markitdown` |
| 8 | `paper-lookup` + `literature-review`(#20、#19) | K-Dense,MIT | 研究类场景的最小组合,依赖仅 python 标准库加 requests,不强依赖密钥 |

**可选加分项**

- `pptx`(#3):需求高,但依赖链最重(pptxgenjs、LibreOffice、markitdown)。若沙箱已预装 soffice,可以带上;否则先让 Gense 自己的 artifact 工具承担演示文稿。
- `paper-write`(#25):面向学生用户,但"降 AIGC 率"功能需要产品层面决策。

**不要内置**:`swaylq/humanize-chinese`(非商业许可)、`office-file-process`(专有声明)、`doc-coauthoring`(目录级许可不明确,需要确认后才能用)、DeepPaperNote、take-notes。

**自己写更合适的方向**:旅行规划、学习辅导、会议纪要。现有开源品质参差,最好的 `study-coach` 和 `meeting-minutes` 都只有 1 star,可参考结构自己写中文版。

## 打包时的通用整改清单

1. **锁定 commit**:`anthropics/skills` 的许可证已经变过一次,打包时记录 commit SHA 并附 LICENSE 原文和 NOTICE。
2. **frontmatter**:去掉 `allowed-tools`、`argument-hint`、`disable-model-invocation`、`user-invocable` 等 Claude Code 字段,以及 `metadata.openclaw`。
3. **正文**:把 `AskUserQuestion`、`WebSearch`、`WebFetch`、`~/.claude/skills/...` 路径等替换成 Gense 的对应工具和路径。
4. **沙箱镜像**:确认预装 LibreOffice、pandoc、poppler、qpdf、tesseract、一套 CJK 字体(Noto Sans/Serif CJK),以及 python 的 openpyxl、pandas、pypdf、pdfplumber、reportlab、markitdown、python-docx;node 的 docx、pptxgenjs。
5. **description**:用中文关键词补充触发词,例如"去 AI 味""润色""翻译""周报",否则中文用户的触发率会低。

## 局限

- GitHub API 在调研中途触发过限流,之后我改用 `gh api` 继续核对。
- star 数和更新时间取自 GitHub 元数据,以调研当日为准。
- 我没有实际在沙箱里运行这些 skill 的脚本,"依赖"一栏来自 SKILL.md 与脚本 import 的阅读结果。
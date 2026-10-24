# 生成式界面改用 OpenUI（2026-10-23）

用户反馈（`known-bugs-or-gap.md` 第 1 条）：现有的 `ui` 插件和 [open-intelligent-ui](https://github.com/thesysdev/open-intelligent-ui)（下称 oiu）差距很大。用户选择直接采用 OpenUI。这推翻了 roadmap-2 “L3 生成式界面”里“不引入 OpenUI”的决定。

当初不引入的两个理由，现在的处理：

- **系统提示约 8k token。** 实际约 3.6 万字符（9–10k token）。接受这个成本。这段提示只在“界面”插件开启时加入；提供方的提示缓存能吸收大部分费用。
- **依赖网关纠错。** 我们自己纠错：服务器用 lang-core 的解析器校验程序，有错就作为工具错误返回给模型，让它改正后重试。

## Intent

助手能像 oiu 那样，用模型自己排版的组件回答：

- 图片、卡片、表格、图表、地图、SVG 示意图；
- 页面上能直接用的小工具：计算器、清单、步骤查看器、小游戏，状态保存在页面里，不必再发一条消息；
- 在需要助手处理时，把表单发回给助手。

## Spec

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| R20 | 生成式界面 | “用表格和图表对比三款手机” → 回答里出现模型排版的卡片、表格、图表和照片；浅色、深色和 420px 宽都可读 |
| R21 | 发回助手 | 界面里提交表单或点 `@ToAssistant` 按钮 → 发出一条用户消息，带上表单的值 |
| R70 | 页面内交互 | 步进器、勾选、滑块等由 `$变量` 和 `@函数` 当场计算，不发消息；刷新页面后状态还在 |
| R71 | 校验与纠错 | 程序有错（未知组件、缺参数等）→ 工具返回带提示的错误，模型改正后重试；用户只看到改好的界面 |
| R72 | 流式显示 | 模型还在写程序时，界面就逐步出现 |
| R73 | 安全 | 链接只打开 http(s)，并且在新标签页里打开，不带 opener；样式值不能加载外部资源；`HtmlView` 跑在没有同源权限的沙箱 iframe 里 |

R20 和 R21 替换 roadmap-2 里的同名条目。

## Design

### 格式：仍是 `ui_render` 工具，参数改为 OpenUI Lang 程序

`ui_render({ program })`。`program` 是 OpenUI Lang 1.0 源码，根组件是 `Col`。

不采用 OpenUI 的 inline mode（把代码写在回答的 ```` ```openui-lang ```` 代码块里），原因：

- 工具调用能在服务器上校验，并把错误反馈给模型（R71）；
- 能沿用插件开关、`viewState` 持久化和侧边面板。

代价有两个：

- 程序要在 JSON 里转义；
- 多一轮模型调用（拿到工具结果后，模型再写结论）。

### 提示词

- 用 `generateSystemPrompt({ library: library.toSpec(), promptOptions })` 生成。必须传 `toSpec()` 的结果：直接传组件库对象时，每个组件的签名都变成 `undefined`，模型只能靠报错猜参数。生成脚本遇到 `undefined —` 会报错退出。改写了 preamble，说明 `program` 参数写的是 openui-lang，而不是整个回答都写成 openui-lang。
- 规则和示例沿用 oiu，增加两条：
  - 界面已经展示的内容不在文字里重复；
  - 简单问答不用界面。
- “使用倾向”设置保留。
- 提示词和解析器要用的 JSON Schema 由网页端的组件库生成：`npm run genui -w @gense/web`。生成结果提交在 `packages/core/src/plugins/genui/`。core 不依赖 React。
- `npm run typecheck` 会跑 `genui:check`：重新生成并比较，防止组件库和提示词不同步。
- preamble 还要求：`ui_render` 报错时改正后重新调用，不在文字里说明改了什么；用户只看到成功的界面。

### 校验

工具执行时，用 `createParser(schema, 'Col').parse(program)` 解析：

- 有 `meta.errors`（不含警告）或引用了没定义的名字：把每条拼起来抛出，成为工具错误，并附上出错组件的签名。网页只渲染成功的调用。
- 没有根节点：同样报错。
- 没有错：结果文字告诉模型“已显示，不要重复其中的数据”；没从 `root` 引用到的语句会列出来。

### 渲染（网页）

- 组件库移植自 oiu（MIT，保留版权声明）：
  - `packages/web/src/plugins/ui/genui/`：组件、`@函数`、动作；
  - 主题 token 映射到我们的 CSS 变量，深色模式跟随应用。
- `Renderer` 的接线：
  - `isStreaming` 来自调用状态；
  - `initialState` 和 `onStateUpdate` 对接 `viewState`（防抖保存）。
- 动作：
  - `@ToAssistant`：调用 `host.sendMessage`。消息后附上表单的值。
  - `@OpenUrl`：只打开 http(s)，并且在新标签页里打开，不带 opener。
  - `@CopyToClipboard`：复制到剪贴板。
- 流式（R72）：
  - `turns.ts` 把 `pi.live` 部分消息里的 toolCall（pi-ai 边流边解析出 `arguments`）当作运行中的调用；
  - `ui://ui/render` 加入 `liveViews`。
- 按需加载：
  - 地图（maplibre-gl，瓦片来自 OpenFreeMap）、数学公式（KaTeX）和图标（lucide 动态图标，约 1,900 个小文件，用到哪个下载哪个）都懒加载；
  - 渲染器本身也懒加载，不开界面插件的会话不下载它。
  - 构建后：渲染器 152 KB（gzip），地图 289 KB，KaTeX 78 KB；Cloudflare Worker 从 1.34 MiB 增到 1.46 MiB（gzip）。
- 服务器查询（`packages/core/src/plugins/genui/lookup.ts`，移植自 oiu 的 API 路由）：
  - 照片（`SearchImage`）：`host.callTool('ui_photos', { query })`，查 Wikipedia 和 Wikimedia Commons；中文查询查 zh.wikipedia。
  - 街道路线（`Map`）：`host.callTool('ui_route', { coords })`，查 OSRM 公共服务器，是道路概览，不是导航。
  - 两者和 `artifact_save` 一样走 `tool.call`，不写进对话，两种部署都能用；结果缓存在内存里。
  - 网页的工具表里登记为 `ui` 插件的工具，否则视图没有权限调用。
- 不移植 `Query`/`Mutation`：我们没有给界面用的数据工具。

### 依赖

| 包 | 用途 | 位置 |
| --- | --- | --- |
| `@openuidev/react-lang` | 渲染器 | web |
| `@openuidev/lang-core` | 解析和生成提示词 | core |
| `zod` | 组件属性 | core（lang-core 需要）、web |
| `lucide-react` | 图标 | web |
| `katex` | 数学公式 | web |
| `maplibre-gl` | 地图 | web |

- 每个包都钉成确切版本。组件代码的版权声明在 `packages/web/src/plugins/ui/genui/LICENSE`（MIT，Thesys）。
- OpenUI 1.0.0 发布于 2026-10-12，到 10-26 才满两周。在那之前只在分支上开发，不合并、不部署，除非用户同意提前。
- lang-core 的 `postinstall` 会发送安装统计（PostHog）。安装时设 `OPENUI_TELEMETRY_DISABLED=1`，写在 `docs/README.md` 里。
- 运行时统计默认关闭（要设 `OPENUI_RUNTIME_TELEMETRY_ENABLED` 才开启），浏览器里也不发送。

### 不兼容的改动

- `ui_render` 的参数从组件树 JSON 改为 `program`。旧会话里的旧界面显示为“旧版界面，已不支持显示”。
- 删除 `packages/core/src/plugins/ui-schema.ts`、导出路径 `@gense/core/ui`，以及旧的 `views.tsx` 和 `schema.ts`。

## 走查（2026-10-23，gpt-6-luna，自部署）

| 编号 | 结果 |
| --- | --- |
| R20 | “用表格和图表对比 iPhone 16、Pixel 9 和 Galaxy S24，配上照片”：2 次工具调用、24 秒，出现照片、分段切换、表格和分组柱状图；浅色、深色、420px 都可读。照片匹配度一般（iPhone 一张是 A15 芯片） |
| R21 | 自行车预算和用途表单：改选预算后提交，发出“请根据我选择的预算和主要用途推荐一辆自行车”，后面附 `- budget: 600-1000`、`- use: 通勤`，助手据此推荐 |
| R70 | 点分段切换后刷新页面，选中项还在 |
| R71 | 第一次走查时提示词里没有签名（见上文 `toSpec()`），模型改了约 6 次才成功，还在文字里逐条说明；修好后一次或两次就成功，不再说明 |
| R72 | 模型还在写程序时，界面已经出现 |

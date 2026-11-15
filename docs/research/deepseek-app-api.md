# DeepSeek App API 调研（路线图 7 / C0）

调研日期：2026-11-14。范围对应[路线图 C0 与 Design C](../plans/roadmap-7.md)，仅记录接口、依赖能力与实施建议，不实现功能、不调整已同意的范围。

## 结论与证据边界

**推荐 DeepSeek App 模型走 Messages：`https://api.deepseek.com/anthropic/v1/messages`，在应用内新增 `deepseekMessagesApi()` 包装 `anthropicMessagesApi()`。** 官方的块结构与演示客户端均以这条协议为主，能够直接表达搜索步骤、页面信息、逐块引用、拒答和标题。Responses 也具备全部 App 能力，作为备选可行，但当前 pi-ai 的 Responses 归一化同样会丢失搜索结果与引用，并不能省掉包装层。Chat Completions 的扩展字段更多，不作为本轮首选。[官方概览](https://api-docs.deepseek.com/guides/build_a_chatbot/)、[官方演示客户端](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/api/client.ts)

关键结论：

- pi-ai **可以**通过 `onPayload` 添加 `safety_check`、`title` 和原生工具声明；**可以观察**归一化前的普通供应商 SSE 事件；**不会自动保存或产出**服务端工具、引用、标题、工具用量。只加请求参数不能通过 C2–C5、C8。
- `web.ts` 的 `/v1/tools/search`、`/v1/tools/fetch` 就是本次公告的独立接口，无需替换地址。DeepSeek 原生联网与这个插件属于两种编排方式。
- `web_search_requests` / `web_fetch_requests` 是展示计数；费用按 `tool_search` / `tool_fetch` / `tool_image_search`。两组都要保留。
- Files API 返回的解析内容**无法下载**；跨模型通用的附件文本转换应使用现有本地解析器及独立 OCR。DeepSeek 自身的文档问答可以引用 Files API 的 `file_id`。
- 演示仓库已经公开 DeepSeek 历史 ZIP **v3** 的格式和校验器。“格式没公开”的依据已过时；是否实施导入仍按 Q5 暂不做。

证据分类：

| 标记 | 本次实际做过的工作 | 能证明什么 |
| --- | --- | --- |
| 文档 | 读取 2026-11-13 [公告](https://api-docs.deepseek.com/news/news261113/)、指南及其 API Reference；下文给出具体链接 | 官方当前声明的契约、限制与价格 |
| 源码 | 阅读本地 `@earendil-works/pi-ai@1.4.0` 的 `dist` 实现与 `.d.ts`，以及本项目接入点 | 当前安装版本怎样构造请求、消费 SSE、保存消息 |
| 演示源码 | 阅读 `deepseek-ai/chat-demo`，固定提交 `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c` | 官方示例的实际接口调用、历史文件格式和实现取舍 |
| 真实 API 实测 | **未做；当前进程未设置 `DEEPSEEK_API_KEY`**，未从其他配置取密钥，未发起收费请求 | 本文没有已验证的线上返回、延迟、质量或账单数据 |

下文 JSON 为按契约整理的自拟示例，均不是本次真实 API 返回。源码结论也没有冒充线上验证。

## 1. 三种对话协议

### 1.1 地址、鉴权与请求字段

App 指南指定 `deepseek-flash`，当前实际版本为 V4.1-Flash-1017。不要因为普通模型目录同时列出 `deepseek-v4-pro`，就假定 Pro 也支持这一套 App 扩展。[公告](https://api-docs.deepseek.com/news/news261113/)、[模型目录](https://api-docs.deepseek.com/quick_start/pricing/)

| 项目 | Messages | Responses | Chat Completions |
| --- | --- | --- | --- |
| POST 地址 | `/anthropic/v1/messages` | `/responses` | `/chat/completions` |
| SDK `baseURL` | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com` | `https://api.deepseek.com` |
| 鉴权 | `x-api-key: KEY`，也支持 Bearer；两者都有时 Bearer 优先 | `Authorization: Bearer KEY` | 同 Responses |
| 输入 | `messages`，系统指令放顶层 `system` | `input`，系统指令可放 `instructions` | `messages` |
| 思考开关 | `thinking.type: enabled / disabled` | `reasoning.effort: none / low / high / max` | `thinking.type: enabled / disabled` |
| 思考强度 | `output_config.effort: low / high / max` | 同上；`none` 关闭 | `reasoning_effort: low / high / max`，也接受 `none` |
| 原生搜索 | `{"type":"deepseek_web_search","name":"deepseek_web_search"}` | `{"type":"deepseek_web_search"}` | 同 Responses |
| 原生读链接 | `{"type":"deepseek_read_url","name":"deepseek_read_url"}` | `{"type":"deepseek_read_url"}` | 同 Responses |
| 安全检查 | 三者均为顶层 `"safety_check":{"level":"high"}`；`low` 等同默认检查，其他值为 400 | 同 Messages | 同 Messages |
| 自动标题 | 三者均为顶层 `"title":{"enabled":true}` | 同 Messages | 同 Messages |
| 输出上限 | `max_tokens` | `max_output_tokens` | `max_tokens` |
| 流式 | `stream:true`，SSE | 同 Messages | 同 Messages；可用 `stream_options.include_usage:true` 取末尾用量 |

来源：[Messages Reference](https://api-docs.deepseek.com/api/create-message)、[Responses 指南](https://api-docs.deepseek.com/guides/responses_api/)、[Chat Completions Reference](https://api-docs.deepseek.com/api/create-chat-completion)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[安全检查](https://api-docs.deepseek.com/guides/safety/)。各地址均以上表域名为前缀。

Messages 的完整最小组合示例：

```json
{
  "model": "deepseek-flash",
  "max_tokens": 2048,
  "messages": [{"role": "user", "content": "查一下杭州今天的天气。"}],
  "thinking": {"type": "enabled"},
  "output_config": {"effort": "high"},
  "tools": [
    {"type": "deepseek_web_search", "name": "deepseek_web_search"},
    {"type": "deepseek_read_url", "name": "deepseek_read_url"}
  ],
  "safety_check": {"level": "high"},
  "title": {"enabled": true},
  "stream": true
}
```

Responses：

```json
{
  "model": "deepseek-flash",
  "max_output_tokens": 2048,
  "input": "查一下杭州今天的天气。",
  "reasoning": {"effort": "high"},
  "tools": [{"type": "deepseek_web_search"}, {"type": "deepseek_read_url"}],
  "safety_check": {"level": "high"},
  "title": {"enabled": true},
  "stream": true
}
```

Chat Completions：

```json
{
  "model": "deepseek-flash",
  "max_tokens": 2048,
  "messages": [{"role": "user", "content": "查一下杭州今天的天气。"}],
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high",
  "tools": [{"type": "deepseek_web_search"}, {"type": "deepseek_read_url"}],
  "safety_check": {"level": "high"},
  "title": {"enabled": true},
  "stream_options": {"include_usage": true},
  "stream": true
}
```

思考默认开启、默认强度 `high`；开关应显式发送。Messages 的 `thinking.type`、Chat 的 `thinking.type` 优先决定是否思考；`adaptive` 在 Messages 中按 enabled 处理。兼容强度映射：minimal→low，medium/xhigh→high，ultra→max。Messages 的 `budget_tokens` 不能控制实际思考预算。HTTP Messages 可不传 `max_tokens`，Anthropic SDK 则要求传。[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[Messages 请求模式](https://api-docs.deepseek.com/api/create-message)

另有可选的 `latest_reminder` 消息，content为 `日期,星期,位置,App或Web,语言名`，必须紧贴所属user消息之前；Messages和Chat接受，Responses不接受。可用于搜索的日期/位置语境，但不强制触发搜索。pi-ai统一Message没有这个role，如需使用也要在onPayload插入；不应把它当任意metadata透传。[用户元信息标记](https://api-docs.deepseek.com/guides/latest_reminder/)

### 1.2 联网行为与请求限制

以下是 **App Web Tools** 的契约，不要套用普通 Anthropic `web_search` 的默认行为：

| 条件 | 行为 |
| --- | --- |
| 搜索工具 + 关闭思考 | 普通网页搜索；有图片时也可图搜 |
| 搜索工具 + 开启思考 | 边想边搜，支持 `search`、`open_page`、`find_in_page`；约最多 20 次工具调用 |
| 仅读链接，或关闭思考时声明读链接 | 只检查末条用户消息，去重后考虑前 10 个 URL，由模型决定读哪些 |
| 思考开启且同时声明两个原生工具 | 进入深度思考搜索，不再单独执行“读用户链接”的路径；不能承诺每个用户链接都被读取 |
| `tool_choice:none` | 连原生读链接也关闭；不能用于只关闭客户端工具 |
| 强制指定某个原生工具 | 400；是否搜索、读链接由模型选择 |
| 原生工具配置域名 / 用户位置 | `allowed_domains`、`blocked_domains`、`user_location` 不支持；位置应看 `latest_reminder` |

来源：[Web Tools](https://api-docs.deepseek.com/guides/web_tools/)。原生工具不需要客户端执行，也不需要客户端提交 `tool_result`；本地函数工具仍可按各协议的普通工具契约使用。[Messages 工具定义](https://api-docs.deepseek.com/api/create-message)

启用任一原生工具、high 安全检查或标题时，下列参数由服务端决定：

| 协议 | 被忽略的参数 |
| --- | --- |
| Messages | `temperature`、`top_p`、`top_k`、`stop_sequences`、`thinking.budget_tokens`、`preserve_thinking`、`tool_choice.disable_parallel_tool_use`、`metadata` 中除 `user_id` 外的内容 |
| Responses | `temperature`、`top_p`、`reasoning.summary`、`text.verbosity`、`include`、`max_tool_calls`、`truncation`、`metadata`、`parallel_tool_calls`、`store` |
| Chat | `temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、`stop`、`seed`、`n`、`preserve_thinking`、`parallel_tool_calls` |

`max_tokens` / `max_output_tokens` 限制的是本轮**每个推理步骤**的输出，不能当作整轮费用封顶。[忽略参数清单](https://api-docs.deepseek.com/guides/build_a_chatbot/#ignored-parameters)

Responses 扩展模式不支持 `previous_response_id`、`conversation`、`item_reference`；须自行回传历史；`web_search` 不能与 DeepSeek 两个原生工具混用，`custom`、`namespace`、`tool_search` 工具为 400。`text.format` 非 text、`top_logprobs` 也为 400。Chat 扩展模式不支持 `web_search_options`、非 text 的 `response_format`、`logprobs` / `top_logprobs`。Messages 的其他服务端工具不能与这套 App 扩展组合。[Responses 扩展限制](https://api-docs.deepseek.com/guides/web_tools/#responses-api)、[Chat 扩展限制](https://api-docs.deepseek.com/guides/web_tools/#chat-completions-api)

### 1.3 Messages 返回块与 SSE

返回为 `type:message`、`role:assistant`，`content` 按发生顺序排列，包含以下块。`kind` 是 `search | deep_search | read_link | image_search | deep_image_search`，不能通过 `name` 推断普通搜索还是深度搜索。

```json
[
  {"type":"thinking","thinking":"先查证来源。","signature":"opaque-thinking-signature"},
  {
    "type":"server_tool_use","id":"srvtoolu-example","name":"deepseek_web_search",
    "input":{"action":"search","queries":["杭州 天气"]},
    "caller":{"type":"direct"},"kind":"deep_search"
  },
  {
    "type":"web_search_tool_result","tool_use_id":"srvtoolu-example","kind":"deep_search",
    "content":[{
      "type":"web_search_result","url":"https://example.com/weather","title":"天气记录",
      "encrypted_content":"opaque-search-content","page_age":null,
      "snippet":"天气摘要","site_name":"示例站点","site_icon":null
    }]
  },
  {
    "type":"text","text":"天气信息如下。",
    "citations":[{
      "type":"web_search_result_location","url":"https://example.com/weather",
      "title":"天气记录","encrypted_index":"","cited_text":"天气信息如下。"
    }]
  }
]
```

四种动作的 `input`：`{action:"search",queries:string[]}`、`{action:"open_page",url}`、`{action:"find_in_page",url,pattern}`、`{action:"read_link",url}`。前三种的 name 为 `deepseek_web_search`，最后一种为 `deepseek_read_url`。搜索结果可为空数组；失败为 `content:[{type:"web_search_tool_result_error",error_code:"unavailable"}]`。图搜的 queries 为空数组，结果可能额外有 `image_url`。[服务端调用与搜索结果模式](https://api-docs.deepseek.com/api/create-message)

打开页面或读链接返回：

```json
{
  "type":"web_fetch_tool_result","tool_use_id":"srvtoolu-read-example","kind":"read_link",
  "content":{
    "type":"web_fetch_result","url":"https://example.com/article",
    "content":{"type":"document","source":{"type":"text","media_type":"text/plain","data":""},"title":"页面标题"},
    "published_at":null
  },
  "signature":"opaque-encrypted-page"
}
```

这里 `data` 恒为空串。成功的 `read_link` 通过 `signature` 携带加密页面；深搜的打开页面 / 查找结果没有这个签名。失败时 `content` 换成 `{type:"web_fetch_tool_result_error",error_code:"url_not_accessible"|"url_not_allowed"|"unavailable"}`，且没有 signature。搜索的 `page_age` 为 RFC 3339 或 null；read_link 的 `published_at` 格式不固定，深搜的为 RFC 3339，两者均可为 null。[页面结果模式](https://api-docs.deepseek.com/api/create-message)

引用属于当前 text 块；出现引用之后的正文另开 text 块。同一块按 URL 去重。`cited_text` 是本块截至该引用的**回答文本**，不是网页原文；`encrypted_index` 恒为空，标题可为 null。即使来源是深搜打开的页面，引用类型仍为 `web_search_result_location`。[引用模式](https://api-docs.deepseek.com/api/create-message)

| SSE 事件 | 客户端处理 |
| --- | --- |
| `message_start` | 保存 response id、初始 usage；这不是整轮最终用量 |
| `content_block_start` | 用 `index` 建块；服务端调用及结果**完整地在此事件到达** |
| `content_block_delta` | 按 index 累积 `text_delta` / `thinking_delta` / `signature_delta`；客户端函数的输入为 `input_json_delta`；引用为 `citations_delta.citation` |
| `content_block_stop` | 结束对应块；不要要求工具结果紧跟调用，用 `tool_use_id` 配对 |
| `message_delta` | 最终 `delta.stop_reason`、可选 `delta.stop_details` / `delta.title`、累计 `usage` |
| `message_stop` | 正常流结束；**没有 `[DONE]`** |
| `error` / 保活 | 错误可在 HTTP 200 后到达；解析 `error` 及可能的 usage；跳过 SSE 注释 / ping |

来源：[Messages SSE Reference](https://api-docs.deepseek.com/api/create-message)、[App 流事件顺序](https://api-docs.deepseek.com/guides/web_tools/#streaming)。

### 1.4 Responses 和 Chat 的对应结构

| 语义 | Responses | Chat Completions |
| --- | --- | --- |
| 服务端调用及结果 | `output[]` 中一个 `web_search_call` item；含 `id/status/kind/action` | `message.server_tool_calls[]`，每项为一步 `{index,reasoning_content,calls:[]}` |
| 搜索动作 / 结果 | `action:{type:"search",queries,sources}` | `calls[].action:{type:"search",queries}`，结果在同层 `sources` |
| 深搜开页 / 查找 | `action.type:open_page / find_in_page`，可有 pattern；结果在 `page` | `calls[].action.type:open_page / find_in_page`；结果在 `page` |
| 用户链接 | `kind:read_link`、`action.type:open_page`，成功时有 `page` / `signature` | `type:deepseek_read_url`、`kind:read_link`、`action.type:read_link`，成功时有 `page` / `signature` |
| 失败 | item 的 `status:failed,error:{code}` | call 的 `status:failed,error:{code}` |
| 思考 | reasoning item，content 为 reasoning_text，summary 为空，无 encrypted_content | 各步 reasoning_content；顶层 message.reasoning_content 仅最后一步 |
| 正文引用 | message item 的 `output_text.annotations[]`；扁平 `{type:"url_citation",url,title,start_index,end_index}` | `message.annotations[]`；`{type:"url_citation",url_citation:{url,title,start_index,end_index}}` |
| 标题 | 非流顶层 title；流式最终 `response.title` | 非流 message.title；最后一个 chunk 的 delta.title |
| 用量 | 终态事件 response.usage | usage，按 include_usage 设置消费末尾 usage chunk |

两条协议的引用下标都是 **Unicode code point**，不是 JS 的 UTF-16 下标；emoji 前后定位不能直接 `string.slice(start,end)`。Responses 标题未知的引用使用空串，Chat 使用 URL 兜底。sources 的字段为 `type:"url",url,title,snippet,site_name,site_icon,published_at`，page 为 `url,title,published_at`；展示信息按 URL 与引用关联。[Responses App 输出](https://api-docs.deepseek.com/guides/web_tools/#responses-api)、[Chat App 输出](https://api-docs.deepseek.com/guides/web_tools/#chat-completions-api)

同一次成功读链接的Responses响应节选，保留原生item及引用的嵌套位置：

```json
{
  "status":"completed",
  "output":[
    {
      "type":"web_search_call","id":"srvtoolu-read-example","status":"completed","kind":"read_link",
      "action":{"type":"open_page","url":"https://example.com/article"},
      "page":{"url":"https://example.com/article","title":"页面标题","published_at":null},
      "signature":"opaque-encrypted-page"
    },
    {
      "type":"message","role":"assistant",
      "content":[{"type":"output_text","text":"页面已读。","annotations":[
        {"type":"url_citation","url":"https://example.com/article","title":"页面标题","start_index":0,"end_index":5}
      ]}]
    }
  ],
  "title":"页面要点"
}
```

Chat对应的choice节选；服务端调用位于server_tool_calls，而不是普通function的tool_calls：

```json
{
  "index":0,
  "message":{
    "role":"assistant","content":"页面已读。","title":"页面要点",
    "annotations":[{"type":"url_citation","url_citation":{
      "url":"https://example.com/article","title":"页面标题","start_index":0,"end_index":5
    }}],
    "server_tool_calls":[{"index":0,"calls":[{
      "index":0,"id":"srvtoolu-read-example","type":"deepseek_read_url","kind":"read_link",
      "action":{"type":"read_link","url":"https://example.com/article"},"status":"completed",
      "page":{"url":"https://example.com/article","title":"页面标题","published_at":null},
      "signature":"opaque-encrypted-page"
    }]}]
  },
  "finish_reason":"stop"
}
```

两个示例是字段位置示意，完整响应还包含各协议的id/model/usage等元信息；非思考Chat示例没有reasoning_content。[两协议结果契约](https://api-docs.deepseek.com/guides/web_tools/#responses-api)

Responses 的原生工具 SSE 依次为 `response.output_item.added` → `response.web_search_call.in_progress` → `.searching` → `.completed` → `response.output_item.done`；added 带完整 action，done 才补齐结果 / signature / error，多调用靠 output_index 配对。引用单独由 `response.output_text.annotation.added` 到达。终态为 `response.completed` / `response.incomplete` / `response.failed`，取其 response 对象。[Responses 流协议](https://api-docs.deepseek.com/guides/web_tools/#responses-api)

Chat 用 `delta.content`、`delta.reasoning_content` 流文本；每个 choice 还可能在 **delta 的同层**有 `server_tool_event`：`step_reasoning_done`、`call_started`、`call_completed`，包含 step / call。进度完成事件不带 signature；完整 `server_tool_calls`、`annotations` 在带 finish_reason 的最后一个内容 chunk 的 delta 中一次给出，不能只保留增量事件。[Chat 流协议](https://api-docs.deepseek.com/api/create-chat-completion)

### 1.5 拒答、标题、多轮与中断

| 结果 | Messages | Responses | Chat |
| --- | --- | --- | --- |
| 完成 | stop_reason:end_turn | status:completed | finish_reason:stop |
| 截断 | max_tokens | incomplete + max_output_tokens | length |
| 安全拒答 | refusal；stop_details:{type:"refusal",category:null,explanation:null} | incomplete + content_filter | content_filter |

拒答可能在正文已经流出后才确定。客户端必须清除已显示的正文和思考，改为自己的拒答提示。非流拒答也保留已执行的工具：Messages 另带空 text，Responses 只留 web_search_call，Chat 保留 server_tool_calls 但清空思考且不返回 annotations。图片被拦截时可能另给图片位置说明。输入可能直接返回 `400 Content Exists Risk`。拒答前消耗仍计费。[安全检查及拒答契约](https://api-docs.deepseek.com/guides/safety/)

标题由同次回答生成，不收标题费用，但结束前最多额外等 5 秒。只在没有标题的首轮启用；失败 / 拒答可能无标题，使用用户首句话等本地兜底，不能覆盖用户重命名。[标题指南](https://api-docs.deepseek.com/guides/conversation_title/)

所有协议均需自己保存并回传历史原生结果，尤其 `kind`、读链接的 `signature`。只保留最终文字会使先前已读网页悄悄退出上下文。历史搜索结果 / 深搜页面 / 前轮思考不进入后轮上下文，读链接页面由 signature 恢复到该轮用户消息末尾。应保留原始块，避免依赖从 UI 卡片重建请求。[多轮契约](https://api-docs.deepseek.com/guides/web_tools/#multi-turn)

用了原生联网的回答不支持 assistant 前缀续写，重发原请求才能重试；Responses 本来就不支持末尾 assistant / reasoning 续写。未联网的 Chat 续写须 `/beta/chat/completions` 与 `prefix:true`。[续写限制](https://api-docs.deepseek.com/guides/web_tools/#continue-generation)

### 1.6 用量字段与计费语义

Messages 的末尾 usage 可包含：

```json
{
  "input_tokens": 150,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 100,
  "output_tokens": 80,
  "output_tokens_details": {"thinking_tokens": 30, "safety_tokens": 5},
  "service_tier": "standard",
  "server_tool_use": {
    "web_search_requests": 1, "web_fetch_requests": 1,
    "tool_search": 2, "tool_fetch": 1, "tool_image_search": 0
  }
}
```

| 字段 | 含义与记账要求 |
| --- | --- |
| Messages input_tokens | 未命中缓存的输入；总输入还要加 cache_read_input_tokens；cache_creation_input_tokens 恒为 0 |
| Responses input_tokens / Chat prompt_tokens | 含缓存命中的输入；缓存分别在 input_tokens_details.cached_tokens / prompt_cache_hit_tokens；映射统一 Usage 时避免再加一遍 |
| output_tokens / completion_tokens | 已含思考和安全审查 token；细分值不能再次计费 |
| web_search_requests / web_fetch_requests | 返回的相应结果块数，包含错误；用于展示 |
| tool_search / tool_fetch / tool_image_search | 真正计费的查询 / 抓取 / 图搜数量；Responses、Chat 的 server_tool_use 主要返回这三项 |

用最终累计值覆盖初始值，不能逐帧相加。工具计数可能省略；不能把“未出现”误认为流已完整结束。搜索一次含 N 个成功查询可计 N 次；图搜按图片及选中的区域计次；链接已抓取但结果被安全检查替换成错误也可能收费；深搜重复打开、已有正文的开页以及 find_in_page 不额外收费。[App 用量](https://api-docs.deepseek.com/guides/web_tools/#billing)、[Messages usage 模式](https://api-docs.deepseek.com/api/create-message)

安全 token 分别在 Messages / Responses 的 `usage.output_tokens_details.safety_tokens`、Chat 的 `usage.completion_tokens_details.safety_tokens`。输入被审查拒绝并返回 400 时，输入仍按缓存命中价收费。[安全计费](https://api-docs.deepseek.com/guides/safety/#billing)

生成中途失败时 HTTP 可能已经是 200：Messages 发 error 后不再发 message_delta / message_stop；Responses 发 response.failed；Chat 可能是带 error、空 choices 的末块，且无 `[DONE]`。这些失败也可能携带应记录的 usage。[生成失败](https://api-docs.deepseek.com/guides/web_tools/#generation-failures)

## 2. Files API 与文件解析

### 2.1 管理接口

| 操作 | OpenAI 形式（Bearer） | Anthropic 形式（x-api-key / Bearer） |
| --- | --- | --- |
| 上传 | POST `/files`，multipart | POST `/anthropic/v1/files`，multipart |
| 列表 | GET `/files` | GET `/anthropic/v1/files` |
| 元信息 | GET `/files/{file_id}` | GET `/anthropic/v1/files/{file_id}` |
| 删除 | DELETE `/files/{file_id}` | DELETE `/anthropic/v1/files/{file_id}` |

Anthropic 的文件操作以及 Messages 中的 file_id 引用要带 `anthropic-beta: files-api-2025-04-14`。上传表单：file 必须；OpenAI 形式 purpose 必须，Anthropic 形式 purpose 默认 user_data；文档务必 **purpose 先于 file**。可选 `expires_after[anchor]=created_at` 与 `expires_after[seconds]` 必须成对，3600–2592000 秒；不设置则永久保存。[Files API](https://api-docs.deepseek.com/guides/files_api/)

| purpose | 内容与上限 |
| --- | --- |
| user_data | 图片 JPEG/PNG/GIF/WebP ≤64 MiB；纯文本/代码、XLS/XLSX、EPUB/MOBI ≤32 MiB；后两类转为文本 / Markdown，文本 ≤8 MiB；不支持 DRM/AZW3 |
| text_recognition | PDF、DOC/DOCX、PPT/PPTX、PNG/JPEG/WebP/GIF/BMP/TIFF；≤100 MiB、≤1000 页；只保留文字 |
| rich_layout_recognition | 同上；文字中保留自动裁出的图表 / 图片；裁图不保证完整，会计入模型的图片及 token 限制 |

非解析文件上传限时 10 分钟；解析文档上传 120 秒，提交后的解析再限 120 秒；并发解析 15，与独立 OCR 分开。单账号存储上限 25 GiB / 10000 文件，文件名 ≤512 bytes；同账号所有 API Key 共享文件。[Files 限制](https://api-docs.deepseek.com/guides/files_api/#limits)、[解析限制](https://api-docs.deepseek.com/guides/document_parsing/#limits)

上传解析是同步等待，**没有解析完成前的进度输出**。断开不取消，成功仍存储和收费；失败不存储不收费。解析文件的原件与解析结果不能下载。PDF/Word/PPT 用 user_data 会失败。每次对话最多引用 20 份文档、总文字 ≤8 MiB，重复引用也计算；后轮全文仍占上下文，超限为 400，不会静默截断。[文件解析](https://api-docs.deepseek.com/guides/document_parsing/)

OpenAI 文件对象字段：`id,object:"file",bytes,created_at`（Unix 秒）、`filename,purpose`，设置过期时还有 expires_at；删除返回 `id,object:"file",deleted:true`。列表可用 `after,limit:1..1000`（默认1000）、`order:asc|desc`（默认asc）、purpose。Anthropic 文件对象改为 `id,type:"file",size_bytes,created_at`（RFC 3339）、`filename,mime_type`；列表用互斥的 after_id / before_id，limit 默认20，不支持 order / purpose；删除返回 `id,type:"file_deleted"`。列表均含 data / first_id / last_id / has_more。[两套 Files 对照](https://api-docs.deepseek.com/guides/files_api/#anthropic-compatible-files-api)

### 2.2 在对话中引用

```json
{
  "messages_document": {"type":"document","source":{"type":"file","file_id":"file-api-example"}},
  "messages_image": {"type":"image","source":{"type":"file","file_id":"file-api-image"}},
  "responses_document": {"type":"input_file","file_id":"file-api-example"},
  "responses_image": {"type":"input_image","file_id":"file-api-image"},
  "chat_document": {"type":"file","file_id":"file-api-example"}
}
```

上例各键是说明标签，实际把对应值放进用户消息的 content。解析文档只能用 file_id，不支持直接传文档 URL / base64，也不能当 image 引用；Messages 还可直接传 `{type:"document",source:{type:"text",media_type:"text/plain",data:"文档文字"}}`。[三协议文档输入](https://api-docs.deepseek.com/guides/document_parsing/#document-qa)

图片及rich_layout裁图还受Vision请求限额约束：最多600张；不含file_id图片时总图片≤64MiB，含file_id时最多200MiB；HTTP请求体≤48MiB；外链/base64单图≤32MiB，file_id单图≤64MiB；单边≤8192px，15张及以上时≤4096px。图片外链≤8192字符；Responses的input_image使用file_id时不能同时给image_url。[Vision限额](https://api-docs.deepseek.com/guides/vision/#limits)

解析只在成功上传时按页收费；之后每次引用仍收输入 token。user_data 的纯文本、表格和电子书转换不收解析费；未发现单列的存储费说明，不据此承诺永久存储免费。[解析计费](https://api-docs.deepseek.com/guides/document_parsing/#billing)

**对 C6 的设计影响：** Files API 的 file_id 是 DeepSeek 上下文，不是通用文本接口。给其他模型使用时，应沿用 [documents.ts](../../packages/server/src/agent/documents.ts) 的本地解析，并对扫描件 / 旧格式使用下一节 OCR，将文字缓存为我们自己的文件。直接接 Files API 无法满足“解析后交给任意模型”。

## 3. 独立 OCR / ASR / TTS

以下均用 DeepSeek Bearer Key；语音并非 OpenAI `/audio/*` 接口，不能直接套用对应 SDK 的 audio 方法。

### 3.1 OCR

- 地址：POST `https://api.deepseek.com/v1/tools/ocr`；multipart **仅** file、purpose 两个必填字段，其他字段为 400；file 要有文件名。
- purpose 为 text_recognition / rich_layout_recognition；支持 PDF、DOC/DOCX、PPT/PPTX 及 PNG/JPEG/WebP/GIF/BMP/TIFF。≤100 MiB、≤1000 页；上传120秒，单次停顿≤30秒；从上传开始总时限180秒。账号并发15。
- 返回 `id,object:"ocr.result",created,purpose,page_count,pages:[{index,text,finish_reason}],usage:{input_tokens,output_tokens,total_tokens}`。页码从0开始，finish_reason 为 stop / length；length 的文字不完整。usage 仅供参考，**按成功页数收费**。
- 文本可能包含 `<｜ref｜>`、`<｜box｜>` 与0–1000的归一化坐标，不能直接当清洁 Markdown。无图的 Word/PPT 在 text_recognition 下可能直接抽取文字。
- 识别期通过换行保活；之后一次给 JSON，不是逐页 SSE。HTTP200 内仍可能是 error 对象。断开不取消，完成仍收费；失败 / 超时不收费。文件不进入 Files API，也不自动给模型。

来源：[OCR 指南](https://api-docs.deepseek.com/guides/ocr/)、[OCR Reference](https://api-docs.deepseek.com/api/ocr)。上传阶段常见400/402/408/413/429/500/503/504；密码文件、损坏或不支持格式、超过1000页需改变输入，不能盲重试。

### 3.2 ASR

- 地址：POST `https://api.deepseek.com/v1/tools/asr`；multipart 的 file，**没有 model / language 参数**，自动识别语言。
- 输入为16-bit PCM WAV 或 Ogg Opus；WAV采样率8000/16000/22050/24000/32000/44100/48000 Hz。单 / 双声道均可，双声道只识别左声道。
- ≤8 MiB、≤120秒，上传≤10分钟；账号并发50。整个文件传完后一次返回 `{request_id,text,duration_ms}`，无流式识别。
- 语言：zh、yue、en、ja、ko、de、fr、es、pt、it、ru、ar、hi、id、vi、th、tr、ms、fil、pl、hu。400为输入 / 格式错误，408上传超时，413超大小，429并发超限，503繁忙，504识别超时。
- 按音频时长计到秒，不足1秒按1秒，价格见下表。

来源：[ASR 指南](https://api-docs.deepseek.com/guides/asr/)。前端录音格式必须另做能力检测 / 编码，浏览器常见 WebM 录音不能直接假定可传。

### 3.3 TTS

| 模式 | 地址与输入 | 输出 |
| --- | --- | --- |
| 整段文本 | POST `https://api.deepseek.com/v1/tools/tts`；JSON text 必填，voice_id 默认stella（女声）/ 可选tide（男声），format 默认wav / 可选pcm，filter_markdown 默认true | HTTP 响应体边合成边返回音频；wav 的 Content-Type 为 audio/wav；pcm 为24kHz、16-bit、单声道原始PCM |
| 增量文本 | WebSocket `wss://api.deepseek.com/v1/tools/tts`；query 可设 voice_id、format（默认pcm，可opus）、filter_markdown；发 `{"event":"text","text":"一段"}`，末尾发 `{"event":"finish_text"}` | 二进制音频帧；最后文本 `{"event":"finish","code":"success","message":"..."}` 或错误码 |

WebSocket 可用 Authorization header，或子协议 `tts, bearer.KEY`；我们的浏览器应连接自家服务器，避免把共享 key 暴露给浏览器。WS 的 opus 是无容器 packet，不能直接保存成 Ogg。无速度控制、无断点续传。[TTS 协议](https://api-docs.deepseek.com/guides/tts/)

单次 / 单会话≤10000计费字符、64KiB文本 / 请求体，最多30分钟音频 / 会话；WS60秒无文本断开，服务端每25秒ping。账号并发50。中文汉字按2字符，其他字符按1；没有language参数，支持zh/yue/en/ja/ko/ms/ar/id/th/vi。400包括无可读文字及内容审查，429并发超限，503繁忙，504合成超时；已开始输出音频后的失败可能只是截断，不能只检查HTTP状态。[TTS 限制与计费](https://api-docs.deepseek.com/guides/tts/#billing)

### 3.4 价格快照

下表全部为 **USD**，来自2026-11-14读取的官方英文价目；语音限时折扣的截止日期没有写明，实施时不能硬编码为长期合同价。

| 项目 | 计价单位 | 当前说明 |
| --- | --- | --- |
| 独立 Search / 原生网页与图片搜索 | 每1000次 | $0.75 |
| 独立 Fetch / 原生页面抓取 | 每1000次 | $0.75 |
| 文件解析 / 独立OCR | 每1000页 | $0.225 |
| ASR | 每小时音频 | 原价$0.116，限时$0.058；按秒向上取整 |
| TTS | 每10000计费字符 | 原价$0.45，限时$0.225；汉字×2 |
| 自动标题 | 每个标题 | 不另收费 |
| high安全审查 | token | 审查token纳入模型output计费，无独立免费承诺 |

来源：[工具与模型价目](https://api-docs.deepseek.com/quick_start/pricing/)、[ASR计价](https://api-docs.deepseek.com/guides/asr/#billing)、[TTS计价](https://api-docs.deepseek.com/guides/tts/#billing)、[标题](https://api-docs.deepseek.com/guides/conversation_title/)、[安全计费](https://api-docs.deepseek.com/guides/safety/#billing)。独立工具费用还应与对话token费用分别累计。

deepseek-flash 的每100万token：缓存命中输入$0.003（谷）/ $0.006（峰），未命中$0.15 / $0.30，输出$0.60 / $1.20；上下文1M，最大输出384K。峰时为工作日UTC01:00–04:00及06:00–10:00，中国法定假日除外，其他为谷时。本地pi-ai目录记录的是峰时价，无法据此精确计算所有时段账单。[模型价格](https://api-docs.deepseek.com/quick_start/pricing/)

## 4. 独立 Search / Fetch 与现有 web 插件

### 4.1 地址、完整参数与响应

两个地址均POST JSON，用 Bearer 与 Content-Type:application/json：

| API | 地址 | 字段 |
| --- | --- | --- |
| Search | `https://api.deepseek.com/v1/tools/search` | query必填，1–128 Unicode字符、不能全空白；count可选，1–50，默认10；ori_question可选，1–128字符，null视为未提供；localization可选IP字符串，默认空串；need_content可选布尔，默认false；未知字段被忽略 |
| Fetch | `https://api.deepseek.com/v1/tools/fetch` | url必填，≤8192字符，必须是有host且不含用户名/密码的HTTP(S) URL |

Search返回 `results[]`：`rerank_score`（0–3）、`title,url,snippet,summary,content,site_name,site_icon,date,authority`。site_name / site_icon / date可为null；date为RFC3339；authority为-1（未知）或0–4；need_content:false时content为空。snippet适合卡片，summary较长适合模型；无结果为正常空数组。Fetch返回 `{title,content}`，content是Markdown，标题可能为空。[Search Reference](https://api-docs.deepseek.com/api/search)、[Fetch Reference](https://api-docs.deepseek.com/api/fetch)

Search支持 `site:`、`-site:`、排除词、排除引号短语、精确短语、`lang:`、`after:`、`before:`，多站点可OR组合；独立接口尚不支持图搜。账号级Search100 QPS / Fetch25 QPS，分别计限额，Fetch另有未公布具体数值的单域名QPS。仅HTTP200且Search非空 / Fetch有正文才计费，count不影响单次价格。[独立接口指南](https://api-docs.deepseek.com/guides/search/)

错误采用 `{error:{message,type,param:null,code}}`。400输入无效、401密钥、402余额、403 Fetch安全策略、404无可用页面、408请求体超时、413过大、429频率、500内部、504下游超时。408/429/5xx可退避重试；其他4xx先改请求或配置。[错误与限额](https://api-docs.deepseek.com/guides/search/#errors)

### 4.2 本项目核对

源码：[web.ts](../../packages/server/src/plugins/web.ts)。`deepseek()`拼接 `${base}/v1/tools/${path}`，Bearer鉴权，Search发送 `{query,count}`，Fetch发送 `{url}`；与上述契约一致。默认count为8；请求未发送need_content，使用默认false；兼容summary/snippet，保留date和站点名。因此结论是**同一套独立API**，没有发现需要更换地址的证据。

当前差距属于实施建议，C0不修改：

- SearchHit/WebSource未保留site_icon、rerank_score、authority；要实现C2的图标来源卡片需扩展来源类型。
- 当前URL清理会去hash和跟踪参数；原生引用 / 历史回放不能用这种有损清理覆盖原始URL或signature。
- deep_search是本地最多5个查询、再抓前4页，截断文字给任意模型；它不同于DeepSeek原生思考搜索，由服务端决定查询和开页。
- 插件当前没有记录独立Search/Fetch次数。新增计账时只计成功非空的调用；不能把错误或空数组当收费成功。
- DeepSeek模型启用原生搜索后，应抑制重复的本地web工具声明 / 指引；其他模型继续使用插件。只按“providerId字符串等于deepseek”判断会漏掉共享提供方的shared-* ID，应按提供方类型/能力。

## 5. pi-ai 1.4.0 源码审计

本地发布包没有src目录，实际阅读的是dist源码而非README推断。以下行号用于定位当前安装版本；升级依赖后须重查。

### 5.1 请求侧与返回侧能力

| 能力 | anthropic-messages | openai-responses |
| --- | --- | --- |
| 直接把options.safety_check/title传入请求 | 不会；buildParams枚举字段 | 不会；buildParams枚举字段 |
| onPayload注入任意顶层字段与tools | **可以**；buildParams之后调用，返回对象作为请求，强制stream:true | **可以**；buildParams之后调用，可替换完整请求 |
| samplingParams注入 | 忽略，不是Anthropic扩展入口 | 会最后Object.assign进请求，可加扩展；本项目仍建议统一用onPayload |
| context.tools原样传任意type | 不会；转换为客户端工具input_schema | 不会；转换为function/custom等已知类型；应用原生工具应在onPayload追加 |
| 原始事件观察 | onProviderStreamEvent，普通message/content事件在归一化之前 | onProviderStreamEvent，在processResponsesStream分派之前 |
| 原生服务端工具输出 | 只识别text/thinking/redacted_thinking/tool_use，忽略server_tool_use及两种结果块 | createSlot仅识别reasoning/message/function_call/custom_tool_call，忽略web_search_call |
| citations / annotations | 不处理citations_delta，也不复制text块的citations | 不处理annotation.added，重建text时丢annotations |
| 思考流 | thinking_delta及signature_delta正常映射 | 支持reasoning_text.delta，适用于DeepSeek，并非只能读summary |
| title | message_delta未映射 | 终态response未映射 |
| server_tool_use / safety_tokens | 未映射到统一Usage | 未映射到统一Usage |
| 拒答 | mapStopReason(refusal)→error，保留rawStopReason；流以error结束 | incomplete.content_filter→error，保留rawStopReason为incomplete.content_filter |
| 历史回放 | convertMessages只重建text/thinking/toolCall，丢原生工具、引用 | convertResponsesMessages同样丢web_search_call，annotations重建为空 |

源码位置（相对 `node_modules/@earendil-works/pi-ai/`）：

- `dist/api/anthropic-messages.js:438`（onPayload）、`:478`（事件观察）、`:504`（块分派）、`:641`（终态/usage）、`:1042`（历史转换）、`:1329`（stop reason）。
- `dist/api/openai-responses.js:150`（onPayload）、`:167`（传递observer）、`:244`（请求构造）；`dist/api/openai-responses-shared.js:411`（createSlot）、`:504`（usage）、`:543`（事件观察）、`:644`（完成块）、`:704`（终态）、`:740`（stop reason）。
- `dist/types.d.ts:48` / `:109`：请求hook；`:250`：TextContent没有引用字段；`:369`：AssistantMessage没有原生工具/标题字段；`:577`：标准事件没有“服务端工具更新”事件。`dist/api/simple-options.js:22`确认streamSimple也保留两个hook。

**重要例外：Messages SSE 的 error 事件在 `iterateAnthropicEvents()`（约`:343`）中直接抛出，早于onProviderStreamEvent。** 服务端附在这个错误帧上的usage不会进入统一Usage。异常字符串保留了原始data，但不宜把“解析错误字符串”当成长期协议。要覆盖失败账单，需定向fetch包装读取错误帧，或自有Messages流解析器 / 上游补丁。

源码另确认 `dist/providers/deepseek.js` 的内置DeepSeek使用 `openAICompletionsApi()`；目录已有deepseek-flash与deepseek-v4-pro，BYOK不需要凭空新增一个重复品牌。需要替换/覆盖其App模型API实现，并限制Pro的App能力。

### 5.2 最小包装方式

当前 [models.ts](../../packages/server/src/agent/models.ts) 是 `createProvider({api:openAIResponsesApi(),models:...})` 的组合入口，并没有已经实现的DeepSeek兼容包装；可沿用这个入口换入工厂。真正现有的流转发参考是 [AppStore.meter](../../packages/server/src/platform/app.ts)，它创建 `createAssistantMessageEventStream()`、转发事件并消费result。

建议新增 `packages/server/src/agent/deepseek.ts`，向外只暴露提供方工厂与应用定义的元信息类型；内部职责：

1. 包装anthropicMessagesApi的stream和streamSimple，链式保留调用方已有onPayload / onProviderStreamEvent / fetch / signal。每次请求分别创建收集器，不能用全局的“当前会话”可变变量。
2. onPayload追加两个原生工具、对象形式的safety_check/title；显式映射思考开关与output_config.effort；保留普通客户端工具。只对App能力模型生效，共享提供方强制high，BYOK按Q6默认high可关。标题仅无自定义标题首轮启用，压缩等后台请求不启用搜索/标题。
3. observer按原生index收集完整content、citations、kind、signature、最终usage/title/refusal；正常文本、思考、客户端工具的统一事件继续由pi-ai处理。应用定义可序列化的 `DeepSeekResponseMeta` 附在消息旁，保存原生回复及派生展示字段；可使用已存在的diagnostics.details容器，或单独的应用文档，最终类型由协议阶段确定。不要靠内存Map长期保存历史。
4. 下次onPayload根据上下文中实际保留的消息重建对应原生assistant content，保留顺序与客户端tool_use ID配对，不能简单按数组位置插入。跨提供方切换、分支、编辑重发、压缩后只回放仍在上下文的记录；引用元数据不应被拼成提示词给其他模型。
5. 工具步骤、引用到达时发布应用自己的持久进度事件 / 文档，再让网页和飞书投影。**不能把server_tool_use伪装成pi的toolCall**，否则agent会再次执行它。只挂最终消息不满足“边搜索边显示步骤”。
6. 拒答终态清掉已经流出的正文、思考和待执行客户端调用，替换为自己的提示，并将其作为明确的拒答状态而非可重试网络故障；保留真实token/工具用量。标题结果通过会话提交回写，避免与用户重命名竞争。
7. 补齐错误帧计账：优先限于此API的fetch流包装观察error及usage，并保持原响应流与取消语义；如实现复杂度接近原生SSE解析器，直接实现小型Messages API适配器也可，不需要复制整份pi-ai或修改node_modules。

这不是“一个onPayload就完成”的改动。原有pi-durable也有限制：`dist/harness/generation.js:318` 的streamResponse只在收到标准事件且partial.content非空时保存进度；纯服务端工具事件不会触发它。`appendAssistant()`（约`:589`）及SQLite路径按JSON保存最终消息，可以承载JSON扩展，但还应通过真实SQLite验证恢复。若使用应用defineDoc承载原生进度，需在会话hook中绑定conversationId，不能把原生工具塞到客户端工具调度链。

对于Responses，同样可用openAIResponsesApi+两个hook包装，终态failure也能被observer看到，错误用量捕获相对方便；仍需额外保存web_search_call、annotations、签名并恢复input。选择Messages的理由是官方展示契约更直接、现有指南/演示覆盖充分，**不是pi-ai已经支持服务端工具**。

## 6. 官方演示的历史导入格式

固定源码版本：[chat-demo@5d5dd75](https://github.com/deepseek-ai/chat-demo/tree/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c)。入口：[格式说明](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/README.md)、[format.ts](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/format.ts)、[schema.ts](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/schema.ts)、[importArchive.ts](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/importArchive.ts)。

```text
manifest.json                              首个条目，export_format_version:3
user.json                                  可选，导入器跳过
chat_sessions/{session_id}.json             会话及完整消息树
chat_session_index.json                     会话索引
chat_sessions/{session_id}_files/{id}_{name} 图片原件
```

会话JSON含 `id,title,pinned,current_message_id,inserted_at,updated_at,messages`；消息含会话内自增id、parent_id、USER/ASSISTANT角色、status、thinking_enabled/search_enabled、accumulated_token_usage、UTC时间、fragments。父id须小于子id、根为用户、角色交替，用current_message_id决定当前分支，不能只按messages数组扁平导入。[类型定义](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/format.ts)

片段包括 REQUEST、RESPONSE、THINK（含elapsed_secs）、TEMPLATE_RESPONSE、TOOL_SEARCH、TOOL_OPEN、TOOL_FIND、READ_LINK、FILE，以及TIP、CONTENT_RISK、PARTIAL_FILE_READ、TOOL_IMAGE_SEARCH。READ_LINK.results保存signature与可选url/title；FILE含文件id、文件名、大小、token_usage、export_path、is_image、宽高和时间。[片段模式](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/format.ts)

导入流先校验manifest，再逐会话写暂存、核对index一一对应与ZIP完整性，成功后事务替换全部本地会话/附件；图片原件按export_path关联，缺图只留元数据，非图片附件原件不在包内。支持ZIP32 STORE/DEFLATE，不支持ZIP64/加密/分卷。模型、原生引用角标、用量、思考签名、原工具ID等不能完整恢复。[导入实现](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/importArchive.ts)、[导出范围](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/README.md)

`toLocal.ts`会把READ_LINK转成可回传的页面签名块，部分不支持展示的片段被丢弃；这份导入器不是任意历史格式的无损迁移工具。后续若另立导入任务，可直接以v3模式为输入契约，自己做用户隔离与导入预览，不能照搬“替换全部会话”的产品行为。本轮仅纠正调研依据，不扩大Q5范围。[转换代码](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/history/toLocal.ts)

## 7. 实施文件、风险与后续验证

### 7.1 建议改动范围（后续C1–C8，不是本次已做）

| 文件 / 新模块建议 | 用途 |
| --- | --- |
| `packages/server/src/agent/deepseek.ts`（新增） | 提供方工厂、Messages包装、请求/原生事件/回放、能力判定 |
| `packages/server/src/agent/models.ts` | 为共享DeepSeek提供方选对api/baseURL/模型能力，保留现有relay入口 |
| `packages/server/src/agent/credentials.ts` | 覆盖内置DeepSeek BYOK的App模型实现，不破坏NO_AMBIENT_AUTH及凭据加密；refreshHost后仍生效 |
| `packages/server/src/platform/app.ts` | shared_providers增加类型/安全策略并分派工厂；usage存token、工具次数及独立服务用量；应用迁移 |
| `packages/server/src/agent/space.ts`及应用扩展 | 绑定会话级原生进度、最终标题/拒答、持久化元信息；网页/飞书同一语义 |
| `packages/server/src/agent/branches.ts`、`trees.ts` | 传搜索/安全等每轮选项，保存供应商标题；当前标题只是首句截取，没有额外LLM标题调用可删 |
| `packages/server/src/plugins/web.ts`及注册选择处 | 非DeepSeek模型保留独立工具；DeepSeek原生模式避免重复联网；扩展来源字段并记录独立调用 |
| `packages/server/src/agent/documents.ts`、`workspace.ts` | OCR兜底与内容缓存，保留本地原件；DeepSeek file_id生命周期与引用映射 |
| `packages/server/src/platform/speech.ts`（新增建议）、`platform/server.ts` | 已认证的`/api/speech/{asr,tts}`、能力探测、限额/流/取消与用量 |
| `packages/protocol/src/accounts.ts`、`index.ts`及新增DeepSeek契约 | 提供方类型、来源/引用/原生步骤/拒答/标题/用量类型；由协议负责人先确定 |
| `packages/web/src/lib/{types,turns}.ts`、聊天消息组件、`features/chat/speech.ts` | 原生来源卡片、逐块引用、服务端进度、终态拒答替换、语音能力与浏览器后备 |
| 管理/模型账户/设置页面与相关spec | DeepSeek只填key、BYOK安全开关、服务用量展示、与C1–C8验收一致 |

### 7.2 需要先处理的风险

1. **上下文静默丢失：** 丢signature仍可200，但先前页面已不在上下文。必须覆盖第二轮、分支、重启、压缩和切换模型。
2. **拒答晚于文本：** 不能见text_end就结算为成功；最后拒答必须替换所有可见正文/思考。飞书等外部渠道宜等终态再发最终正文。
3. **费用低估：** 显示次数≠计费次数；单轮多次推理不受整体max_tokens封顶；错误帧/断开/OCR后台完成也可能有费用。语音响应未提供完整统一Usage，需保存时长/请求字符等计量及估算标记，最终账单另核对。
4. **跨用户文件隔离：** DeepSeek按供应商账号共享文件，应用不能据file_id直接授权；远端文件映射必须含应用用户与提供方身份。删除对话/临时对话后需明确清理、过期及仍被其他分支引用的情况。
5. **语言/录音格式：** ASR并非实时听写，WebM不是保证支持的格式；TTS HTTP与WS的opus/PCM容器不同。现有Web Speech应保留为能力后备。
6. **实际服务兼容尚未验证：** 官方指南与旧兼容表有差异。App指南说required按auto；Messages Reference说any按auto，而Anthropic兼容表仍有“非思考强制”的旧表述。建议只用auto/none，不依赖any/required强制语义。普通工具会话及App会话的历史思考规则也应分别处理。
7. **演示不是规范：** 演示types.ts仍有“扩展模式不支持document”的注释，但当前File Parsing与Messages Reference明确支持，reply.ts实际上也会发送document；其MessageUsage类型也没有覆盖fetch/图搜。以当前官方Reference为设计契约，拿key后核对组合，不复制旧注释。

差异来源：[Anthropic兼容表](https://api-docs.deepseek.com/guides/anthropic_api/)、[Messages工具选择](https://api-docs.deepseek.com/api/create-message)、[当前文件指南](https://api-docs.deepseek.com/guides/document_parsing/)、[演示types.ts](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/api/types.ts)、[演示reply.ts](https://github.com/deepseek-ai/chat-demo/blob/5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c/src/services/chat/reply.ts)。

### 7.3 验证状态与后续最小验收

本次真实调用计数：Messages0、Responses0、Chat0、Files0、OCR0、ASR0、TTS0、独立Search0、Fetch0。没有做模型质量或价格实测，也没有运行与文档无关的代码测试。

后续有key时，每类最多3次小额请求即可先验证关键契约：Messages第1次关闭思考、只开read_url/high/title并输入短公开页面，第2次回传第1轮的读链接signature并追问，第3次开思考与web_search检查深搜。若未返回读链接结果，应注明该路径未验证。Responses和Chat各一轮看原生工具及引用终态；Search/Fetch/OCR/ASR/TTS各用一个短输入。安全拒答只使用已有测试样例；若3次内未触发，应记录“未观察到”，不能把没有拒答当成已验证拒答路径。Files用小文档上传/引用/清理，分别记录管理请求与模型请求数量，不因重试超过各类上限。

实施阶段必须按Spec补充真实SQLite与文件验收：原生块持久化和恢复、拒答替换、引用位置、标题重命名竞争、插件和原生模式互斥、用户/提供方文件隔离、服务用量和错误计账。离线事件回放可测解析器，但不等于真实DeepSeek验证。

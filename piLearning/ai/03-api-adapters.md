# 第一章 · 3 协议适配器解剖与 compat 标志系统

> 源码：`packages/ai/src/api/anthropic-messages.ts`（约 1400 行）、`api/simple-options.ts`、`api/openai-completions.ts`（选读对照）
> 位置：承接第 2 节。请求穿过 Models 和 Provider 两层后抵达这里——真正和厂商 HTTP API 打交道的最底层。

## 1. 它解决什么问题

适配器（adapter）是脏活集中营。每个 `api/*.ts` 要做四件事：

1. **出**：把统一的 `Context`（消息、工具、系统提示词）翻译成厂商请求体
2. **发**：HTTP + SSE（或 WebSocket），处理认证头、超时、重试
3. **入**：把厂商的流式事件翻译成统一的 12 种 `AssistantMessageEvent`
4. **兜底**：任何一步失败都收敛为 `stopReason: "error"` 的消息，不外抛

这一层的价值不在"能跑"，在于它**处理了多少真实世界的边角**。本节以 `anthropic-messages.ts` 为主样本解剖，你读任何一个其他适配器都会看到同样的骨架。

## 2. 每个适配器的统一形状

先看约定。每个协议模块导出**恰好两个函数**，模块本身就满足 `ProviderStreams` 接口：

```typescript
// 每个 api/*.ts 的导出形状
export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = ...;
export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = ...;
```

两者的分工是一层刻意的梯度：

- **`stream`**：暴露该协议的全部原生选项（`AnthropicOptions` 里有 Anthropic 特有的 `effort`、`thinkingDisplay` 等），给需要精细控制的调用方
- **`streamSimple`**：只接受统一的 `SimpleStreamOptions`（其中 `reasoning: "low" | "medium" | "high" ...` 是厂商中立的思考等级），内部翻译成原生选项再调 `stream`

`streamSimple` 就是"统一"发生的地方。以思考等级为例，同一个 `reasoning: "high"`：

- Anthropic 适配器把它映射成 token 预算（`thinkingBudget: 16384`）或新模型的 `effort` 参数
- OpenAI 适配器把它映射成 `reasoning_effort: "high"` 字符串
- 不支持思考的模型直接忽略

这层映射还有一个通用的算术问题：思考 token 也占输出预算。`api/simple-options.ts` 的 `adjustMaxTokensForThinking` 统一处理"maxTokens 要不要为思考扩容、思考预算超过总预算时怎么压缩"，所有 token 制的适配器共享它。同文件的 `clampMaxTokensToContext` 则解决另一个高频报错：请求的 maxTokens 加上输入超过上下文窗口时，厂商会直接 400——pi 在发送前用字符数估算主动收缩：

```typescript
export function clampMaxTokensToContext(model, context, maxTokens: number): number {
  const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
  return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}
```

上面代码中，`CONTEXT_SAFETY_TOKENS`（4096）是给估算误差留的安全垫——字符数除以 4 的估算是粗糙的，宁可少要一点输出也不要整个请求被拒。

## 3. 出向翻译：统一格式 → 厂商格式

`buildParams` + `convertMessages` 负责出向。多数是机械映射，但有几处体现了"消息自带来源标记"（第 1 节伏笔）的价值。最典型的是**回放跨厂商历史**：

```typescript
// convertMessages 内（示意化裁剪）：回放一条历史 assistant 消息里的 thinking 块
if (block.type === "thinking") {
  if (isSameProviderAndModel && block.thinkingSignature) {
    out.push({ type: "thinking", thinking: ..., signature: block.thinkingSignature });
  } else {
    // 别家模型产生的思考：签名无法通过本家校验，降级为普通文本
    out.push({ type: "text", text: `<thinking>\n${block.thinking}\n</thinking>` });
  }
}
```

上面代码中，Anthropic 要求 thinking 块携带自家签发的加密签名，用户中途从 GPT 切到 Claude 时，历史里 GPT 的思考块没有合法签名——适配器读消息上的 `provider/model` 标记识别出这种情况，把思考降级为带 `<thinking>` 标签的文本。**对话中途换模型**这个 pi 的核心体验，是靠每个适配器做这类防御才成立的。

出向还有一个彩蛋级设计——"隐身模式"。用 OAuth 登录（Claude Pro 订阅）调用时，适配器把工具名转换成 Claude Code 的规范命名：

```typescript
const claudeCodeTools = ["Read", "Write", "Edit", "Bash", "Grep", ...];
const toClaudeCodeName = (name) => ccToolLookup.get(name.toLowerCase()) ?? name;
```

上面代码让 pi 的请求在 Anthropic 后端看来与 Claude Code 一致（配套的还有 system prompt 首行、User-Agent 版本号），因为订阅制 OAuth 通道校验客户端身份。入向再把工具名映射回来。这类"不体面但必要"的代码被整齐地圈在适配器里，一行都不会泄漏到上层。

## 4. 入向翻译：厂商流 → 统一事件

入向是一个状态机：逐个消费厂商 SSE 事件，维护"正在构建的 AssistantMessage"，翻译成统一事件推入 `AssistantMessageEventStream`。骨架：

```
for await (anthropicEvent of sse) {
  switch (anthropicEvent.type) {
    case "content_block_start": → push({ type: "text_start" | "thinking_start" | "toolcall_start", partial })
    case "content_block_delta": → 累加到当前块; push({ type: "*_delta", delta, partial })
    case "content_block_stop":  → push({ type: "*_end", ..., partial })
    case "message_delta":       → 累计 usage、记录 stop_reason
  }
}
push({ type: "done" | "error", message: 最终消息 })
```

其中工具调用的参数解析藏着一个必须知道的细节。厂商流式输出工具参数时给的是**JSON 字符串的碎片**（`{"pa`、`th": "/e`、`tc"}`），网络中断或输出截断时拼出来的是半个 JSON。pi 用 `utils/json-parse.ts` 的**修复式解析**（`parseJsonWithRepair`）尽力补全括号引号解析出参数——这让下游拿到的 `toolCall.arguments` 永远是对象而不是异常。

但"尽力修复"引出一个危险：截断的参数**可能修复成一个合法但不完整的对象**（edit 工具的替换文本少一半）。适配器层无法判断完整性，于是把责任上移：消息带上 `stopReason: "length"`，由 agent 循环拒绝执行该消息里的所有工具调用（第二章讲循环时会看到那段防御）。**每一层只做自己层能做的判断**，这是分层健壮性的好样本。

## 5. compat：用数据描述厂商差异

现在回答总览里的问题：几十家"OpenAI 兼容"厂商各有细微不兼容，怎么办？

`openai-completions.ts` 是被复用最狠的适配器——xAI、Groq、DeepSeek、Cerebras、OpenRouter、llama.cpp 全走它。差异用 `Model.compat` 上的一组声明式标志描述（`OpenAICompletionsCompat`，30 多个字段），适配器按标志分支。感受一下它们描述的问题有多具体：

```typescript
interface OpenAICompletionsCompat {
  supportsReasoningEffort?: boolean;   // 支持 reasoning_effort 字段吗
  maxTokensField?: "max_completion_tokens" | "max_tokens";  // 用哪个字段名
  requiresToolResultName?: boolean;    // 工具结果必须带 name 字段吗
  requiresAssistantAfterToolResult?: boolean;  // 工具结果后必须垫一条 assistant 吗
  requiresThinkingAsText?: boolean;    // thinking 块要转成 <thinking> 文本吗
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "zai" | "qwen" | ...;  // 思考参数的 10 种方言
  cacheControlFormat?: "anthropic";    // 要打 Anthropic 风格的缓存标记吗
  ...
}
```

上面每个字段背后都是某家厂商的一次真实翻车。设计的妙处在于三层递进的默认值：

1. **未设置** → 适配器根据 baseUrl **自动探测**（已知厂商的 URL 特征硬编码在适配器里）
2. **生成的模型目录显式设置** → 构建时从 models.dev 数据 + 人工修正生成
3. **用户自定义 provider 覆盖** → models.json 里可以逐字段指定

对比朴素方案（每家厂商继承适配器类改写方法）：compat 是**数据不是代码**——可以生成、可以序列化进模型目录、可以让用户在配置文件里修正，而不需要发版。新厂商 90% 的情况只是"一个 URL + 几个 compat 标志"。

Anthropic 协议同样有自己的 `AnthropicMessagesCompat`（Fireworks 等 Anthropic 兼容厂商用），责任划分一致。

## 6. 设计取舍

- **一个适配器 + N 个标志** vs **N 个适配器子类**：pi 选了前者。代价是 `openai-completions.ts` 长到 1400 行、内部分支多；收益是行为差异全部可见、可配置、可测试。当分支多到失控时才值得拆新协议（OpenAI 的 responses API 就拆了）。
- **修复式 JSON 解析**接受了"宁可给出可疑数据也不中断流"的立场，把完整性判断上移给有更多上下文的层。
- 隐身模式这类兼容脏活**留在适配器**而非中间件层，因为它们和协议细节强耦合——中间件抽象反而会让这些逻辑没地方放。

总之，适配器层的架构思想一句话：**差异有两种，格式差异用独立协议实现隔离，行为差异用 compat 数据描述**。判断一个差异属于哪种，是维护这类多厂商库的核心手艺。

## 动手实验

用 `onPayload` 回调直接观察出向翻译的产物（faux 不走真实适配器，这里需要一个真实 key，或只看请求体不发送）：

```typescript
// 有任一厂商 key 时：观察统一 Context 被翻译成的厂商请求体
const stream = models.streamSimple(model, context, {
  reasoning: "high",
  onPayload: (payload) => { console.log(JSON.stringify(payload, null, 2)); },
});
```

对同一个 `context` 分别用 Anthropic 和 OpenAI 的模型跑一次，对比两个 payload：系统提示词的位置、工具的编码、思考参数的形态。这个对比是理解"适配器到底在干什么"最直观的一课。没有 key 的话，替代方案是读 `packages/ai/test/` 下以适配器命名的测试文件，测试断言里写着预期的请求体形状。

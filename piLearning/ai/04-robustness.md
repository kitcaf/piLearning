# 第一章 · 4 健壮性工程：重试、溢出检测与 faux 测试

> 源码：`packages/ai/src/utils/retry.ts`、`utils/provider-retry.ts`、`utils/overflow.ts`、`providers/faux.ts`
> 位置：本章收官。前三节讲了"怎么把请求发对"，本节讲"发不对的时候怎么办"——以及怎么在不花钱的前提下测试这一切。

## 1. 它解决什么问题

LLM API 是不可靠依赖的集大成者：会限流、会超时、会 5xx、会中途断流；上下文超限时每家报错的文案还都不一样。一个生产级 agent 每天要面对成百上千次这类失败。

pi 在 `utils/` 里沉淀了三件武器：**分类器**（这个错误是什么性质）、**重试器**（值得重试的自动重试）、**溢出检测器**（上下文超限单独识别，交给压缩而不是重试）。三者都建立在"错误即数据"之上——它们的输入不是异常对象，而是 `stopReason: "error"` 的 AssistantMessage。

## 2. 两级重试：SDK 层和策略层

pi 的重试有两级，职责刻意分开：

| 层 | 位置 | 处理什么 | 谁配置 |
|---|------|---------|--------|
| 传输层重试 | `provider-retry.ts`，适配器内部 | 单次 HTTP 请求的 429/5xx，尊重 `Retry-After` 头 | `maxRetries` 选项 |
| 策略层重试 | `retry.ts` 的 `retryAssistantCall` | 整条 assistant 消息级别的失败 | 上层的 `RetryPolicy` |

传输层里有个容易忽略的保护——`maxRetryDelayMs`（默认 60 秒）：

```typescript
// provider-retry.ts：服务端要求等待过久时，放弃而不是傻等
function getRetryDelayMs(error, retryIndex, maxRetryDelayMs) {
  const serverDelay = validateServerRetryDelayMs(error, maxRetryDelayMs);  // 读 Retry-After
  // 服务端要求的等待超过上限 → 直接失败，把"要等多久"写进错误消息，让上层带着用户可见性处理
  ...
}
```

上面代码的立场：**长等待不该静默发生**。厂商限流时可能返回"120 秒后再试"，底层默默睡两分钟对交互式 CLI 是灾难——用户只看到卡死。超过上限就立刻失败并把时长写进错误文案，上层（UI）决定是显示倒计时还是让用户换模型。

策略层 `retryAssistantCall` 的循环体现了错误即数据的红利——它重试的依据不是异常类型，而是消息字段：

```typescript
for (;;) {
  const response = await produce();
  if (response.stopReason === "aborted") return response;        // 用户中止：永不重试
  if (response.stopReason !== "error") return response;          // 成功：直接返回
  if (attempt >= maxAttempts || !isRetryableAssistantError(response))
    return response;                                             // 不可重试/预算耗尽：原样返回
  attempt++;
  const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);       // 指数退避
  await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, ...);
  await sleep(delayMs, signal);
  await callbacks?.onRetryAttemptStart?.();
}
```

上面代码中三个细节：

- **中止（aborted）是终态，永不重试**——用户按了 Esc，系统不能自作聪明再来一次。退避睡眠期间的中止也被归一化成同样的 aborted 消息，"调用方不需要关心取消发生在哪个阶段"（源码注释原话）。
- **不可重试的错误立刻返回**。`isRetryableAssistantError` 用两组正则分类：可重试的（429、5xx、overloaded、ECONNRESET……）和明确不可重试的（quota exhausted、billing、invalid api key——这些重试一万次也不会好）。
- **每一步都有回调**（`onRetryScheduled` 等）——重试对用户可见（CLI 显示"第 2/3 次重试，等待 4s"），而不是黑箱里的沉默。

你可能会问：为什么策略层不放在 pi-ai 内部自动执行？因为**重试整条消息意味着重新计费**，这是应该由应用层（带着预算和用户意愿）决定的事。pi-ai 只提供机制（分类器 + 循环），策略（重不重试、试几次）留给上层——和第二章 agent 包"机制与策略分离"是同一哲学。

## 3. 溢出检测：一个正则动物园

上下文超限是一种特殊错误：重试无意义（再发一次还是超），正确响应是**压缩上下文**。所以它必须从一般错误中被单独识别出来。

问题是没有标准错误码，每家的文案五花八门。`utils/overflow.ts` 是一个用注释详尽标注来源的正则动物园：

```typescript
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,                              // Anthropic
  /exceeds the context window/i,                      // OpenAI
  /input token count.*exceeds the maximum/i,          // Google
  /maximum prompt length is \d+/i,                    // xAI
  /reduce the length of the messages/i,               // Groq
  /exceeds the available context size/i,              // llama.cpp
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,    // Cerebras: 400/413 无响应体
  ... // 20+ 条，每条注明厂商
];
const NON_OVERFLOW_PATTERNS = [
  /rate limit/i, /too many requests/i, ...  // 排除误伤：限流文案里也有 "too many tokens"
];
```

上面代码中值得学的不是正则本身，而是**负面清单**的存在：Bedrock 的限流错误 "Too many tokens, please wait" 会误中溢出模式，所以先过一遍排除名单。模式匹配式的错误分类必须配排除项，否则假阳性会引发错误的自动化行为（这里是不必要的压缩）。

文件头的注释还记录了更阴险的变体：z.ai **不报错**，静默接受溢出（靠 `usage.input > contextWindow` 事后检测）；小米 MiMo 把输入截断到刚好填满窗口再返回 `length`。**厂商的失败方式本身就是需要维护的知识库**——这个文件的注释密度是整个仓库最高的之一，因为每一行都是一次真实的踩坑。

## 4. faux provider：让一切可测试

前面所有机制怎么测试？靠真实 API 测既花钱又不稳定。`providers/faux.ts` 提供一个**完整实现了 Provider 接口的假厂商**——它走和真厂商完全相同的分发路径（`createProvider` 构造、事件逐个流出、模拟 token 速率），只是响应是预先编排的：

```typescript
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);            // 和真 provider 一样注册

faux.setResponses([
  fauxAssistantMessage([fauxToolCall("read_file", { path: "/etc/hosts" })]), // 第 1 次调用的回复
  fauxAssistantMessage("文件内容是..."),                                     // 第 2 次调用的回复
]);
```

上面代码编排了一段"先调工具、再总结"的两轮剧本。`setResponses` 还接受**函数**（`FauxResponseFactory`），能根据收到的 context 动态生成回复——可以断言"模型第二次收到的上下文里包含了工具结果"。

faux 的价值随层数放大：第二章的 agent 循环测试、第四章 coding-agent 的会话测试，全部构建在它上面。**在抽象边界上提供高保真假实现**，是让整个系统可测试的支点——如果你的系统某个外部依赖没有 faux 等价物，那个依赖周围的代码大概率没有测试。

## 5. 本章总结

回看四节，`pi-ai` 的架构思想可以收拢成四句话：

1. **统一的代价一次付清**：消息模型、事件协议、流容器设计好之后，30 家厂商是 30 份数据档案，不是 30 套代码（第 1、2 节）
2. **差异分两种**：格式差异 → 独立协议实现；行为差异 → compat 数据标志（第 3 节）
3. **错误即数据**贯穿始终：从 lazyStream 的 setup 失败到重试分类器，错误永远是一条可渲染、可持久化、可检查的消息（第 1、4 节）
4. **机制与策略分离**：pi-ai 提供解析链、重试循环、溢出分类这些机制；用不用、怎么用由上层带着业务上下文决定（第 2、4 节）

带着这四句话进入第二章——你会看到 agent 包在这层地基上，只用了一个类型（`StreamFn`）就接住了整个 pi-ai。

## 动手实验

用 faux 编排一次"错误 → 重试 → 成功"的完整剧本，验证第 2 节的重试循环：

```typescript
// npx tsx scratch.ts
import { createModels, fauxProvider, fauxAssistantMessage, retryAssistantCall } from "@earendil-works/pi-ai";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
  fauxAssistantMessage("第二次成功了"),
]);

const ctx = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
const result = await retryAssistantCall(
  () => models.completeSimple(faux.getModel(), ctx),
  { enabled: true, maxRetries: 2, baseDelayMs: 100 },
  undefined,
  { onRetryScheduled: (a, max, delay, err) => console.log(`重试 ${a}/${max}，等待 ${delay}ms：${err}`) },
);
console.log(result.stopReason, result.content);
```

预期输出：一行重试日志（100ms 退避），然后 `stop 第二次成功了`。把 errorMessage 换成 `"invalid api key"` 再跑——分类器判定不可重试，直接返回错误，不会有重试日志。

# 第二章 · 1 核心循环：全项目最重要的 800 行

> 源码：`packages/agent/src/agent-loop.ts`（约 800 行）
> 位置：承接总览。本节读的是三层洋葱的最内层——一个无状态的纯函数循环。第 2 节的 Agent 类和第 3 节的 harness 都只是往这个循环里塞不同的配置。

## 1. 它解决什么问题

总览里那个手写 while 循环缺的六样东西——插话、事件、截断保护、并发时序、持久化、压缩——前四样都在这个文件里解决。后两样（持久化、压缩）故意**不在**这里：循环通过回调把决策权交给外层，自己保持无状态。

先看入口签名，注意它拿到什么、吐出什么：

```typescript
// src/agent-loop.ts
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,        // { systemPrompt, messages, tools }
  config: AgentLoopConfig,      // model + 一组回调
  signal: AbortSignal | undefined,
  streamFn: StreamFn,           // 第一章的 streamSimple
): EventStream<AgentEvent, AgentMessage[]>
```

上面代码中，返回值是第一章介绍过的 `EventStream` 容器——消费者可以 `for await` 逐事件处理，也可以 `await stream.result()` 只拿最终新增的消息数组。**LLM 调用能力完全由外部注入**（`streamFn` 参数），循环自己不 import 任何 provider，这让它可以用 faux provider 测试，也可以跑在浏览器里走代理。

## 2. 主干：双层 while

整个循环的骨架在 `runLoop` 函数里，裁剪后是这样：

```typescript
// src/agent-loop.ts · runLoop，已裁剪
let pendingMessages = (await config.getSteeringMessages?.()) || [];

while (true) {                                    // 外层：follow-up 续命
  let hasMoreToolCalls = true;
  while (hasMoreToolCalls || pendingMessages.length > 0) {   // 内层：轮
    await emit({ type: "turn_start" });
    for (const m of pendingMessages) { /* 注入 context，emit message 事件 */ }
    pendingMessages = [];

    const message = await streamAssistantResponse(...);      // 一次 LLM 调用
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      await emit({ type: "turn_end", message, toolResults: [] });
      await emit({ type: "agent_end", messages: newMessages });
      return;                                     // 错误消息已入 transcript，直接收尾
    }

    const toolCalls = message.content.filter(c => c.type === "toolCall");
    if (toolCalls.length > 0) { /* 执行工具，结果入 context */ }
    await emit({ type: "turn_end", message, toolResults });

    if (await config.shouldStopAfterTurn?.({...})) { /* emit agent_end; return */ }
    pendingMessages = (await config.getSteeringMessages?.()) || [];
  }
  const followUps = (await config.getFollowUpMessages?.()) || [];
  if (followUps.length === 0) break;
  pendingMessages = followUps;                    // 有追加消息，再来一圈
}
await emit({ type: "agent_end", messages: newMessages });
```

上面代码值得逐点确认：

**(a) 一"轮"（turn）= 一次 LLM 调用 + 它要求的全部工具执行。** 内层循环每转一圈就是一轮。只要模型还在发工具调用（`hasMoreToolCalls`）或有待注入的消息，就继续转。

**(b) 错误路径没有 throw。** 注意 `stopReason === "error"` 的分支：错误的 assistant 消息**照常进入 `newMessages`、照常发 `turn_end` 和 `agent_end`**，然后正常 return。第一章的"错误即数据"契约在这里兑现——上层想重试，检查最后一条消息的 stopReason 即可，不需要 catch。

**(c) 插话（steering）与追加（follow-up）是两个不同的检查点。** 这是循环里最容易混淆、也最有设计含量的部分，下一节单独讲。

## 3. steering 与 follow-up：两种"用户想说话"

用户在 agent 干活时输入消息，有两种意图，pi 用两条队列区分：

| | steering（插话） | follow-up（追加） |
|---|---|---|
| 意图 | "现在就听我说"——纠偏 | "做完手头的再说"——排队 |
| 检查时机 | **每轮结束后**都查 | 只在 agent **即将停下**时查 |
| 效果 | 下一次 LLM 调用前注入 | 注入并让 agent 再跑一整段 |

对照代码看时机差异：`getSteeringMessages` 在内层循环每圈末尾被调用（工具刚执行完、下一次 LLM 调用之前）；`getFollowUpMessages` 只在内层循环退出后（没有工具调用、没有插话，agent 本来要停了）才被调用。

你可能会问：插话为什么不能立刻中断正在跑的工具？看注入点——插话消息只在**轮边界**注入，当前 assistant 消息要求的工具调用全部照常执行完。这是有意的：assistant 消息里的 toolCall 必须有配对的 toolResult，否则下一次请求会被厂商 API 拒绝（协议要求 tool_use 和 tool_result 严格配对）。**轮边界是唯一能安全插入消息的位置**。真想立刻停，用 `signal` 中止整个循环。

还有个细节：循环**启动时**就查一次 steering 队列（`runLoop` 第一行）。用户在 agent 空闲时输入的消息可能已经入队，不查就会丢。

## 4. 流式响应如何进入上下文：partial 占位

`streamAssistantResponse` 负责一次 LLM 调用。它有个精妙的动作——**流刚开始就把半成品消息放进上下文**：

```typescript
// src/agent-loop.ts · streamAssistantResponse，已裁剪
for await (const event of response) {
  switch (event.type) {
    case "start":
      partialMessage = event.partial;
      context.messages.push(partialMessage);       // 半成品先占位
      await emit({ type: "message_start", message: { ...partialMessage } });
      break;
    case "text_delta": /* ...其余 delta 事件... */
      partialMessage = event.partial;
      context.messages[context.messages.length - 1] = partialMessage;  // 原位替换
      await emit({ type: "message_update", assistantMessageEvent: event, ... });
      break;
    case "done":
    case "error": {
      const finalMessage = await response.result();
      context.messages[context.messages.length - 1] = finalMessage;   // 定稿替换
      await emit({ type: "message_end", message: finalMessage });
      return finalMessage;
    }
  }
}
```

上面代码中，`context.messages` 的最后一个位置从流开始起就被 partial 占住，每个事件到达就原位替换成更新的快照，最后替换成定稿。这依赖第一章讲的"每个事件都带 partial 完整快照"协议——正因为每个事件携带拼好的整条消息，这里才能用"无脑替换"代替"增量拼接"。收益：任何时刻观察 `context.messages`，看到的都是一致的对话状态，包括正在生成的半条消息。

另外注意 LLM 调用前的一行：

```typescript
const resolvedApiKey =
  (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
```

上面代码是"每次调用前才解析 API key"的实现。朴素方案在 agent 启动时解析一次，但工具可能跑几分钟，OAuth token（如 GitHub Copilot 的短时 token）会在这期间过期。每轮重新解析，token 永远新鲜。

## 5. 截断保护：length 停止的工具调用一律不执行

循环里有一个不起眼但含金量很高的分支：

```typescript
// src/agent-loop.ts · runLoop 内
const executedToolBatch =
  message.stopReason === "length"
    ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
    : await executeToolCalls(currentContext, message, config, signal, emit);
```

上面代码中，当消息因输出 token 上限被截断（`stopReason: "length"`）时，**所有**工具调用都不执行，而是每个都生成一条错误 toolResult，告诉模型"你的参数可能被截断了，重发"。

为什么要全部拒绝，而不是只拒绝最后一个？源码注释说得很清楚：流式工具调用参数用**尽力而为的 JSON 补救解析器**收尾，截断的 JSON 可能被补成**能通过 schema 校验但内容不完整**的参数——比如 `write` 工具的文件内容少了后半截。你无法区分哪个调用是完整的，所以一个都不能信。不这么做的后果：模型悄悄写出半个文件，用户毫无察觉。

## 6. 并行工具执行的时序保证

多个工具调用默认并行执行（`toolExecution: "parallel"`），但"并行"不等于"事件乱序"。pi 给出三条精确的顺序保证：

| 阶段 | 顺序 |
|---|---|
| `tool_execution_start` + 参数校验 + `beforeToolCall` 钩子 | **assistant 源顺序**（串行 preflight） |
| 工具实际执行 + `tool_execution_end` | **完成顺序**（并发） |
| toolResult 消息入上下文 + `message_start/end` | **assistant 源顺序** |

实现靠一个小技巧——数组里混放"值"和"迟到的承诺"：

```typescript
// src/agent-loop.ts · executeToolCallsParallel，已裁剪
const finalizedCalls: FinalizedToolCallEntry[] = [];   // 值 或 () => Promise<值>
for (const toolCall of toolCalls) {
  await emit({ type: "tool_execution_start", ... });   // 按源顺序
  const preparation = await prepareToolCall(...);      // 校验 + beforeToolCall，串行
  if (preparation.kind === "immediate") {              // 校验失败/被 block：结果立即定型
    finalizedCalls.push(finalized);
    continue;
  }
  finalizedCalls.push(async () => {                    // 通过校验：入队一个执行函数
    const executed = await executePreparedToolCall(preparation, signal, emit);
    const finalized = await finalizeExecutedToolCall(...);
    await emit(/* tool_execution_end，完成即发 */);
    return finalized;
  });
}
const ordered = await Promise.all(
  finalizedCalls.map(e => typeof e === "function" ? e() : Promise.resolve(e)),
);
for (const finalized of ordered) { /* 按源顺序发 toolResult 消息 */ }
```

上面代码中，`Promise.all` 在 map 的一瞬间**同时启动**所有执行函数（这就是并行），但返回值数组保持源顺序，随后 toolResult 消息按这个顺序落盘。`tool_execution_end` 在每个执行函数内部发出，所以它跟随完成顺序——UI 能实时看到"哪个先做完"，而模型看到的 transcript 永远整齐。

两个相关规则：任何一个被调用的工具带 `executionMode: "sequential"` 标记，**整批**降级为串行（比如 edit 工具不能和别的写文件工具并发）；所有工具结果都带 `terminate: true` 时循环提前收工（`shouldTerminateToolBatch`），这是给"任务完成汇报"类工具用的逃生门。

## 7. 设计取舍

- **轮边界注入 vs 立即中断**：插话延迟到轮边界，代价是"停不下正在跑的三分钟 bash"，换来的是 transcript 永远满足工具调用配对协议。立即停的需求交给 `signal`，两种手段各管一头。
- **循环无状态 vs 内置状态**：`agentLoop` 每次调用都从传入的 context 出发，不留任何字段。代价是每个调用方都要自己管理消息数组的所有权（下一节会看到 Agent 类为此做的拷贝动作）；收益是循环可以被 harness 以完全不同的状态策略复用。
- **preflight 串行 vs 全并行**：参数校验和 `beforeToolCall` 钩子如果也并行，钩子看到的上下文就是竞态的。pi 选择 preflight 串行、只并行真正的执行——牺牲毫秒级的启动延迟，换钩子语义确定。

总之，这 800 行的价值不在"循环"本身，而在轮边界这个概念：插话注入、截断拒绝、并行收敛、错误收尾，全部对齐到轮边界发生。**把所有异步的乱都收敛到一个同步点，是这个文件最值得带走的架构手法。**

## 动手实验

用 faux provider 观察一次带工具调用的完整事件序列：

```typescript
// scratch-loop.ts —— npx tsx scratch-loop.ts
import { agentLoop } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("add", { a: 1, b: 2 })], { stopReason: "toolUse" }),
  fauxAssistantMessage("1 + 2 = 3"),
]);

const addTool = {
  name: "add", label: "Add", description: "add two numbers",
  parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
  execute: async (_id: string, p: { a: number; b: number }) =>
    ({ content: [{ type: "text" as const, text: String(p.a + p.b) }], details: {} }),
};

const stream = agentLoop(
  [{ role: "user", content: "1+2=?", timestamp: Date.now() }],
  { systemPrompt: "calc", messages: [], tools: [addTool] },
  { model: faux.getModel(), convertToLlm: (m) => m as any },
  undefined,
  models.streamSimple.bind(models),
);
for await (const ev of stream) console.log(ev.type);
```

预期看到两轮：第一轮以 `tool_execution_start → tool_execution_end → message_start/end`（toolResult）收尾，随后 `turn_end → turn_start` 进入第二轮，最后 `agent_end`。把第一条 faux 响应的 `stopReason` 改成 `"length"`，观察工具**不执行**、toolResult 变成"re-issue the tool call"错误——这就是第 5 节的截断保护。

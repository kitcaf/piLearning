# 第二章 · 2 Agent 类：把无状态循环变成有状态对象

> 源码：`packages/agent/src/agent.ts`（约 570 行）、`src/types.ts`（AgentState / AgentEvent 部分）
> 位置：承接第 1 节。`agentLoop` 是纯函数，每次调用自带全部输入；本节的 `Agent` 类给它包上状态、订阅和队列，是大多数应用直接使用的那一层。为第 3 节 harness 做铺垫——harness 没有复用 Agent 类，而是自己包了一层，看完本节你会理解为什么。

## 1. 它解决什么问题

直接用 `agentLoop` 写应用，你要自己维护四样东西：消息数组的所有权、"正在流式输出"的 UI 状态、插话/追加消息的队列、以及中止句柄。`Agent` 类就是这四样东西的标准实现，加起来不到 600 行。

它对循环的封装方式值得先点破：**Agent 不改循环一行代码，只是给循环的每个回调参数提供一个"标准答案"**。看 `prompt()` 的调用链：

```typescript
// src/agent.ts · runPromptMessages，已裁剪
await runAgentLoop(
  messages,
  this.createContextSnapshot(),      // 状态 → 循环输入
  this.createLoopConfig(),           // 队列 → 循环回调
  (event) => this.processEvents(event),  // 事件 → 状态更新 + 订阅者
  signal,
  this.streamFunction,
);
```

上面代码中，三个 `create*`/`process*` 方法就是本节的全部内容：状态怎么进循环、队列怎么变回调、事件怎么变回状态。

## 2. 状态进循环：快照隔离

`createContextSnapshot` 只有五行，但每行都在拷贝：

```typescript
// src/agent.ts
private createContextSnapshot(): AgentContext {
  return {
    systemPrompt: this._state.systemPrompt,
    messages: this._state.messages.slice(),
    tools: this._state.tools.slice(),
  };
}
```

上面代码中，`messages` 和 `tools` 都被 `slice()` 浅拷贝。为什么？第 1 节说过，循环会往 context.messages 里塞 partial 消息、原位替换、再塞 toolResult——如果直接把 `this._state.messages` 交出去，循环的中间操作会直接污染 Agent 的公开状态。快照隔离后，Agent 的状态只通过一条路径更新：事件。

对应地，`AgentState` 的 setter 也做拷贝（`state.messages = arr` 会 `arr.slice()` 后存储），防止调用方保留引用远程篡改。**同一个防御思想贯穿：数组的所有权边界处必拷贝。**

## 3. 事件回状态：单一归约点

循环发出的每个事件都流经 `processEvents`，它先更新状态、再通知订阅者：

```typescript
// src/agent.ts · processEvents，已裁剪
switch (event.type) {
  case "message_start":
  case "message_update":
    this._state.streamingMessage = event.message; break;
  case "message_end":
    this._state.streamingMessage = undefined;
    this._state.messages.push(event.message); break;    // 状态里只存定稿
  case "tool_execution_start": /* pendingToolCalls.add(id) */ break;
  case "tool_execution_end":   /* pendingToolCalls.delete(id) */ break;
  case "turn_end":
    if (event.message.role === "assistant" && event.message.errorMessage)
      this._state.errorMessage = event.message.errorMessage; break;
}
for (const listener of this.listeners) {
  await listener(event, signal);        // 注意：await，且按注册顺序
}
```

上面代码有两个决定：

**(a) 状态里只存定稿消息。** 流式中间态放在独立的 `streamingMessage` 字段，`message_end` 时才 push 进 `messages`。于是 `state.messages` 永远只含完整消息，UI 渲染"历史 + 一条正在打的消息"时两个来源界限分明。这与循环内部"partial 占位原位替换"策略刚好相反——同一个问题（流式消息怎么表示）在两层有两个答案，因为消费者不同：循环的 context 要喂 LLM，必须是一个数组；Agent 的 state 要喂 UI，分开更好用。

**(b) 订阅者被 await，且是循环的一部分。** 每个 listener 的 promise 被逐个 await 完，`processEvents` 才返回，循环才继续下一步。这意味着**订阅者是同步屏障（barrier）**：你在 `message_end` 里做的持久化写盘，保证发生在工具 preflight 之前。README 明确把这作为 Agent 类相对裸 `agentLoop` 的核心增值——裸循环的 EventStream 是旁观式的，不等消费者。

代价也直白：一个慢订阅者拖慢整个 agent。pi 认为值得——事件顺序和持久化一致性比吞吐重要，这是 coding agent 的场景决定的（第四章的会话持久化就吊在这个屏障上）。

## 4. 队列变回调：steer 与 followUp 的落地

第 1 节讲了循环在轮边界调用 `getSteeringMessages` / `getFollowUpMessages`。Agent 类这边就是两个 `PendingMessageQueue`：

```typescript
// src/agent.ts · createLoopConfig，已裁剪
getSteeringMessages: async () => {
  if (skipInitialSteeringPoll) {       // 见下文
    skipInitialSteeringPoll = false;
    return [];
  }
  return this.steeringQueue.drain();
},
getFollowUpMessages: async () => this.followUpQueue.drain(),
```

队列的 `drain()` 有两种模式（`QueueMode`）：`"all"` 一次全取，`"one-at-a-time"`（默认）每个轮边界只取最老的一条。你可能会问：为什么默认一条条来？因为每条插话都值得模型单独回应一轮；一次注入五条，模型往往只理睬最后一条。宁可多跑几轮，不丢用户意图。

`skipInitialSteeringPoll` 是个小而准的补丁：`continue()` 在"最后一条消息是 assistant"时会把 steering 队列的消息**作为 prompt** 启动新循环；此时循环启动时的首次 steering 轮询必须跳过一次，否则同一条消息会被消费两次路径。边界情况的处理常常暴露设计的成色——这里用一个一次性布尔量解决，没有引入新状态机。

## 5. 生命周期：一次只跑一个 run

`prompt()` 和 `continue()` 都经过 `runWithLifecycle`，它维护唯一的 `activeRun`：

```typescript
// src/agent.ts · runWithLifecycle，已裁剪
if (this.activeRun) throw new Error("Agent is already processing.");
const abortController = new AbortController();
this.activeRun = { promise, resolve, abortController };
this._state.isStreaming = true;
try {
  await executor(abortController.signal);
} catch (error) {
  await this.handleRunFailure(error, abortController.signal.aborted);
} finally {
  this.finishRun();       // isStreaming = false，activeRun = undefined
}
```

上面代码中，重复 `prompt` 直接抛错——**并发提示不是排队，是编程错误**；想排队就用 `steer`/`followUp`，这是 API 在强制引导正确用法。`abort()` 只是 `abortController.abort()`，循环和工具通过 signal 协作式退出。`waitForIdle()` 返回 `activeRun.promise`，它在 `finishRun` 时 resolve——也就是说 idle 的定义包含"所有 `agent_end` 订阅者已 settle"，持久化写完之前 agent 不算闲。

再看 catch 分支的 `handleRunFailure`。第 1 节说过循环内部不会抛；那这里 catch 谁？catch 的是**违反契约的回调**（比如你的 `convertToLlm` 抛了）。处理方式依然是错误即数据：

```typescript
// src/agent.ts · handleRunFailure，已裁剪
const failureMessage = { role: "assistant", content: [...], stopReason: aborted ? "aborted" : "error",
  errorMessage: String(error), ... };
await this.processEvents({ type: "message_start", message: failureMessage });
await this.processEvents({ type: "message_end", message: failureMessage });
await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
await this.processEvents({ type: "agent_end", messages: [failureMessage] });
```

上面代码手工补发了一整套正常的事件序列，让订阅者（UI、持久化）**用处理正常错误的同一条代码路径**处理这次崩溃。消费者永远不需要知道"事件序列断掉"这种状态存在。总之，Agent 类把"错误即数据"的防线又外推了一层：循环管厂商错误，Agent 管回调错误，出口统一。

## 6. 设计取舍

- **订阅者屏障 vs 旁观事件流**：await 每个订阅者换取顺序确定性，代价是吞吐和"慢订阅者劫持"。pi 在两层各给一个选项——要屏障用 `Agent`，要旁观用裸 `agentLoop` 的 EventStream——而不是做一个带开关的统一实现。
- **重复 prompt 抛错 vs 自动排队**：自动排队会掩盖调用方的时序 bug（两处代码互不知情地同时 prompt）。抛错 + 显式队列 API，让排队成为有名字的行为。
- **状态归约集中在一个 switch**：所有状态变更集中在 `processEvents` 一处，牺牲一点分派优雅度，换来"看一个函数就知道状态从哪来"。

## 动手实验

验证订阅者屏障：慢订阅者会推迟工具执行。

```typescript
// scratch-barrier.ts —— npx tsx scratch-barrier.ts
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("ping", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
]);

const agent = new Agent({ streamFn: models.streamSimple.bind(models) });
agent.state.model = faux.getModel();
agent.state.tools = [{
  name: "ping", label: "Ping", description: "ping",
  parameters: Type.Object({}),
  execute: async () => {
    console.log("B: 工具开始执行", Date.now() % 100000);
    return { content: [{ type: "text", text: "pong" }], details: {} };
  },
}];
agent.subscribe(async (ev) => {
  if (ev.type === "message_end" && (ev.message as any).role === "assistant") {
    console.log("A: message_end 订阅者开始睡 1s", Date.now() % 100000);
    await new Promise(r => setTimeout(r, 1000));
    console.log("A: 订阅者醒来", Date.now() % 100000);
  }
});
await agent.prompt("go");
```

预期：A 的两行日志**完整夹在** B 之前——工具执行等到订阅者睡完才开始。把 `Agent` 换成裸 `agentLoop`（事件走 EventStream 消费），同样的睡眠不再阻塞工具执行，这就是"屏障 vs 旁观"的差异。

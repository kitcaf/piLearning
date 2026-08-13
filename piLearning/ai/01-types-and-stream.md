# 第一章 · 1 统一类型系统与事件流协议

> 源码：`packages/ai/src/types.ts`（约 860 行）、`utils/event-stream.ts`（90 行）、`api/lazy.ts`（80 行）
> 位置：承接总览。本节是全包（乃至全项目）的地基——后面每一节、后面每一章的代码都在操作这里定义的类型。

## 1. 它解决什么问题

统一 30 家厂商，第一步不是写适配器，而是回答一个问题：**"一次对话"的通用数据模型是什么？** 这个模型必须同时满足：

- 表达力足够：文本、图片、思考（reasoning）、工具调用、用量统计都装得下
- 厂商中立：不偏向任何一家的字段命名
- 流式友好：既能表达"完整的消息"，也能表达"正在生成到一半的消息"

`types.ts` 就是这个答案。它没有任何逻辑，纯类型和注释，但值得作为本包的第一读——**所有适配器都是"厂商格式 → 这些类型"的翻译器**。

## 2. 消息模型：三种角色，五种停止原因

对话上下文（`Context`）由三部分组成：

```typescript
interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[]; // 其实可以注意到出现了Tools（调用过程的整个轨迹）
}

type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

上面代码中，`Message` 只有三种角色。注意**没有 `system` 角色的消息**——系统提示词是 Context 的独立字段，不混在消息列表里。这个选择让"替换系统提示词"不需要遍历消息数组。

三种消息里，`AssistantMessage` 信息量最大：

> LLM 的某次回复的最终回答的内容表示形式

```typescript
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];  // 有序内容块
  api: Api;                 // 这条消息是哪种协议产生的
  provider: ProviderId;     // 哪家厂商
  model: string;            // 哪个模型
  usage: Usage;             // token 用量 + 换算好的美元成本
  stopReason: StopReason;   // 为什么停：stop | length | toolUse | error | aborted
  errorMessage?: string;    // stopReason 为 error/aborted 时的原因
  timestamp: number;
}
```

上面代码有三个值得停下来的设计：

**(a) content 是内容块数组，不是字符串。** 一条回复可能是"先思考、再说话、再调工具"，块的顺序就是模型的输出顺序。厂商的花式输出（Anthropic 的 thinking 块、OpenAI 的 reasoning item）都归一到 `ThinkingContent`。

**(b) 消息自带来源标记（api/provider/model）。** 你可能会问：上下文里不是已经知道用什么模型了吗？关键在于**对话中途可以换模型**。历史消息记着自己出自谁之手，适配器回放历史时就能做针对性处理（比如把别家模型的 thinking 块降级为文本，因为签名无法跨厂商校验——第 3 节会看到这个用法）。

**(c) `stopReason` 把"错误"和"中止"作为一等公民。** 对比朴素设计——错误用异常表达、消息只有成功一种形态——pi 让一条消息可以**是**一个错误：

```typescript
{ role: "assistant", content: [], stopReason: "error",
  errorMessage: "429 rate limited", usage: {...} }
```

这就是总览里说的"错误即数据"在类型层的体现。错误消息和正常消息同构，于是可以进 transcript、可以被 UI 渲染、可以被重试逻辑检查（第 4 节），而不是在某个 catch 块里被消化掉。

`ToolResultMessage` 同理有 `isError: boolean`——工具失败也是数据，喂回给模型让它自我修正。

## 3. 事件协议：流式的通用语言

> 事件协议只是作用于一次llm调用（其实意味这消费者只要吃不同的llm返回的事件就可以了）最后其实消费完一个AssistantMessageEvent会得到的就是一次llm的回复。只是agent loop循环的一次。

有了静态的消息模型，还需要动态的**流式协议**。`AssistantMessageEvent` 是一个 12 种事件的可辨识联合（discriminated union）（只是为了流式ui显示的好，也可以直接使用AssistantMessage）：

> 回答"某次llm生成过程中"的一个个碎片事件，生成完最后的最终结果最后就成为了AssistantMessage 

```typescript
type AssistantMessageEvent =
  | { type: "start";          partial: AssistantMessage }
  | { type: "text_start";     contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta";     contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end";       contentIndex: number; content: string; partial: ... }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end";  /* 同构 */ ... }
  | { type: "toolcall_start" | "toolcall_delta" | "toolcall_end";  /* 同构 */ ... }
  | { type: "done";  reason: "stop" | "length" | "toolUse"; message: AssistantMessage }  // 表示某次llm吐出的内容结束了
  | { type: "error"; reason: "aborted" | "error";           error: AssistantMessage };
```

结构很规整：三类内容块（text/thinking/toolcall）各有 start/delta/end 三阶段，加上整体的 start 和两种终止。两个细节最有价值：

**每个事件都带 `partial`：完整的当前快照（就是包含了当前的完整信息）。** 朴素的流式协议只发增量（delta），消费者自己拼接。pi 的每个事件除了 delta 还附带**拼好的整条部分消息**。代价是对象引用多传一份；收益是消费者可以完全无状态——UI 每次拿 `partial` 重渲染即可，中途接入的消费者不会错过之前的内容。项目里 agent 循环正是靠这一点把 partial 直接放进上下文占位（第二章会看到）。

**终止事件携带最终消息，且 `error` 事件的载荷也是 AssistantMessage。** 流的最后一个事件（`done` 或 `error`）内嵌了完整的最终消息。错误不是一个 `Error` 对象，而是一条 `stopReason: "error"` 的消息——与第 2 节的类型设计首尾呼应。

总之，这 12 种事件就是 pi 全项目的"通用语言"：所有适配器的职责是把厂商流翻译成它，所有上层（agent 循环、TUI、RPC 模式）的职责是消费它。

## 4. EventStream：既是流，又是承诺

> 无论真实的厂商模型协议是什么？统一调用EventStream.push(llm的输出)。供后面的内容进行消费

事件用什么容器传递？`utils/event-stream.ts` 用 70 行实现了一个双面容器：

```typescript
class EventStream<T, R = T> implements AsyncIterable<T> {
  push(event: T): void { ... }      // 生产者：推事件
  end(result?: R): void { ... }     // 生产者：收尾
  [Symbol.asyncIterator]() { ... }  // 消费者：for await 逐事件
  result(): Promise<R> { ... }      // 消费者：只要最终结果
}
```

上面代码中，同一个对象向消费者提供两种消费方式：关心过程就 `for await`（做流式 UI），只关心结果就 `await stream.result()`（做批处理）。`complete()` 系列 API 就是一行实现的：

```typescript
async complete(model, context, options) {
  return this.stream(model, context, options).result();
}
```

构造时传入两个判断函数，容器自动识别终止事件并抽取最终值：

```typescript
class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",   // 何时算结束
      (event) => event.type === "done" ? event.message : event.error, // 从终止事件取结果
    );
  }
}
```

上面代码解释了为什么终止事件必须内嵌最终消息——`result()` 的值就是从流的最后一个事件里抽出来的。协议设计和容器设计是配套的。

内部实现是经典的"队列 + 等待者"模式：`push` 时有等待中的消费者就直接交付，没有就入队；消费者迭代时队列有货就取，没货就把自己挂进 `waiting` 数组。没有背压（LLM 输出速度有限，队列不会失控），换来实现极简。

## 5. lazyStream：同步返回流，异步做准备

现在有个时序矛盾：`stream()` 的签名要求**同步返回**一个流，但发请求前有一堆**异步**准备——解析认证、动态 import 协议模块。朴素方案是把签名改成 `Promise<Stream>`，但那会污染所有调用方。

`api/lazy.ts` 的 `lazyStream` 解决了它：

```typescript
function lazyStream(model, setup: () => Promise<AsyncIterable<...>>): AssistantMessageEventStream {
  const outer = new AssistantMessageEventStream();   // 立刻同步返回的"外壳流"
  setup()
    .then((inner) => forwardStream(outer, inner))    // 准备完成：内层流逐事件转发到外壳
    .catch((error) => {
      const message = createSetupErrorMessage(model, error);  // 准备失败：合成错误消息
      outer.push({ type: "error", reason: "error", error: message });
      outer.end(message);
    });
  return outer;
}
```

上面代码中，调用方立刻拿到 `outer` 开始 `for await`；真正的请求准备在背后进行，事件到达后被转发进来。最关键的是 catch 分支：**连"准备阶段"的失败（认证没配、模块加载失败）都被编码成流内的 error 事件**——"错误即数据"的契约从请求的第一毫秒就开始成立，调用方连 `stream()` 这一步都不需要 try/catch。

`lazyApi` 在同一个文件里，用 `lazyStream` 把"动态 import 协议模块"包装成即取即用的实现：

```typescript
function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
  return {
    stream: (model, context, options) =>
      lazyStream(model, async () => (await load()).stream(model, context, options)),
    ...
  };
}
```

上面代码就是总览里"启动不加载任何厂商 SDK"的实现全貌：provider 档案持有的 `api` 字段只是这个薄壳，`import("./anthropic-messages.ts")` 发生在第一次调用时，宿主的模块缓存保证只加载一次。

## 6. 设计取舍

- **每事件带 partial** 用少量内存换消费者零状态，在"消息最长几十 KB"的场景里是纯赚；若是高频小事件场景（如日志流）就不划算。
- **错误即数据**的代价是"忘了检查 stopReason"比"忘了 catch"更隐蔽——编译器不会提醒你。pi 用严格的 JSDoc 契约注释（`StreamFn` 的 Contract 段落）和上层的统一检查点弥补。
- **EventStream 无背压**是对 LLM 场景的合理假设，不是通用流方案。

总之，`types.ts` + `event-stream.ts` + `lazy.ts` 三个文件定义了一个闭环：统一的消息模型、统一的流式协议、以及让这个协议对失败也成立的包装器。后面所有代码都只是这个闭环的填充物。

## 动手实验

不需要 API key，用 faux provider 观察完整事件序列（在仓库根目录）：

```typescript
// scratch.ts —— npx tsx scratch.ts 运行
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("你好，世界")]);

const stream = models.streamSimple(faux.getModel(), {
  messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
});
for await (const ev of stream) console.log(ev.type, "delta" in ev ? JSON.stringify(ev.delta) : "");
console.log("final:", (await stream.result()).stopReason);
```

预期看到 `start → text_start → text_delta ×N → text_end → done`，最后 `stopReason` 为 `stop`。把 `setResponses` 换成 `fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })`，观察错误如何作为 `error` 事件流出而不是抛异常。

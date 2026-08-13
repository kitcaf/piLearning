# 第一章 · 0 packages/ai 总览：30+ 个厂商，一个接口

> 源码：`packages/ai/src/`，npm 包名 `@earendil-works/pi-ai`
> 位置：本章是整个教程的第一章。`pi-ai` 是所有上层包（agent、coding-agent）的地基，后续章节的一切都建立在本章的类型和抽象之上。

## 1. 它解决什么问题

假设你要写一个 agent，直接对接厂商 API。先接 OpenAI，再接 Anthropic，你会立刻发现两家几乎没有一处相同：请求体结构不同、流式协议不同（SSE 事件名都不一样）、工具调用的编码不同、思考模式的参数不同、缓存标记的方式不同、认证方式不同。

朴素方案是在业务代码里写 if/else：

```typescript
if (provider === "openai") { /* 构造 OpenAI 请求，解析 OpenAI 流 */ }
else if (provider === "anthropic") { /* 另一套 */ }
```

两家还能忍。但 pi 支持 30 多家厂商——Groq、DeepSeek、xAI、OpenRouter、Bedrock、Copilot……if/else 会把 agent 逻辑彻底淹没，而且每加一家厂商都要动 agent 核心代码。

`pi-ai` 的答案：**上层永远只面对同一组类型和同一个调用方式，所有差异压到底层适配器里**。上层代码长这样，且永远长这样：

```typescript
const stream = models.streamSimple(model, context, { reasoning: "high" });
for await (const event of stream) { /* 统一的事件类型 */ }
```

上面代码中，`model` 换成任何厂商的任何模型，这两行都不用改。本章讲清这件事是怎么做到的。

## 2. 读懂本包的钥匙：Api ≠ Provider

打开 `src/` 目录会看到两个平行的世界：

```
src/api/          10 个文件，每个是一种"线协议"的实现
src/providers/    30+ 个文件，每个是一家厂商的"档案"
```

这两个概念的区分是整个包的设计核心：

- **Api（协议）**：请求和响应的**格式**。如 `anthropic-messages`、`openai-completions`、`openai-responses`、`google-generative-ai`。
- **Provider（厂商）**：一个**服务商**的档案：id、baseUrl、认证方式、模型清单，以及"我的模型说哪种协议"。

关键事实：**协议数量远小于厂商数量**。Groq、Cerebras、DeepSeek、xAI 等几十家厂商都兼容 OpenAI 的 completions 协议——它们不需要各自的协议实现，只需要一份薄薄的档案。看真实的 provider 定义有多薄：

```typescript
// src/providers/anthropic.ts —— 完整文件去掉认证细节后就这么多
export function anthropicProvider(): Provider<"anthropic-messages"> {
  return createProvider({
    id: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: { apiKey: anthropicApiKeyAuth(), oauth: lazyOAuth({ ... }) },
    models: Object.values(ANTHROPIC_MODELS),   // 生成的模型目录
    api: anthropicMessagesApi(),               // 协议实现（懒加载引用）
  });
}
```

上面代码中，provider 只是把"档案信息"和一个协议实现的引用装配在一起，自己不含任何请求逻辑。新接一家 OpenAI 兼容厂商，只需要写这么一个 50 行的档案文件。

你可能会问：同说 openai-completions 协议的厂商之间也有细微差异（比如有的不支持 `reasoning_effort` 字段），怎么办？pi 的选择是**不为差异新建协议，而是用数据描述差异**——每个模型可以携带一组 `compat` 标志，协议实现根据标志调整行为。这是第 3 节的主题。

## 3. 分层全景

四层，每层职责一句话：

```
   调用方（agent 包）
        │ streamSimple(model, context, options)
        ▼
┌─ Models（models.ts）─────────────────────────┐
│ 厂商注册表 + 认证解析 + 请求分发              │ ← "用哪个 key、调谁"
└──────────────┬────────────────────────────────┘
               ▼
┌─ Provider（createProvider 构建）──────────────┐
│ 模型目录（静态+动态）+ 按 model.api 分发      │ ← "有哪些模型"
└──────────────┬────────────────────────────────┘
               ▼
┌─ Api 实现（api/*.ts）─────────────────────────┐
│ 构造 payload → HTTP/SSE → 解析厂商事件        │ ← "怎么说这门协议"
│ → 翻译成统一事件                              │
└──────────────┬────────────────────────────────┘
               ▼
   AssistantMessageEventStream（统一事件流）      ← 所有路径的终点
```

注意最底下一行：**无论走哪家厂商哪种协议，出口永远是同一个 `AssistantMessageEventStream`**。这个流的事件协议（第 1 节）是整个 pi 项目的通用语言——agent 包消费它，UI 渲染它，会话持久化存它的最终产物。

> 配套图：[architecture.drawio](architecture.drawio)（用 draw.io 打开，含分层与请求路径）。

## 4. 两个贯穿全包的设计决策

正文展开前，先点出两个反复出现的决策，读后面各节时留意验证：

**决策一：错误即数据（errors as data）。** 一次 LLM 调用可能失败在几十种地方：网络断开、认证过期、限流、上下文溢出。pi 规定：**一旦返回了流，就不允许再 throw**。所有失败都编码为流内的一个 `error` 事件 + 一条 `stopReason: "error"` 的普通 assistant 消息。上层循环因此不需要 try/catch，错误和正常回复走同一条管道。这个契约的完整含义在第 1 节和第 4 节展开。

**决策二：一切懒加载、副作用自由。** 看 `index.ts` 顶部的注释：

> Core only, side-effect free: no generated catalogs, no provider factories, no api-registry, no OAuth implementations.

主入口只导出类型和纯工具；具体厂商要显式 `import "@earendil-works/pi-ai/providers/anthropic"`；协议实现在**第一次真正发请求时**才动态 import（每个 `api/*.ts` 配一个 `*.lazy.ts` 薄壳）。效果：CLI 启动不加载 30 家厂商的 SDK，浏览器打包不会带上用不到的依赖。实现机制（`lazyStream`）在第 1 节讲。

## 5. 模型元数据从哪来

`Model` 对象携带价格、上下文窗口、能力开关等纯数据。这些数据不是手写的：

- `scripts/generate-models.ts` 从社区模型数据库 **models.dev** 拉取 → 生成 `models.generated.ts` 和 `providers/data/*.json`
- 生成脚本里保留人工修正层（models.dev 报价错误的模型在脚本里硬编码更正）
- 规矩：**不改生成文件，改生成脚本再重新生成**

这解释了一个新手必踩的坑：clone 仓库后直接运行会报"找不到 `providers/data/amazon-bedrock.json`"——数据文件是构建产物，被 .gitignore 排除，需要先 `npm run hydrate:model-data`（或从已发布的 npm 包提取）。

## 本章路线

| 节 | 内容 | 对应源码 |
|---|------|---------|
| 1 | 统一类型系统与事件流协议 | `types.ts`、`utils/event-stream.ts`、`api/lazy.ts` |
| 2 | Models / Provider / 认证解析 | `models.ts`、`auth/` |
| 3 | 协议适配器与 compat | `api/anthropic-messages.ts`、`api/simple-options.ts` |
| 4 | 重试、溢出检测、faux 测试 | `utils/retry.ts`、`utils/overflow.ts`、`providers/faux.ts` |

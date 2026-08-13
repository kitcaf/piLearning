# 第二章 · 3 Harness 与会话：把对话变成一棵可回退的树

> 源码：`packages/agent/src/harness/agent-harness.ts`（约 1200 行）、`harness/session/session.ts`、`harness/session/jsonl-storage.ts`
> 位置：承接第 1、2 节的循环内核。本节是装配层——第四章 coding-agent 的 `AgentSession` 有一套同源的自有实现（`core/session-manager.ts`），会话树、entry、钩子等概念与这里完全一致，先在这里把地基打牢。

## 1. 它解决什么问题

Agent 类管好了"一次运行"，但一个产品级 agent 还差三样：

- **持久化**：进程退出后对话要能恢复；用户要能回退到第 5 轮重新问（还不能丢掉原来的第 6~10 轮）。
- **系统提示词不是常量**：它由基础指令 + 技能清单 + 工作目录等动态拼出，且每轮可能变。
- **可扩展**：外部代码要能拦截工具调用、改写上下文、观察 provider 请求——但不能 fork 框架。

`AgentHarness` 把这三样加在循环之上。注意一个结构事实：**harness 没有复用 Agent 类**，而是直接调用 `runAgentLoop` 并自己实现事件处理。因为 Agent 类的核心资产——内存里的 `state.messages`——在 harness 里是错误的真相来源：**harness 的真相在会话文件里**，内存状态每轮从文件重建。两层对"状态放哪"的回答不同，共享循环、不共享封装。

## 2. 会话模型：追加日志 + 树

会话（session）的存储模型一句话：**一个只追加（append-only）的日志，每条记录用 `parentId` 指向逻辑上的前一条，从而构成一棵树**。

```
日志（写入顺序）              树（parentId 视角）
──────────────               ────────────────
e1: user "写个爬虫"            e1 ── e2 ── e3 ── e4
e2: assistant + toolCall              │
e3: toolResult                        └── e5 ── e6      ← 用户从 e2 回退后新分支
e4: assistant "写完了"
e5: user "换个思路"(parent=e2)
e6: assistant ...
leaf → e6                     leaf 指针决定"当前对话"是哪条路径
```

上面的图中，回退（用户想从第 2 轮重来）不删除任何记录——只是把 `leaf` 指针移到 e2，新消息以 e2 为 parent 追加。旧分支 e3–e4 完好保留，随时可以再切回去。**追加日志天然免疫崩溃**（任何前缀都是合法状态），树结构天然支持分支，两者用一个 `parentId` 字段同时拿到。

日志里的记录（entry）不只有消息。看 `Session` 类提供的追加方法就知道有哪些类型：

```typescript
// src/harness/session/session.ts 的方法清单（节选）
appendMessage(message)                    // 一条 AgentMessage
appendModelChange(provider, modelId)      // 用户换了模型
appendThinkingLevelChange(level)          // 换了思考等级
appendActiveToolsChange(names)            // 改了启用工具集
appendCompaction(summary, firstKeptEntryId, ...)  // 一次压缩（第 4 节）
appendCustomEntry / appendCustomMessageEntry      // 扩展的私货
appendLabel(targetId, label)              // 给某条 entry 打标签
moveTo(entryId, summary?)                 // 移动 leaf = 回退/切分支
```

上面代码中，"用户换了模型"这类**配置变更也是树上的一条 entry**。为什么不放进独立的配置文件？因为配置是有位置的：回退到 e2 就该回到当时的模型。恢复会话时沿路径重放一遍 entry，模型、思考等级、工具集自然还原到那个时间点（`deriveSessionContextState` 干的就是这个）。

从树到 LLM 上下文的转换由 `buildSessionContext` 完成：取 leaf 到根的路径 → 应用压缩变换（有 compaction entry 时丢弃被摘要的前缀，详见第 4 节）→ 逐条 entry 投影成消息。自定义 entry 默认投影成**空**——扩展写进树里的东西不会意外进入模型上下文，除非注册了投影器（projector）。

## 3. 每轮重建：turnState

harness 最与直觉相反的设计：**不缓存对话状态，每轮从会话重新构建**。

```typescript
// src/harness/agent-harness.ts · createTurnState，已裁剪
private async createTurnState(): Promise<AgentHarnessTurnState<...>> {
  const context = await this.session.buildContext();   // 每次都从树重建消息
  const resources = this.getResources();
  let systemPrompt = "You are a helpful assistant.";
  if (typeof this.systemPrompt === "string") {
    systemPrompt = this.systemPrompt;
  } else if (this.systemPrompt) {
    systemPrompt = await this.systemPrompt({ session, model, activeTools, resources, ... });
  }
  return { messages: context.messages, systemPrompt, model: this.model,
           tools, activeTools, toolContext, streamOptions, ... };
}
```

上面代码中有两个点：**(a)** `messages` 每轮都是 `session.buildContext()` 的新产物，会话文件是唯一真相；**(b)** `systemPrompt` 可以是一个**函数**，每轮重新求值——技能列表变了、工作目录变了，下一轮提示词自动跟上。

重建的触发点在循环的 `prepareNextTurn` 回调（第 1 节埋的钩子在这里兑现）：

```typescript
// src/harness/agent-harness.ts · createLoopConfig，已裁剪
prepareNextTurn: async () => {
  await this.flushPendingSessionWrites();      // 先落盘积压的写入
  const nextTurnState = await this.createTurnState();
  setTurnState(nextTurnState);
  return { context: this.createContext(nextTurnState),
           model: nextTurnState.model, thinkingLevel: nextTurnState.thinkingLevel };
},
```

上面代码中，每个轮边界 harness 都重建一次全套状态并**替换**循环正在用的 context。你可能会问：每轮全量重建不慢吗？会话就几百条 entry，内存操作微秒级；相比一次 LLM 调用的秒级延迟，这个成本是零。换来的是永不失同步——不存在"内存和文件不一致"这类 bug。

## 4. 持久化时机与延迟写入

事件到状态的管道被 harness 换成了"事件到磁盘"：

```typescript
// src/harness/agent-harness.ts · handleAgentEvent，已裁剪
if (event.type === "message_end") {
  await this.session.appendMessage(event.message);   // 定稿即落盘
  await this.emitAny(event, signal);
  return;
}
if (event.type === "turn_end") {
  await this.emitAny(event, signal);
  await this.flushPendingSessionWrites();            // 轮边界统一刷积压
  await this.emitOwn({ type: "save_point", hadPendingMutations });
  return;
}
```

上面代码中，消息在 `message_end` 立刻追加进会话——崩溃最多丢一条没打完的消息。而"积压的写入"（`pendingSessionWrites`）是另一类东西：agent 正在跑的时候，外部调了 `setModel()` 或扩展要 `appendMessage()`，这些写入**不能立刻落盘**——立刻写就等于把一条 entry 插进"assistant 的 toolCall 和它的 toolResult 之间"，既破坏协议配对，也会把厂商的 KV 缓存前缀作废（provider 按前缀匹配缓存，中间插一条，从那一点起全部缓存失效，token 费翻倍）。所以它们排队到轮边界统一追加。**又是轮边界**——第 1 节的插话、本节的延迟写入，所有"想在对话中间塞东西"的需求都被引导到同一个安全点。

JSONL 后端把这套模型实现得极其直白（`jsonl-storage.ts`）：文件第一行是 header（version、id、cwd），之后一行一条 entry，追加即持久化。entry 的 id 用 uuidv7 的**末 8 位**——uuidv7 前缀是时间戳，同一毫秒内几乎不变，短 id 必须取随机尾部，撞了就重试。另有内存后端（`memory-storage.ts`）供测试，SQLite 后端在独立的包里。

## 5. 钩子与事件：扩展的接口面

harness 把循环的回调翻译成对外的**钩子**（hook，可修改行为）和**事件**（event，只能旁观）。对应关系一张表：

| 循环回调 | harness 钩子 | 能干什么 |
|---|---|---|
| `transformContext` | `context` | 每次 LLM 调用前改写消息数组 |
| `beforeToolCall` | `tool_call` | 阻止工具执行（`{ block, reason }`） |
| `afterToolCall` | `tool_result` | 改写工具结果 |
| （streamFn 内部） | `before_provider_request` | 改 headers/timeout/重试参数 |

第四章会看到，coding-agent 的整个扩展系统（权限确认、plan mode、子 agent）就是往这几个钩子上挂东西。harness 层只负责把拦截点标准化。

## 6. 技能与提示词模板：两种"外置知识"

harness 管理两类资源（resources），都从磁盘上的 markdown 加载：

- **技能（skill）**：一个带 frontmatter 的 `SKILL.md`。系统提示词里只放**名字 + 描述 + 文件路径**，模型觉得任务匹配时自己用 read 工具去读全文。看 `formatSkillsForSystemPrompt` 生成的格式：

```
The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.

<available_skills>
  <skill>
    <name>pdf-tools</name>
    <description>Extract text and tables from PDF files...</description>
    <location>/path/to/skills/pdf-tools/SKILL.md</location>
  </skill>
</available_skills>
```

上面的格式是"渐进式披露"（progressive disclosure）：一百个技能只占系统提示词几百 token，全文按需加载。对比朴素方案（把所有技能全文塞进系统提示词）——上下文瞬间爆炸，而且绝大多数技能与当前任务无关。

- **提示词模板（prompt template）**：用户侧的宏。`promptFromTemplate("review", args)` 把模板展开成一条普通 user 消息发出。它扩展的是**用户输入**，技能扩展的是**模型能力**，方向相反。

两者都只是数据，不含代码——与第四章的扩展（extension，真正的 TypeScript 代码）形成能力阶梯。

## 7. 设计取舍

- **文件即真相 vs 内存即真相**：每轮从文件重建，harness 永不失同步，代价是 harness 的 API 几乎全是 async（每个 getter 背后可能有 IO）。Agent 类相反：同步 API、内存真相、不管持久化。两层各占一端，应用按需选。
- **树 vs 线性历史 + 快照**：线性历史加"回退=截断"最简单，但用户回退后原分支就没了。树的代价是所有读路径都要沿 parentId 爬一遍，pi 认为保留探索历史值得这个复杂度——coding agent 的用户经常想"试试另一条路，不行再回来"。
- **配置变更入树 vs 独立配置**：换模型记成 entry，恢复和回退语义自动正确；代价是"当前模型是什么"要扫路径推导。用推导换一致性。

总之，harness 的本质是一次真相来源的搬家：从内存搬到追加日志。搬家之后，崩溃恢复、历史回退、多分支这些难题全部退化为"移动一个 leaf 指针"。

## 延伸阅读：durable harness 设计文档

`packages/agent/docs/harness.md`（130KB）是 harness 下一代形态的完整设计文档，本身就是一份优秀的可靠性设计教材。若本节内容已消化，推荐精读它的前五章，重点看三个本节只有雏形的概念的形式化：

- **意图-结果日志**（durability rule）："效果发生前先追加一条意图 entry，效果完成后追加结果 entry"——任何日志前缀都是合法状态，崩溃恢复按"意图有没有配对结果"逐个决策。这是把本节"追加即持久化"推向"任意时刻崩溃都可恢复"的关键一步。
- **checkpoint 与 deferred write 的形式化**：本节第 4 节的"轮边界统一刷积压"在那里被提升为一等概念（步与检查点交替的状态机），并明确了 append-only context 不变式与厂商 KV 缓存的成本关系。
- **队列 vs 延迟写入的不同生死契约**：插话在 abort 时应该死（返还给客户端重排），而配置变更必须活——两类"中途写入"的差异被写成明确的契约表。

读法建议：把它当"第二章的习题答案"读——先自己想"如果要让 harness 崩溃后精确恢复，现有实现缺什么"，再对照文档验证。

## 动手实验

不需要模型，直接操作会话树观察分支行为：

```typescript
// scratch-session.ts —— npx tsx scratch-session.ts
import { Session, InMemorySessionStorage } from "@earendil-works/pi-agent-core";

const session = new Session(new InMemorySessionStorage());
const u1 = await session.appendMessage({ role: "user", content: "方案A", timestamp: Date.now() });
const a1 = await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "A做完了" }],
  api: "x", provider: "x", model: "x", stopReason: "stop", timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
           cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);

await session.moveTo(u1);                              // 回退到用户消息
await session.appendMessage({ role: "user", content: "改用方案B", timestamp: Date.now() });

console.log("当前分支:", (await session.buildContext()).messages.length, "条");  // 2 条：方案A + 方案B
console.log("全部 entry:", (await session.getEntries()).length, "条");           // 3 条：旧分支还在
```

预期：当前上下文只有 2 条消息（u1 和新消息），但树里 3 条 entry 都在——a1 没有被删除，把 leaf `moveTo(a1)` 就能整条切回去。

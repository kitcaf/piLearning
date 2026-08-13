# 第四章 · 1 AgentSession：产品的心脏

> 源码：`packages/coding-agent/src/core/agent-session.ts`（约 3000 行）、`core/agent-session-runtime.ts`、`core/session-manager.ts`
> 位置：承接总览的装配图。所有模式共享的那个核心对象就是本节主角。第 3 节的扩展系统的所有钩子都从这里出发。

## 1. 它解决什么问题

第二章的 `Agent` 类管好了"一次运行"，但离产品还差一整层：事件要**同时**喂给扩展、UI 和会话文件，谁先谁后？上下文满了谁负责压缩？请求 429 了谁负责重试？模型换了 API key 从哪来？`AgentSession` 就是这层的名字。文件头的注释列得很直白：

> Agent state access / Event subscription with automatic session persistence / Model and thinking level management / Compaction (manual and auto) / Bash execution / Session switching and branching

3000 行听起来吓人，但骨架只有三根：**一个事件处理器、一组钩子安装、两个自动化策略（压缩与重试）**。本节按这三根骨架讲。

## 2. 事件枢纽：一个处理器，三路分发

`AgentSession` 构造时向 Agent 订阅唯一一个处理器 `_handleAgentEvent`，所有事件在这里排好队再分发：

```typescript
// src/core/agent-session.ts · _handleAgentEvent，已裁剪
private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
  if (event.type === "message_start" && event.message.role === "user") {
    /* 从 steering/followUp 展示队列里摘掉这条，先发 queue_update 给 UI */
  }
  await this._emitExtensionEvent(event);        // ① 扩展最先看到
  this._emit(event);                            // ② 再通知 UI 等监听者
  if (event.type === "message_end") {           // ③ 最后持久化
    this.sessionManager.appendMessage(event.message);
    if (event.message.role === "assistant") this._lastAssistantMessage = event.message;
  }
};
```

上面代码中，顺序是有讲究的：**扩展在 UI 之前**——扩展可能改写消息（`message_end` 钩子允许替换消息内容），UI 必须看到改写后的版本；**持久化在最后**——落盘的也是改写后的版本。三路消费一个入口，顺序就是契约。

还记得第二章第 2 节的"订阅者屏障"吗？这里就是那个屏障的受益者：`_handleAgentEvent` 是 async 且被 Agent await，所以"扩展处理完、会话写完"保证发生在循环走向下一步之前。coding-agent 的持久化一致性全部吊在那个设计上。

## 3. 钩子安装：把循环的口子接给扩展

第二章循环的 `beforeToolCall` / `afterToolCall` 插槽，在这里被接到扩展系统：

```typescript
// src/core/agent-session.ts · _installAgentToolHooks，已裁剪
this.agent.beforeToolCall = async ({ toolCall, args }) => {
  const runner = this._extensionRunner;          // 每次执行时现取，支持热重载
  if (!runner.hasHandlers("tool_call")) return undefined;
  return await runner.emitToolCall({ type: "tool_call",
    toolName: toolCall.name, toolCallId: toolCall.id, input: args });
};
```

上面代码中，`runner` 在**回调执行时**才从字段读取，而不是安装时捕获——`/reload` 换掉 runner 后钩子自动生效，不需要重装。`hasHandlers` 先行短路：没有扩展监听时零开销。

另一个钩子 `prepareNextTurnWithContext`（第二章循环的轮边界回调）被用来做**每轮刷新**：

```typescript
// src/core/agent-session.ts · _installAgentNextTurnRefresh，已裁剪
this.agent.prepareNextTurnWithContext = async (turn, signal) => ({
  context: { ...turn.context,
    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
    tools: this.agent.state.tools.slice() },
  model: this.agent.state.model,
  thinkingLevel: this.agent.state.thinkingLevel,
});
```

上面代码让"运行中途换模型/换工具/扩展改系统提示词"在下一轮生效——与第二章 harness 的 `createTurnState` 思路完全一致（每轮重建），只是重建的来源从会话文件换成了 `agent.state`。

## 4. 自动压缩：两个触发器

第二章第 4 节说过：agent 包只提供 `shouldCompact` 机制，策略在这里。`agent_end` 后 AgentSession 检查是否需要压缩，有两条完全不同的触发路径：

**路径一：阈值（threshold）。** 正常情况。取最后一条 assistant 消息的 usage 算上下文 token，超过 `contextWindow - reserveTokens` 就压。有个细节处理了"错误消息没有 usage"的情况——回退到 `estimateContextTokens` 估算，且要验证估算依据的 usage 来自**压缩之后**的消息：

```typescript
// src/core/agent-session.ts，已裁剪
// Kept pre-compaction messages have stale usage reflecting the old (larger)
// context and would falsely trigger compaction right after one just finished.
if (compactionEntry && usageMsg.timestamp <= new Date(compactionEntry.timestamp).getTime()) {
  return false;
}
```

上面代码防的坑很隐蔽：压缩保留的"最近消息"里有旧的 assistant usage，它记录的是压缩**前**的大上下文——拿它判断会得出"刚压完又要压"的死循环。时间戳比对一行救命。

**路径二：溢出（overflow）。** 请求已经被厂商以"上下文超限"拒绝（`isContextOverflow` 识别错误消息）。此时的动作是**压缩后自动重试**：把报错的 assistant 消息从上下文中摘掉（但保留在会话文件里，历史不撒谎）、压缩、重发。`_overflowRecoveryAttempted` 标志保证只救一次——第二次溢出就放弃并明确报错，防止无限循环烧钱。

你可能会问：有阈值预防，为什么还会溢出？因为阈值基于估算（字符 ÷4），而某些内容（大量代码、非英语文本）的真实 token 密度更高；另外用户可以手动关掉自动压缩。溢出路径是估算失准时的兜底。**预防 + 兜底双保险，各自独立成立**。

## 5. 自动重试：错误消息的下游消费者

第一章"错误即数据"的最后一环在这里兑现。`agent_end` 时检查最后一条 assistant 消息：

```typescript
// src/core/agent-session.ts · _willRetryAfterAgentEnd，已裁剪
const settings = this.settingsManager.getRetrySettings();
if (!settings.enabled || this._retryAttempt >= settings.maxRetries) return false;
for (let i = event.messages.length - 1; i >= 0; i--) {
  const message = event.messages[i];
  if (message.role === "assistant")
    return this._isRetryableError(message as AssistantMessage);
}
```

上面代码中，重试逻辑的输入不是异常对象，而是 transcript 里的消息——检查 `stopReason` 和 `errorMessage`（429、5xx、网络断开是可重试的；401、参数错误不是）。重试用 `agent.continue()` 发起（第二章讲过：从"最后一条是 user/toolResult"的状态续跑），指数退避，成功一次就清零计数。UI 通过 `auto_retry_start/end` 事件显示倒计时。整条链路没有一个 try/catch 参与决策。

## 6. 会话管理：与 harness 同构的树

`SessionManager` 是第二章 harness 会话树的姊妹实现，概念逐一对应：JSONL 追加日志、`parentId` 树、leaf 指针、compaction/branch_summary entry、`getBranch()` 取当前路径。coding-agent 在其上暴露的产品操作：

- `/tree` 导航（`navigateTree`）：移动 leaf + 可选分支摘要（第二章第 4 节的机制）
- `/fork`：以某 entry 为起点复制出**新会话文件**（跨文件分支，parentSession 字段记血缘）
- 会话恢复：启动时 `sessionManager` 读文件重放出 `messages`，直接赋给 `agent.state.messages`（总览第 2 节代码的最后一段）

会话文件格式见 `docs/session-format.md`；每个会话一个 JSONL 文件，存于 `~/.pi/agent/sessions/<cwd-hash>/`，按工作目录分组。

## 7. 设计取舍

- **一个事件处理器 vs 多点订阅**：扩展、UI、持久化各自订阅 Agent 会让顺序不可控（谁先看到 message_end？）。单点排序把顺序变成代码里可读的三行。
- **压缩后重试只救一次**：可以设计成"压到能装下为止"的循环，但每次压缩都要一次 LLM 调用，失控循环的代价是真金白银。一次不行就交还给人。
- **重试基于消息而非异常**：好处是重试决策可测试（构造一条消息即可）、可持久化（崩溃后仍知道重试到第几次）；代价是所有错误信息都要挤进 `errorMessage` 字符串，结构化信息（HTTP 状态码）靠解析文本恢复——`isRetryableAssistantError` 里确实有一堆字符串匹配。

总之，AgentSession 是把三章的库黏成产品的胶水层，而它自己几乎没有发明新机制——事件顺序靠第二章的屏障，压缩靠第二章的机制加本地策略，重试靠第一章的错误即数据。**好的分层让最上层最无聊**。

## 动手实验

观察自动重试链路（不用真触发 429）。`packages/coding-agent/test/suite/` 里有现成的行为规格：

```powershell
cd packages\coding-agent
npx vitest run test/suite/agent-session-retry-events.test.ts
```

预期：测试构造 `stopReason: "error"` + 可重试 errorMessage 的 faux 响应，断言 `auto_retry_start` 事件发出、重试后成功、`_retryAttempt` 清零。读这个测试文件比读源码更快理解重试状态机——测试是行为的规格书。

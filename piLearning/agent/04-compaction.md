# 第二章 · 4 压缩：上下文满了之后的生存术

> 源码：`packages/agent/src/harness/compaction/compaction.ts`（约 900 行）、`compaction/branch-summarization.ts`、`compaction/utils.ts`
> 位置：本章最后一节，建立在第 3 节的会话树之上。coding-agent 在 `core/compaction/` 有一份策略微调过的姊妹实现（第四章），机制核心都在这里。

## 1. 它解决什么问题

agent 干活久了，上下文必然超过模型窗口。到那一刻只有三个选项：报错停机、静默丢弃老消息、或者**压缩（compaction）**——用一段 LLM 生成的摘要替换老历史，保留最近的消息原文。

朴素方案是"丢最老的一半"。问题在于 coding agent 的老消息里埋着关键事实：用户最开始的需求、已经改过哪些文件、踩过什么坑。丢了这些，agent 会重复劳动甚至反向操作。pi 的方案：**摘要换空间，且摘要是结构化的、可增量更新的、带文件清单的**。本节把这三个修饰语逐个展开。

先看数据模型。压缩在会话树上就是一条 entry：

```typescript
// compaction entry 的关键字段
{
  type: "compaction",
  summary: string,            // LLM 生成的摘要
  firstKeptEntryId: string,   // 从哪条 entry 起保留原文
  tokensBefore: number,       // 压缩前的估算 token 数
  details: { readFiles, modifiedFiles },   // 文件操作清单
}
```

上面代码中，压缩不删除任何历史——第 3 节说过日志只追加。构建上下文时，`defaultContextEntryTransform` 找到路径上最后一条 compaction entry，输出"摘要消息 + firstKeptEntryId 之后的原文"，被摘要的前缀只是**不再投影**进上下文。想看完整历史，树上都在。

## 2. 什么时候压：一行阈值判断

```typescript
// src/harness/compaction/compaction.ts
export function shouldCompact(contextTokens, contextWindow, settings): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;   // 默认 reserve 16384
}
```

上面代码中，触发线不是"窗口满"而是"窗口减去保留区"。`reserveTokens`（默认 16K）留给两样东西：下一次请求的输出空间、以及压缩摘要本身的生成空间——**等真满了才压就来不及了**，因为压缩自己也要调一次 LLM。

`contextTokens` 从哪来？精确 token 数只有厂商知道，pi 用两级估算（`estimateContextTokens`）：找最近一条成功 assistant 消息的 `usage`（厂商报告的精确值，覆盖它之前的全部上下文），再对它之后的消息用启发式补齐——**字符数 ÷ 4，图片按 4800 字符计**（`estimateTokens`）。你可能会问：÷4 不准怎么办？不需要准。这个数字只喂给阈值判断，16K 的保留区足够吸收估算误差；用便宜的近似换掉一次真正的 tokenizer 调用，是清醒的工程决定。

注意：`agent` 包只提供 `shouldCompact` 这个**机制**，真正周期性调用它做决策的是 coding-agent 的 `AgentSession`（策略）。机制与策略分离，本包的 harness 只提供手动 `compact()`。

## 3. 从哪切：合法切点

压缩要选一个"从这条 entry 起保留原文"的切点（cut point）。不能随便切：

```typescript
// src/harness/compaction/compaction.ts · findValidCutPoints，已裁剪
case "message": {
  switch (entry.message.role) {
    case "user": case "assistant": /* ... */
      cutPoints.push(i); break;
    case "toolResult":
      break;                      // toolResult 不能当切点
  }
}
```

上面代码中，`toolResult` 被排除在合法切点之外。原因还是那条协议：toolResult 必须紧跟它配对的 assistant toolCall；从 toolResult 切开，保留区开头就是一条没有前因的工具结果，厂商 API 直接拒收。

选点算法（`findCutPoint`）从最新消息倒着累加估算 token，攒够 `keepRecentTokens`（默认 20K）后取最近的合法切点。还有一个边界情况处理得很细：如果切点落在一个超长轮次的中间（一条 user 消息引发了 50 次工具调用，轮次本身就超过 20K），`findTurnStartIndex` 会识别出**切开了一个轮次**（split turn），对轮次的前半段单独生成一份"轮次前缀摘要"拼进主摘要——保证保留区开头的工具结果链有上下文可依。

## 4. 怎么摘要：结构化 + 增量

摘要不是"帮我总结一下"。看 `SUMMARIZATION_PROMPT` 强制的输出结构（裁剪）：

```
## Goal            —— 用户到底想干什么
## Constraints & Preferences
## Progress
### Done / ### In Progress / ### Blocked
## Key Decisions   —— 决策 + 理由
## Next Steps
## Critical Context
```

上面的结构是给**下一个 LLM** 看的交接文档，不是给人看的读后感。栏目设计全部对准"继续干活需要什么"：目标防跑偏、Done 防重复劳动、Key Decisions 防反向操作。提示词末尾还有一句点睛的约束：*Preserve exact file paths, function names, and error messages*——摘要最容易丢的就是这些精确字符串，而它们恰恰是 agent 最需要的。

第二次压缩时用的是另一个提示词（`UPDATE_SUMMARIZATION_PROMPT`）：把**上一份摘要 + 新增消息**交给模型做增量更新（保留旧信息、把 In Progress 挪到 Done）。对比朴素方案——每次都对全量历史重新摘要——增量更新既省 token，又避免"摘要的摘要"式信息衰减：第一份摘要里的事实被逐字继承，而不是被再压缩一遍。

另外两个实现细节值得记：摘要请求用 `cacheRetention: "none"` 和随机 sessionId 隔离（一次性请求，写缓存纯浪费）；输出上限设为 `0.8 × reserveTokens`，摘要自己不许吃光保留区。

## 5. 文件清单：摘要之外的硬数据

`prepareCompaction` 会从被压缩的消息里抽取所有 read/write/edit 工具调用的路径，存进 compaction entry 的 `details`：

```typescript
export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

上面代码中的两个清单在下次压缩时被**机械合并**（上一条 compaction 的 details 并入新的），不经过 LLM。为什么不让摘要顺带写？因为文件清单是可以**精确计算**的数据，交给 LLM 摘要就变成"可能被遗漏"的数据。能算的不猜——LLM 只负责压缩那些真正需要理解才能压缩的内容。

## 6. 分支摘要：切换分支时的同款手艺

第 3 节讲过 `session.moveTo()` 回退分支。回退时被离开的分支上可能有有价值的探索（"试了方案 A，因为 X 失败了"），直接扔掉可惜。`branch-summarization.ts` 用同一套摘要机制处理这个场景：

- `collectEntriesForBranchSummary`：找旧 leaf 与目标 entry 的**最近公共祖先**，收集旧分支上公共祖先之后的 entry；
- `generateBranchSummary`：LLM 摘要成一段"这条路试过什么、为什么放弃"；
- `session.moveTo(target, summary)`：摘要作为 `branch_summary` entry 挂在新位置。

效果：新分支的上下文开头有一条"前情提要"，模型不会把失败的方案再试一遍。压缩和分支摘要共用 `serializeConversation`、重试、文件清单等基础设施——**同一个问题（历史太长/不在场）的两个变体，一套机制**。

## 7. 设计取舍

- **摘要 vs 截断**：截断零成本但丢信息；摘要花一次 LLM 调用（用的还是当前主力模型）。pi 全线选摘要，且用结构化提示词把这次调用的价值榨满。
- **估算 vs 精确计数**：字符 ÷4 的误差由 16K 保留区兜底。引入 tokenizer 依赖（每个厂商还不一样）换 5% 的精度，不划算。
- **不删历史 vs 真删**：压缩后旧 entry 仍在文件里，会话文件只增不减。代价是磁盘（文本，可忽略），收益是任何压缩都可回溯审计——摘要错了还能找回原文。

总之，压缩是 pi 里"用 LLM 管理 LLM"的最典型样本：阈值和切点用确定性代码算，语义压缩交给模型，可精确计算的（文件清单）绝不过模型之手。三种手段各司其职。

## 动手实验

不调用模型，单独验证切点算法对 toolResult 的规避。`packages/agent/test/harness/compaction.test.ts` 有现成的覆盖，跑最相关的一组：

```powershell
cd packages\agent
npx vitest run -c vitest.harness.config.ts test/harness/compaction.test.ts -t "cut point"
```

预期：测试全绿。打开测试文件搜 `findCutPoint`，能看到构造"user → assistant(toolCall) → toolResult"序列后断言切点绝不落在 toolResult 上；把测试里的期望改成 toolResult 的下标再跑，会失败——这就是第 3 节协议约束的可执行版本。

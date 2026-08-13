# 第四章 · 5 系统提示词与上下文文件：agent 怎么知道"这个项目的规矩"

> 源码：`packages/coding-agent/src/core/system-prompt.ts`（约 180 行）、`core/resource-loader.ts`（loadProjectContextFiles 部分）、`core/agent-session.ts`（_rebuildSystemPrompt 与 before_agent_start 部分）
> 位置：补足第 1 节留下的一个空位——`_baseSystemPrompt` 从哪来。第二章讲过 harness 层"系统提示词可以是函数"；本节看产品层怎么把这个函数填成实际内容。

## 1. 它解决什么问题

同一个模型，为什么在 pi 里表现得像"懂这个项目的同事"？答案不在模型里，在系统提示词的组装管线里。它要回答三个问题：

- 模型知道自己**有什么工具、怎么用**（工具说明）
- 模型知道**这个项目的约定**（"测试用 vitest 别用 jest"、"提交信息用中文"）
- 扩展能**临时改写**这一切（plan mode 要把"你是编码助手"换成"你现在只许出计划"）

朴素方案是一个大字符串常量。pi 把它拆成**一条组装管线**，每个来源独立维护、按固定顺序拼接：

```
默认骨架（身份 + 工具清单 + guidelines + pi 文档指路）
    + appendSystemPrompt（CLI --append-system-prompt / 设置）
    + <project_context>（AGENTS.md 链，见第 3 节）
    + <available_skills>（技能清单，第二章的渐进式披露）
    + Current working directory: ...
```

## 2. 工具自带说明书

看默认骨架里工具清单的生成方式：

```typescript
// src/core/system-prompt.ts · buildSystemPrompt，已裁剪
const tools = selectedTools || ["read", "bash", "edit", "write"];
const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
const toolsList = visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n");
```

上面代码中，`buildSystemPrompt` 自己不认识任何工具——每个工具的一句话说明（snippet）由调用方传入。往上追到 `AgentSession`：每个 `ToolDefinition` 可以携带 `promptSnippet` 和 `promptGuidelines`，注册时被收进 `_toolPromptSnippets` / `_toolPromptGuidelines` 两张表，启用工具集变化时重建提示词（`setActiveToolsByName` → `_rebuildSystemPrompt`）。

这个设计的价值在扩展场景下显现：扩展注册一个自定义工具时，**顺带把"怎么用我"的提示词也带来了**——工具与它的说明书同生共死，不存在"注册了工具但模型不知道怎么用"或"工具删了说明还在"的失配。guidelines 同理按工具集条件化生成，比如只有 bash 没有 grep/find 时才加一条 "Use bash for file operations like ls, rg, find"，并做去重。

**提示词不是文案，是从工具注册表投影出来的数据**——这是本节最值得迁移的一句话。

## 3. 上下文文件：AGENTS.md 的继承链

项目约定放在 `AGENTS.md`（兼容 `CLAUDE.md`）里。加载规则（`loadProjectContextFiles`）值得细读，因为它定义了一个"作用域继承"模型：

```typescript
// src/core/resource-loader.ts · loadProjectContextFiles，已裁剪
const globalContext = loadContextFileFromDir(resolvedAgentDir);   // ① ~/.pi/agent/ 的全局文件
if (globalContext) contextFiles.push(globalContext);

let currentDir = resolvedCwd;
while (true) {                                                    // ② 从 cwd 向上爬到根
  const contextFile = loadContextFileFromDir(currentDir);
  if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
    ancestorContextFiles.unshift(contextFile);                    //    注意 unshift：祖先在前
  }
  const parentDir = dirname(currentDir);
  if (parentDir === currentDir) break;
  currentDir = parentDir;
}
contextFiles.push(...ancestorContextFiles);
```

上面代码中，最终顺序是 **全局 → 最远祖先 → … → cwd**。`unshift` 保证越靠近工作目录的文件越靠后拼进提示词——LLM 对提示词尾部的内容遵从度更高，"近者优先"靠排列顺序实现，不需要任何合并/覆盖语法。monorepo 里根目录放公共约定、子包放自己的补充，两层自然叠加。

你可能会问 `isShadowed` 是什么：git worktree 的边界情况——嵌套 worktree 会让**同一份**被 git 跟踪的 AGENTS.md 以两个路径出现（主仓一份、worktree 一份），`findShadowedContextFile` 识别这种情形避免同一内容加载两次。为一个 corner case 写 30 行带完整注释的代码，是这个仓库的常态；读者不必记住细节，但要记住**去重的键是"内容身份"而不是"文件路径"**这个问题意识。

拼接格式也有讲究：每个文件包在 `<project_instructions path="...">` 标签里，带路径。模型引用规矩时能说出"根据 xxx/AGENTS.md"，用户可追溯。

## 4. 扩展的两个改写点

系统提示词对扩展开了两个口，力度不同：

**追加（append）**：`before_agent_start` 钩子拿到 `_baseSystemPrompt` 和完整的组装选项（`_baseSystemPromptOptions`），可以返回一个全新的 `systemPrompt`：

```typescript
// src/core/agent-session.ts，已裁剪
const result = await this._extensionRunner.emitBeforeAgentStart(
  expandedText, currentImages, this._baseSystemPrompt, this._baseSystemPromptOptions);
if (result?.systemPrompt !== undefined) {
  this._systemPromptOverride = result.systemPrompt;   // 整体覆盖
  this.agent.state.systemPrompt = result.systemPrompt;
} else {
  this.agent.state.systemPrompt = this._baseSystemPrompt;   // 没人改就复位
}
```

上面代码中，覆盖存在独立字段 `_systemPromptOverride` 而不是直接改 `_baseSystemPrompt`——base 是"事实"（由工具集和上下文文件决定），override 是"临时状态"（plan mode 开着）。第 1 节讲过的 `prepareNextTurnWithContext` 每轮取 `override ?? base`，plan mode 一关，下一轮自动回到事实。两个变量的分离让"临时改写"天然可撤销。

注意 else 分支的复位：没有扩展改写时**主动**写回 base。不写这行会怎样？上一轮的 override 会阴魂不散地留在 `agent.state.systemPrompt` 里。状态复位靠显式赋值而不是靠"应该没人改过"的假设。

## 5. 设计取舍

- **数据驱动拼接 vs 手写大字符串**：字符串常量改一处要全文重审；管线里每个来源（工具表、AGENTS.md、技能表）独立演化，组装顺序是唯一要维护的全局约定。代价是想看"最终提示词长什么样"要跑一遍（交互模式 `/debug` 可看）。
- **AGENTS.md 全文注入 vs 像技能一样按需读**：上下文文件不走渐进式披露，全文进提示词。因为项目约定是**每一轮都必须遵守**的约束，不是"任务匹配才需要"的知识——让模型自己决定读不读约定，等于没有约定。两种机制的分工线就在"约束 vs 知识"。
- **近者优先靠顺序 vs 显式优先级语法**：不发明合并 DSL，靠"后写的更管用"这一 LLM 的自然属性。零学习成本，代价是冲突时行为是概率性的而非确定性的——pi 接受这个模糊。

总之，系统提示词在 pi 里不是一段文案，而是**四个来源（工具注册表、上下文文件链、技能表、扩展覆盖）的实时投影**，其中每个来源都有自己的生命周期和复位规则。

## 动手实验

直接调用组装函数，观察各来源如何叠加（在仓库根目录）：

```typescript
// scratch-prompt.ts —— npx tsx scratch-prompt.ts
import { buildSystemPrompt } from "./packages/coding-agent/src/core/system-prompt.ts";
import { loadProjectContextFiles } from "./packages/coding-agent/src/core/resource-loader.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const contextFiles = loadProjectContextFiles({ cwd: process.cwd(), agentDir: join(homedir(), ".pi/agent") });
console.log("上下文文件链:", contextFiles.map(f => f.path));

const prompt = buildSystemPrompt({
  cwd: process.cwd(),
  selectedTools: ["read", "bash"],
  toolSnippets: { read: "Read file contents", bash: "Run shell commands" },
  contextFiles,
});
console.log(prompt);
```

预期：pi 仓库自己有 AGENTS.md，文件链里能看到它（以及你家目录若有全局文件则排最前）；打印的提示词里工具清单只有传了 snippet 的两个，`<project_context>` 段完整包含 AGENTS.md 内容。把 `selectedTools` 里的 bash 去掉再跑，观察 guidelines 的条件化变化。

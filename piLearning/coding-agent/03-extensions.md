# 第四章 · 3 扩展系统：不 fork 就能改造 agent

> 源码：`packages/coding-agent/src/core/extensions/`（loader.ts、runner.ts、types.ts）、`docs/extensions.md`、`examples/extensions/`
> 位置：承接第 1 节——AgentSession 转发出来的钩子在这里被消费。这是 pi 区别于其他 coding agent 的最大特色，也是总览里那句产品哲学的落地。

## 1. 它解决什么问题

用户想要的功能永远比产品内置的多：写文件前要确认、每轮自动 git stash、plan mode、子 agent 编排。传统答案是"提 feature request 或 fork"。pi 的答案：**把 agent 的每个决策点都开成钩子，让用户用 TypeScript 现场编程**。

一个扩展就是一个导出工厂函数的 TS 文件：

```typescript
// ~/.pi/agent/extensions/guard.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });
}
```

上面代码放进 `~/.pi/agent/extensions/` 即自动加载：一个 20 行的文件给所有 bash 调用加上了危险命令确认。注意 `ctx.ui.confirm`——扩展在工具调用的**决策路径**上可以弹 UI 等用户拍板，这是"钩子 + UI 上下文"组合的威力。

## 2. 怎么加载：jiti 运行时编译

扩展是 TS 源文件，Node 不能直接 import。`loader.ts` 用 jiti（运行时 TypeScript 编译器）解决：

```typescript
// src/core/extensions/loader.ts，已裁剪
const jiti = createJiti(import.meta.url, { /* alias / virtualModules 配置 */ });
const module = await jiti.import(extensionPath, { default: true });
```

上面代码中还有一个容易忽略的关键配置：`VIRTUAL_MODULES` 表把 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-tui`、`typebox` 等包映射到**宿主进程里已加载的模块实例**。为什么必须这样？两个原因：

- pi 可能以 Bun 编译的单文件二进制发行，磁盘上根本没有 `node_modules` 供扩展解析；
- 更重要的是**单例一致性**：扩展 `instanceof` 检查、类型标记、全局注册表必须与宿主是同一份。扩展如果自带一份 pi-ai，两个"AssistantMessage"就不是一种东西了。

这也解释了 packages.md 里的规矩：pi 核心包必须放 `peerDependencies` 且不打包——扩展永远用宿主的那份。

发现路径按信任级别分层：`~/.pi/agent/extensions/`（全局，装了就信）、`.pi/extensions/`（项目级，**要求先信任项目**——总览讲过的启动检查）、settings 里声明的 pi package（npm/git 分发）。

## 3. 怎么生效：钩子的两种性格

`ExtensionRunner`（runner.ts）持有所有扩展的处理器注册表，`AgentSession` 的事件流经它。事件分两种性格，对应第二章 harness 就有的区分：

| | 观察事件（event） | 拦截钩子（hook） |
|---|---|---|
| 例子 | `agent_start`、`turn_end`、`message_update` | `tool_call`、`tool_result`、`context`、`session_before_compact` |
| 返回值 | 忽略 | 决定后续行为 |
| 能力 | 记日志、更新 UI、外部联动 | block 工具、改写结果、替换上下文、接管压缩 |

拦截钩子的返回值语义直通第二章循环的插槽：`tool_call` 返回 `{ block, reason }` → 循环的 `beforeToolCall`；`context` 返回消息数组 → 循环的 `transformContext`。**扩展系统没有发明新机制，只是把库的插槽民主化了**。

一个值得注意的深挖点：`session_before_compact` 钩子允许扩展**整体接管压缩**（返回自己的 `CompactionResult`），第 1 节讲的自动压缩会先问扩展再走默认逻辑。连"上下文满了怎么办"这种核心策略都可替换，是"不 fork 就能改造"的极限例证。

## 4. 扩展还能注册什么

除了钩子，`ExtensionAPI` 上还有一组 register 方法，每个对应产品的一个可插面：

- `pi.registerTool(...)`——注册 LLM 可调用的工具，schema 用 typebox，与内置工具完全同级（第 1 节的 `_toolRegistry`）；工具还可以自带 TUI 渲染器，控制自己在聊天流里怎么显示。
- `pi.registerCommand("hello", ...)`——注册 `/hello` 斜杠命令，纯用户侧动作。
- `pi.registerProvider(...)`——注册自定义 LLM provider（第一章的 Provider 档案），`examples/extensions/custom-provider-*` 是完整示例。
- `pi.appendEntry(...)`——往会话树写自定义 entry（第二章第 3 节讲过的 custom entry），配合 entry 渲染器实现"可持久化的扩展状态"：plan-mode 的计划、todo 列表都存在会话文件里，重启不丢。
- `ctx.ui.custom(...)`——挂任意第三章的 TUI 组件，`doom-overlay` 示例真的在里面跑了 Doom。

## 5. 能力阶梯：extension / skill / prompt template

pi 有三种用户可分发的"知识"，能力递减、成本也递减，选型时对号入座：

| | 是什么 | 加载时机 | 能干什么 | 不能干什么 |
|---|---|---|---|---|
| 扩展（extension） | TS 代码 | 启动时 jiti 加载执行 | 一切：钩子、工具、UI、provider | ——（但要写代码、要信任） |
| 技能（skill） | SKILL.md 文档 | 描述进系统提示词，**正文按需读**（第二章第 3 节的渐进式披露） | 教模型做事的流程知识 | 改变 agent 行为，拦截任何东西 |
| 提示词模板（prompt template） | MD 宏 | 用户敲 `/name` 时展开成 user 消息 | 复用常用指令 | 影响模型主动行为 |

判断口诀：需要**拦截或注册**用扩展；教模型**怎么做某类任务**用技能；帮自己**少打字**用模板。三者都可以打进 pi package（`package.json` 的 `pi` 字段声明目录）经 npm/git 分发——分发格式统一，能力天差地别。

## 6. 设计取舍

- **进程内 TS vs 子进程/WASM 沙箱**：扩展与 pi 同进程、全权限。危险吗？危险，所以有项目信任门。换来的是零 IPC 成本、能直接挂 TUI 组件、能同步拦截工具调用。沙箱方案（对比 VS Code 的 extension host）安全但做不到"在 tool_call 决策路径上弹确认框"这种深度集成。pi 选择了信任模型换能力上限。
- **jiti 运行时编译 vs 要求用户预编译**：用户体验（扔个 .ts 文件就生效）压倒启动性能（首次加载有编译开销，有缓存）。
- **核心功能外置**：plan mode、子 agent 不内置，官方自己也用扩展实现（examples/）。产品保持小核心，代价是新用户要装东西才能得到别家开箱即有的功能——这是 pi 明知故犯的定位选择。

总之，扩展系统 = 库层插槽（第二章） + 运行时 TS 加载（jiti + 虚拟模块） + 一张信任边界。三者缺一不可：没有插槽无处可挂，没有运行时加载就要 fork 编译，没有信任门就是 RCE 漏洞。

## 动手实验

写一个最小扩展并热验证：

```typescript
// 保存为 my-ext.ts（任意路径）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    console.error(`[my-ext] tool_call: ${event.toolName}`);
    if (event.toolName === "write") return { block: true, reason: "write 被扩展禁用" };
  });
}
```

```powershell
.\pi-test.ps1 -e .\my-ext.ts
```

预期：交互模式里让 agent 写一个文件，观察 stderr 打出 `[my-ext] tool_call: write`，且工具结果显示"write 被扩展禁用"——模型会收到这条错误并改用别的办法（或者向你解释做不了）。一个 8 行文件改写了 agent 的行为边界。

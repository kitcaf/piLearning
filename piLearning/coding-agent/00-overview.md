# 第四章 · 0 packages/coding-agent 总览：三个库拼成一个产品

> 源码：`packages/coding-agent/src/`，npm 包名 `@earendil-works/pi-coding-agent`
> 位置：本教程的重头戏。第一章的 LLM 抽象、第二章的 agent 循环、第三章的 TUI，在这里被装配成用户敲 `pi` 就能用的完整产品。第五章讲它如何再被暴露成远程服务。

## 1. 它解决什么问题

前三章的库都刻意保持"不知道产品长什么样"：pi-ai 不知道有会话，agent-core 不知道有终端，tui 不知道有 LLM。产品要补的是全部"脏活"：配置和设置从哪读、API key 怎么管、会话文件存哪、内置工具（read/edit/bash…）长什么样、用户怎么扩展它、以及四种运行形态（交互 / print / RPC / SDK）怎么共享同一套核心。

一句话概括本包的策略：**所有模式共享一个核心对象 `AgentSession`，模式只是不同的 I/O 皮肤**。

```
                cli.ts → main.ts（参数解析、配置、信任检查）
                              │
                              ▼
              createAgentSession()（core/sdk.ts，装配工厂）
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  InteractiveMode        runPrintMode           runRpcMode
  （TUI 渲染事件）    （文本/JSON 输出后退出）  （JSONL 双向协议，第五章）
        └─────────────────────┴─────────────────────┘
                       全部消费同一个 AgentSession
```

上面的图中，模式层薄到什么程度？`print-mode.ts` 不到 5KB——订阅事件、把最终消息打到 stdout、退出。而 `interactive-mode.ts` 有 200KB，全部是 UI 逻辑。**核心与皮肤的比例失衡恰恰证明分层成功**：agent 行为一行都不在模式层里。

## 2. 装配现场：createAgentSession

`core/sdk.ts` 的工厂函数是理解本包的最佳入口，它把前几章的角色逐个请进来：

```typescript
// src/core/sdk.ts · createAgentSession，已裁剪
const agent = new Agent({                      // ← 第二章的 Agent 类
  initialState: { systemPrompt: "", model, thinkingLevel, tools: [] },
  convertToLlm: convertToLlmWithBlockImages,   // 消息投影 + 图片屏蔽设置
  streamFn: async (model, context, options) => // ← 第一章的 streamSimple，包了一层
    modelRuntime.streamSimple(model, context, { ...options, /* 重试/超时来自 settings */ }),
  transformContext: async (messages) =>        // ← 扩展的 context 钩子挂在这
    extensionRunnerRef.current?.emitContext(messages) ?? messages,
  steeringMode: settingsManager.getSteeringMode(),
  ...
});
if (hasExistingSession) agent.state.messages = existingSession.messages;  // 会话恢复

const session = new AgentSession({ agent, sessionManager, settingsManager,
  resourceLoader, modelRuntime, extensionRunnerRef, ... });
```

上面代码中，三点值得注意：

**(a) 第二章的每个回调口都被填上了产品语义。** `streamFn` 注入设置里的重试与超时；`transformContext` 转发给扩展系统；`convertToLlm` 加上"屏蔽图片"这类产品设置。库定义插槽，产品插板子——第二章说的"Agent 不改循环一行代码"在这里再验证一次。

**(b) `extensionRunnerRef` 是个可变引用盒子。** 为什么不直接传 runner？因为扩展支持 `/reload` 热重载——回调闭包持有的是盒子，重载时换掉 `ref.current`，所有钩子自动指向新 runner，不用重新装配 Agent。

**(c) coding-agent 用的是 `Agent` 类，不是第二章第 3 节的 `AgentHarness`。** 它有自己的 `SessionManager`（`core/session-manager.ts`，与 harness 的会话树同构：JSONL、parentId 树、leaf 指针、compaction entry）。历史原因——coding-agent 先于 harness 存在；harness 是把这里长出来的模式反向提炼进库的产物。读代码时两套名字对照着看即可，概念一一对应。

## 3. 启动链路：main.ts 在忙什么

`cli.ts` 只有 20 行（处理 `--version` 这类无需加载的路径），真正的启动在 `main.ts`（约 1000 行）。它做的事按顺序：

1. **解析参数**（`cli/args.ts`）：`-p` 进 print 模式、`--mode rpc` 进 RPC、默认交互。
2. **迁移与自更新清理**（`migrations.ts`）：老版本设置文件格式升级。
3. **项目信任检查**（`core/project-trust.ts`）：`.pi/` 目录里的扩展是任意代码，**首次进入一个项目要求用户显式信任**，否则项目级扩展/技能一概不加载。这是扩展系统的安全前提。
4. **装配**：读设置（`SettingsManager`，全局 `~/.pi/agent/settings.json` + 项目 `.pi/settings.json` 两层合并）、解析模型（`model-resolver.ts`）、选择/恢复会话（`SessionManager`）、加载资源（`ResourceLoader`：扩展/技能/模板/主题）。
5. **进入模式**，把 `AgentSession` 交出去。

其中第 4 步全部通过 `createAgentSessionServices` / `createAgentSessionRuntime` 组织——把十几个依赖的构造次序集中在一处，模式层拿到的是成品。

## 4. 产品哲学如何映射到代码

README 的 Philosophy 一句话：*"Adapt pi to your workflows... without having to fork"*——pi 故意**不内置** plan mode、子 agent 这些功能，赌的是扩展系统足够强，用户自己装或自己写。这个赌注决定了本章的阅读重点：

- 扩展能拦工具调用 → `AgentSession` 必须把第二章的钩子全部转发出去（第 1 节）
- 扩展能注册工具/命令/UI → 需要一个完整的 ExtensionAPI 面（第 3 节）
- 扩展是 TypeScript 源文件 → 需要运行时 TS 加载器（第 3 节）
- 技能/模板/主题要能从 npm/git 分发 → pi package 体系（第 3 节顺带讲）

## 本章路线

| 节 | 内容 | 对应源码 |
|---|------|---------|
| 1 | AgentSession：事件转发枢纽、自动压缩、重试 | `core/agent-session.ts` |
| 2 | 内置工具：edit 匹配策略、输出截断、bash 执行器 | `core/tools/` |
| 3 | 扩展系统：加载、钩子、能力阶梯 | `core/extensions/` |
| 4 | 交互模式：事件如何流到 TUI 组件 | `modes/interactive/` |
| 5 | 系统提示词与上下文文件（AGENTS.md 链） | `core/system-prompt.ts`、`core/resource-loader.ts` |
| 6 | ModelRuntime 与认证落地（选读） | `core/model-runtime.ts`、`core/auth-storage.ts` |

## 动手实验

感受"模式只是皮肤"。同一个 prompt 分别跑 print 和 JSON 模式（用仓库自带脚本，不接模型时加 `--no-env` 看启动流程也行；接了模型则观察输出差异）：

```powershell
.\pi-test.ps1 -p "say hi"                # 只打印最终文本
.\pi-test.ps1 --mode json -p "say hi"    # 每个 AgentSessionEvent 一行 JSON
```

预期：JSON 模式输出的事件序列（`agent_start`、`message_start`、`message_update`…）与第二章第 1 节的循环事件一一对应——两种模式消费的是完全相同的事件流，差别只在"怎么打印"。

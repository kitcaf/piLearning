# Pi 项目学习路线

面向目标：从零到能读懂、修改、扩展这个 coding agent 项目。每个阶段建立在前一阶段之上，不要跳跃。

## 依赖关系鸟瞰（学习顺序的依据）

```
protocol (RPC 编解码)      tui (终端 UI 库)
        \                     \
   ai (LLM 多提供商统一 API)    \
        \                       \
      agent (Agent 运行时/循环)   \
              \                   \
           coding-agent (pi CLI 本体) ← storage/sqlite-node
                    \
                  server (远程会话服务)
```

底层包不依赖上层包，所以学习顺序 = 依赖顺序：**ai → agent → tui → coding-agent → 扩展 → server/protocol**。

---

## 阶段 0：跑起来 + 摸清全貌（半天）

**目标**：项目能运行，知道每个包是干什么的。

- [x] `npm install --ignore-scripts` 安装依赖
- [x] `.\pi-test.ps1 --no-env` 启动 TUI（不接模型）
- [ ] 读根 `README.md`，读每个包的 `README.md`（ai、agent、tui、coding-agent）
- [ ] 读 `packages/coding-agent/docs/index.md` 和 `docs/packages.md`，理解包分层
- [ ] 试试 `.\pi-test.ps1 --no-env --help`、`--list-models`，感受 CLI 有哪些能力

**验收**：能用自己的话说出 ai / agent / tui / coding-agent 四个包各自的职责边界。

---

## 阶段 1：pi-ai —— LLM 统一抽象层（2~3 天）

**目标**：理解"如何把 OpenAI / Anthropic / Google 等不同 API 统一成一个接口"。这是整个项目的地基。

按顺序读：

1. `packages/ai/src/types.ts` —— 核心类型：`Model`、`Message`、`Tool`、流式事件。**先把类型吃透，后面一切都围绕它们。**
2. `packages/ai/src/index.ts` —— 公开 API 面
3. `packages/ai/src/providers/anthropic.ts` —— 挑一个 provider 精读：请求构造 → SSE 流解析 → 统一事件输出
4. `packages/ai/src/providers/openai-*.ts` —— 对比读第二个 provider，找出"哪些是共性（抽象层），哪些是差异（适配层）"
5. `packages/ai/src/models.generated.ts` + `scripts/generate-models.ts` —— 模型元数据（价格、上下文窗口）如何从 models.dev 生成
6. `packages/ai/src/oauth.ts`、`env-api-keys.ts` —— 认证体系
7. `packages/ai/src/providers/faux.ts` —— 假 provider，测试用，**后面阶段调试全靠它**

**动手**：
- 用 `packages/ai` 写个 10 行小脚本调 `streamText`（可用 faux provider，无需 API key）
- 跟着 `.pi/skills/add-llm-provider.md` 走一遍"如何新增 provider"的流程（只看不做也行）

**验收**：能画出"一次 LLM 请求从调用到流式返回"的完整数据流图。

---

## 阶段 2：pi-agent-core —— Agent 循环（2~3 天）

**目标**：理解 agent 的本质：**一个"LLM 调用 → 工具执行 → 结果回填 → 再调用"的循环**。

按顺序读：

1. `packages/agent/src/types.ts` —— AgentState、AgentEvent、Tool 定义
2. `packages/agent/src/agent-loop.ts` —— **全项目最核心的文件**。精读：循环怎么驱动、工具调用怎么分发、事件怎么发出、怎么中断
3. `packages/agent/src/agent.ts` —— 对循环的封装（状态管理、订阅）
4. `packages/agent/docs/harness.md` + `src/harness/agent-harness.ts` —— harness：在裸循环之上加会话、系统提示词、工具集的"装配层"
5. `packages/agent/src/harness/system-prompt.ts`、`skills.ts`、`compaction/` —— 系统提示词组装、技能加载、上下文压缩

**动手**：
- 用 faux provider + agent-loop 写一个最小 agent：注册一个 `add(a,b)` 工具，观察完整的循环事件序列
- 参考 `packages/coding-agent/test/suite/harness.ts` 的测试写法

**验收**：能解释"用户一句话进来，到 agent 停止响应"之间发生的每一步，包括多轮工具调用。

---

## 阶段 3：pi-tui —— 终端 UI 库（1~2 天，可略读）

**目标**：理解终端 UI 的差分渲染原理。不是重点，够用即可。

1. `packages/tui/src/tui.ts` —— 组件模型 + 差分渲染核心
2. `packages/tui/src/terminal.ts` —— 终端抽象（raw mode、ANSI 序列）
3. `packages/tui/src/editor-component.ts` —— 输入框组件（多行编辑、快捷键）
4. `packages/tui/src/keys.ts` + `keybindings.ts` —— 按键解析

**动手**：写一个 20 行的小 TUI：一个计数器组件，按键加减。

**验收**：知道"为什么屏幕不闪烁"（差分渲染），知道按键事件如何流转到组件。

---

## 阶段 4：coding-agent —— 把一切组装成产品（4~5 天，重头戏）

**目标**：理解 pi CLI 如何把 ai + agent + tui 组装成完整的 coding agent。

**4a. 启动链路**（1 天）：

1. `packages/coding-agent/src/cli.ts` → `main.ts` —— 入口：参数解析、配置加载、模式分发
2. `src/cli/args.ts`、`src/config.ts` —— CLI 参数与配置体系
3. `src/modes/interactive/` —— 交互模式如何启动 TUI
4. `src/modes/print-mode.ts` —— 对比：非交互的 `-p` 模式（更简单，先读这个）

**4b. 会话核心**（2 天）：

5. `src/core/agent-session.ts` —— **核心中的核心**：把 harness、工具、扩展、持久化绑在一起的会话对象
6. `src/core/tools/` —— 内置工具（read/write/edit/bash/grep...）逐个读，重点看 edit 工具的字符串匹配策略和 bash-executor
7. `src/core/messages.ts`、`src/core/event-bus.ts` —— 消息流与事件
8. `src/core/compaction/` —— 上下文满了怎么压缩
9. `docs/session-format.md` + `src/core/` 里的 session 持久化 —— 会话如何存储/恢复

**4c. 交互 UI**（1 天）：

10. `src/modes/interactive/` 下的组件 —— 消息渲染、工具执行展示、autocomplete、斜杠命令

**动手**：
- 给 pi 加一个自定义内置小工具（比如 `wordcount`），跑通端到端
- 用 `--no-env` + faux/mock 或断点跟一次完整交互

**验收**:能从 `cli.ts` 一路追踪到"一个 edit 工具调用在屏幕上渲染出 diff"。

---

## 阶段 5：扩展系统 —— pi 的"自我扩展"能力（2 天）

**目标**：理解 pi 最有特色的部分：用 TypeScript 扩展 agent 自身。

1. `packages/coding-agent/docs/extensions.md` —— 先读文档
2. `src/core/extensions/` —— 扩展加载器、API 暴露、生命周期
3. `examples/extensions/` 逐个跑：从简单的开始 → `plan-mode/` → `subagent/`（子 agent 编排）
4. `docs/skills.md` + harness 的 skills 机制 —— 扩展 vs 技能 vs 提示词模板的区别
5. `.pi/` 目录 —— 本仓库自己吃自己狗粮的配置

**动手**：写一个自己的扩展：注册一个斜杠命令 + 一个自定义工具。

**验收**：能说清 extension / skill / prompt template / theme 各自的加载时机和能力边界。

---

## 阶段 6：外围系统（2 天，按兴趣选读）

- `packages/protocol/` —— CBOR 编解码 + 帧协议（`src/framing.ts`、`schemas.ts`），RPC 模式的地基
- `src/modes/rpc/` + `docs/rpc.md` —— pi 作为子进程被程序化驱动（SDK 模式）
- `packages/server/` —— 多会话服务端：`supervisor.ts`（进程管理）→ `serve.ts` → `ipc/`
- `packages/storage/sqlite-node/` —— SQLite 持久化
- `packages/evals/` —— 模型评测框架
- `packages/coding-agent/src/core/export-html/` —— 会话导出

**验收**：理解 `pi` 单机 CLI 与 server 远程会话的架构差异。

---

## 阶段 7：综合实战（持续）

选一个做深：

1. **加一个 LLM provider**（跟 `.pi/skills/add-llm-provider.md`，打通阶段 1）
2. **写一个复杂扩展**：比如带 UI 覆盖层的（参考 `doom-overlay`），打通阶段 3+5
3. **读测试学行为**：`packages/coding-agent/test/suite/` 的回归测试是行为规格书
4. **追一个真实 issue**：从 GitHub issues 里挑 bug，定位并修复

---

## 学习方法建议

- **每阶段带着问题读**：先看该阶段"验收"，答不上来再回去读
- **调试优于阅读**：`tsx` 直接跑 TypeScript 源码，随处可以 `console.error` / 断点（VS Code launch 到 `pi-test.ps1` 的 node 进程）
- **faux provider 是你的朋友**：不花钱、可控、可断言
- **测试是最好的文档**：读不懂某模块时先找它的 `test/`

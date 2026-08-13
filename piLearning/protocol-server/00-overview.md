# 第五章 · 0 protocol + server 总览：从一个人的终端到远程会话

> 源码：`packages/coding-agent/src/modes/rpc/`、`packages/server/src/`、`packages/protocol/src/`
> 位置：全教程最后一章。第四章把 pi 装配成单机 CLI，本章看它如何一步步"长出网络"：先可编程，再可托管，最后可远程。

## 1. 它解决什么问题

单机交互 CLI 有三个天然做不到的事：

- **被程序驱动**：IDE 插件、CI 脚本、评测框架想调用 agent，不能靠模拟键盘。
- **活得比终端久**：关掉笔记本，跑了一半的任务就死了。
- **从别处接入**：从手机、从网页查看和操控家里工作站上的 agent。

pi 的解法不是一个大服务器，而是**三层递进的架构**，每层解决一件事，每层复用前一层：

```
第一层  pi --mode rpc          可编程：JSONL over stdin/stdout
        （coding-agent 内）      每个实例 = 一个子进程
                 ▲ spawn + 管道
第二层  pi-server               可托管：常驻守护进程 + unix socket IPC
        （supervisor）           管理 N 个 RPC 子进程，崩溃恢复
                 ▲ IPC
第三层  pi-protocol             可远程：CBOR + 帧协议 + schema
        （实验性）               面向 web/远程客户端的线协议
```

上面的图自下而上读：RPC 模式让**一个** agent 可编程；server 让**一组** agent 有人看管；protocol 定义**跨网络**说话的格式。注意箭头方向——上层永远通过下层已有的接口工作，第二层的 supervisor 驱动 agent 的方式就是 spawn 一个 `pi --mode rpc` 子进程，与任何第三方程序毫无区别。

## 2. 关键决策：进程即隔离单元

三层贯穿一个决策：**一个会话 = 一个进程**。server 不是在单进程里开 N 个 AgentSession，而是 spawn N 个 pi 子进程。

对比朴素方案（单进程多会话）损失了什么、换来了什么：

| | 单进程多会话 | 每会话一个进程（pi 的选择） |
|---|---|---|
| 内存/启动开销 | 低 | 每个实例一份 Node 运行时 |
| 一个会话崩溃 | 可能带走全部 | 只死自己，supervisor 重启 |
| 扩展的全局状态 | 互相污染（第四章讲过扩展与宿主同进程、可改全局） | 天然隔离 |
| 复用已有代码 | 要给 AgentSession 加多租户 | RPC 模式**原样复用**，server 零侵入 |

第三行是决定性的：第四章的扩展系统赋予扩展全权（改 provider、挂全局钩子），这个能力模型在单进程多会话下是灾难。**进程边界是扩展自由的代价，也是它的解药**。

## 3. 三层的读法

- **第一层（第 1 节）**：RPC 模式的 JSONL 协议——命令/响应/事件三类消息怎么在一条 stdout 上复用，交互式 UI 请求怎么反向穿透。
- **第二层（第 2 节）**：supervisor 的进程生死簿——instances.json、崩溃恢复、事件转发。
- **第三层（第 3 节）**：pi-protocol 的线协议——为什么远程这层从 JSON 换成 CBOR + 长度前缀帧，"快照权威、进度瞬态"的状态模型。注意此包标注 experimental，monorepo 内还没有消费者，读它读的是设计意图。

## 本章路线

| 节 | 内容 | 对应源码 |
|---|------|---------|
| 1 | RPC 模式：JSONL 协议与反向 UI | `coding-agent/src/modes/rpc/` |
| 2 | server：supervisor 与崩溃恢复 | `server/src/supervisor.ts`、`ipc/` |
| 3 | 线协议：CBOR、帧、快照模型 | `protocol/src/` |

## 动手实验

手工扮演一次 RPC 客户端，感受第一层（需要已配置模型；Windows PowerShell 下建议进 WSL 或 git-bash 玩管道，这里用最直白的交互方式）：

```powershell
.\pi-test.ps1 --mode rpc
```

启动后直接在终端里敲一行 JSON 并回车：

```json
{"id":"1","type":"prompt","message":"say hi"}
```

预期：stdout 先回一行 `{"id":"1","type":"response","command":"prompt","success":true}`（命令被接受），随后是一串事件行——`agent_start`、`message_start`、逐 token 的 `message_update`、`agent_end`。第四章 JSON 模式是"只读直播"，RPC 模式是"可写的直播"：你正在用的协议就是 server 和所有 SDK 客户端用的那一个。

# 第五章 · 1 RPC 模式：把整个 agent 折叠进一条管道

> 源码：`packages/coding-agent/src/modes/rpc/rpc-mode.ts`（约 800 行）、`rpc-types.ts`、`jsonl.ts`、`rpc-client.ts`；协议文档 `packages/coding-agent/docs/rpc.md`
> 位置：承接总览的第一层。这是第四章"模式只是皮肤"的第三张皮——把 TUI 换成 stdin/stdout 上的 JSON。

## 1. 它解决什么问题

嵌入方（IDE、脚本、server）需要 agent 的全部能力——发提示、插话、切分支、跑压缩——但不要终端 UI。要求一个对任何语言都友好的接口。

pi 选了最古老的方案:**子进程 + 标准流上的 JSONL**（每行一个 JSON 对象）。不开端口、不需要 HTTP 框架，`spawn` 即用，进程退出即清理。协议只有三类消息：

```
stdin  ←  命令（client → pi）   {"id":"1","type":"prompt","message":"..."}
stdout →  响应（每命令一条）     {"id":"1","type":"response","command":"prompt","success":true}
stdout →  事件（持续流）         {"type":"message_update", ...}
```

上面的表中有个要点：**响应和事件复用同一条 stdout**。客户端逐行解析，按 `type` 分流——`response` 靠 `id` 与自己发的命令配对，其余都是第四章的 `AgentSessionEvent` 原样序列化。RPC 模式的实现核心就这么一个循环：

```typescript
// src/modes/rpc/rpc-mode.ts，已裁剪
const output = (obj) => writeRawStdout(serializeJsonLine(obj));
unsubscribe = session.subscribe(async (event) => output(event));   // 事件直通

attachJsonlLineReader(process.stdin, async (parsed) => {
  const response = await handleCommand(parsed as RpcCommand);      // 命令→响应
  if (response) output(response);
});
```

上面代码中，`session.subscribe` 依旧是第四章那个唯一订阅点——interactive 模式把事件画成组件，RPC 模式把事件 `JSON.stringify`。同一个心脏，两张皮。

## 2. 命令面：AgentSession 的镜像

`RpcCommand` 的类型清单几乎逐一映射 AgentSession 的公开方法：`prompt` / `steer` / `follow_up` / `abort` / `compact` / `fork` / `navigate_tree` / `switch_session` / `set_model` / `get_state`……没有为 RPC 发明新语义，只是把方法调用变成了 JSON 编码。

值得停下的是 `prompt` 在 agent 正忙时的行为：

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

上面的 `streamingBehavior` 字段强制客户端表态：agent 正在流式输出时，这条消息是插话（`steer`）还是追加（`followUp`）？不表态就报错。为什么不默认选一个？因为两者语义差异巨大（第二章第 1 节的两条队列），静默猜错会让嵌入方 debug 到怀疑人生。**远程接口宁可拒绝歧义请求，不替调用方做有损猜测**。

响应语义也有一条精确的约定（rpc.md）：`success: true` 只表示命令**被接受**，之后的失败走事件流报告，不会给同一个 id 发第二条响应。命令的生命周期短（接受/拒绝），任务的生命周期长（事件流）——两者分离，客户端才能不阻塞地发命令。

## 3. 反向通道：extension_ui_request

最有意思的问题：第四章的扩展会调 `ctx.ui.confirm(...)` 弹确认框——headless 模式下弹给谁？

RPC 模式把 UI 请求**反向发给客户端**：

```typescript
// src/modes/rpc/rpc-mode.ts，已裁剪
// 扩展调用 ctx.ui.confirm 时：
output({ type: "extension_ui_request", id, method: "confirm", title, message });
// 挂起 promise，等 stdin 上出现配对的应答：
// {"type":"extension_ui_response","id":"...","value":true}
pendingExtensionRequests.set(id, { resolve, reject });
```

上面代码中，`ctx.ui` 在 RPC 模式下的实现是"序列化请求 + 挂起等待"——扩展代码完全无感，它 await 的 confirm 由网络对面的人（或程序）拍板。于是权限门扩展在 IDE 集成里照常工作，IDE 负责把 `extension_ui_request` 画成自己的对话框。**能力接口（ctx.ui）与呈现（TUI/IDE/网页）解耦，靠的是把 UI 也协议化**。

## 4. 一个防坑细节：JSONL 的换行符法条

rpc.md 专门用一节讲分行规则：只认 `\n`，容忍 `\r\n`，并点名 **Node 的 readline 不合规**——它还会按 `U+2028`/`U+2029` 分行，而这两个字符可以合法出现在 JSON 字符串里（比如模型输出里带一个行分隔符），用 readline 解析会把一条消息切成两半。pi 自己的 `jsonl.ts` 用手写的按字节找 `\n` 的 reader。

这类细节值得记住的原因：**协议的健壮性死于"看起来能用"的通用工具**。JSONL 看似简单到不需要规范，恰是出事最多的地方。

## 5. SDK：RPC 之上还是之下？

`docs/rpc.md` 开头有个导流：Node/TS 用户别用 RPC，直接 import `createAgentSession`（第四章总览的装配工厂）进程内使用；`rpc-client.ts` 则是"确实需要子进程隔离"时的现成 TS 客户端（spawn + JSONL 封装 + typed promise API）。

三个层次的选型表：

| 方式 | 隔离 | 语言 | 适用 |
|---|---|---|---|
| SDK（进程内） | 无 | 仅 TS/JS | 深度嵌入，共享扩展与状态 |
| RpcClient（子进程） | 进程级 | 仅 TS/JS | 要隔离但不想自己写协议 |
| 裸 RPC（自己 spawn） | 进程级 | **任何语言** | Python/Go/Rust 集成 |

## 6. 设计取舍

- **stdio vs HTTP/socket**：stdio 免端口管理、免鉴权（进程句柄即权限）、生命周期天然绑定；代价是一对一——一个子进程只能有一个驾驶员。要多路复用就上第 2 节的 server。
- **事件全量直播 vs 按需订阅**：RPC 把所有 AgentSessionEvent 一股脑推给客户端，不提供订阅过滤。带宽在本机管道上不要钱，协议简单压倒流量优化。
- **文本 JSON vs 二进制**：本层保持 JSON，人能 `cat` 能手敲，调试价值极高；二进制优化留给了第三层的远程协议（第 3 节），那里才真正在乎字节数。

总之，RPC 模式是"分层正确"的红利结算：因为 AgentSession 与 UI 早就解耦，headless 化只花了 800 行，其中一半还是在处理扩展 UI 的反向通道。

## 动手实验

用管道非交互地驱动一次（在 git-bash / WSL 下）：

```bash
printf '%s\n' '{"id":"1","type":"prompt","message":"1+1=?"}' \
  | ./pi-test.ps1 --mode rpc 2>/dev/null \
  | grep -E '"type":"(response|agent_end)"'
```

预期：看到 `"success":true` 的响应行和最终的 `agent_end` 事件行。再试发一条不带 `streamingBehavior` 的第二个 prompt（在第一个还没跑完时），观察 `success:false` 的拒绝响应——第 2 节的"拒绝歧义"当场兑现。

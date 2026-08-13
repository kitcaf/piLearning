# 第五章 · 2 server：给一群 agent 找个管家

> 源码：`packages/server/src/`（supervisor.ts、rpc-process.ts、serve.ts、handler.ts、ipc/、storage.ts）
> 位置：承接第 1 节。RPC 让一个 agent 可编程，本节的 server 让一组 agent 常驻、可恢复、可被多方观察。注意包标注 experimental。

## 1. 它解决什么问题

裸 RPC 的隔离模型是"谁 spawn 谁负责"：驾驶员进程退出，agent 子进程跟着死；两个程序想看同一个 agent 的输出，做不到。要的是一个**常驻的中间人**：

```
  CLI 工具 ─┐                      ┌─ pi --mode rpc (实例 A, cwd=~/proj1)
  IDE 插件 ─┼─ unix socket ─ server ┼─ pi --mode rpc (实例 B, cwd=~/proj2)
  radius 云 ─┘   （IPC 请求）        └─ pi --mode rpc (实例 C, ...)
```

上面的图中，server 对上提供一个 unix socket 的 IPC 接口，对下用第 1 节的裸 RPC 管理子进程。IPC 请求就六种（`ipc/protocol.ts`）：`spawn` / `list` / `stop` / `status` / `rpc` / `rpc_stream`——前四个管进程生死，后两个是**透传**：`rpc` 把一条 RpcCommand 转发给指定实例，`rpc_stream` 把实例的事件流持续推给订阅方。server 自己不理解 agent 语义，它只是带花名册的交换机。

## 2. supervisor：花名册与生死簿

核心类 `ServerSupervisor` 维护两份状态：内存里的 `liveInstances`（活进程句柄 + 订阅者集合），磁盘上的 `instances.json`（实例档案）。每次状态变化先改内存再落盘：

```typescript
// src/server/src/supervisor.ts，已裁剪
private setStatus(live: LiveInstance, status: InstanceStatus): void {
  live.record = { ...live.record, status, lastSeenAt: new Date().toISOString() };
  upsertInstance(live.record);          // 写 instances.json
}
```

上面代码的落盘不是审计日志，而是**恢复的依据**：server 自己也会崩。`serve.ts` 启动时第一件事是 `supervisor.recoverAfterRestart()`——读 instances.json，把上次还活着的实例重新 spawn 起来。子进程侧同理：`rpcProcess.onExit` 挂了意外退出处理，实例崩了标记状态并重启。**会话内容的恢复不归 server 管**——第四章讲过会话在 JSONL 文件里，重启的 pi 子进程用 `--session` 参数接着上次的文件继续，server 只需要记住"哪个实例对应哪个会话文件"。

档案刷新有个小优化值得一读：

```typescript
// 只有这些命令可能改变持久化的会话元数据，才值得跟进一次 get_state
const SESSION_METADATA_COMMANDS = new Set([
  "new_session", "switch_session", "fork", "clone", "set_session_name", "prompt",
]);
```

上面代码中，server 转发命令后本可以每次都向子进程要一份最新状态，但绝大多数命令不改会话身份——白名单把"每命令一次 get_state"的 IO 省成"必要时一次"。注释把理由写得清清楚楚，这是好的工程注释的样子。

## 3. 事件分发：一对多的广播盒

多个客户端可以同时 `rpc_stream` 订阅同一个实例。supervisor 给每个实例维护订阅者集合，子进程 stdout 上的每个事件广播出去：

```typescript
// src/server/src/supervisor.ts · bindRpcProcess，已裁剪
live.unsubscribeEvents = rpcProcess.onEvent((event) => {
  for (const subscriber of live.subscribers) subscriber(event);
});
rpcProcess.setUiRequestHandler((request) => { live.onUiRequest?.(request); });
```

上面代码中，事件是多播的，但 `extension_ui_request`（第 1 节的反向 UI 通道）是**单播**——确认框只能有一个人答，谁持有 UI 通道谁拍板。一多一单的区分体现了两类消息的本质：事件是"发生了什么"（人人可看），UI 请求是"请做决定"（必须有唯一责任人）。

`radius.ts` 是可选的云端在场（presence）集成：server 把本机实例注册到远端服务，手机/网页经云端中转访问家里的 agent。它消费的还是同一套 supervisor 接口——又一个"上层复用下层"的例证。

## 4. 设计取舍

- **unix socket vs TCP 端口**：本机 IPC 用 socket 文件，权限即文件权限，不占端口不需鉴权。远程访问不由 server 直接提供，而是经 radius 中转——把"网络安全"这个大问题外包给专门的一层。
- **server 无状态转发 vs 理解 agent 语义**：server 不解析事件内容、不缓存 transcript。想要"断线重连补历史"？子进程的会话文件才是真相，重连方 `get_state` + 读会话即可。**不在中间层复制真相**，就永远不需要同步真相。
- **experimental 的诚实**：README 明说 API 可能随时变。架构上它是三层中最年轻的一环，读它的价值在骨架（supervisor 模式、透传设计）而非 API 细节。

总之，server 的全部智慧是**只当管家不当翻译**：进程生死、档案持久、事件转发它管；agent 说什么、会话存什么，它一概不碰。中间层做得越少，系统越好推理。

## 动手实验

读 supervisor 的崩溃恢复路径并画出状态流。不需要跑起来（experimental，依赖 radius 配置），用测试和代码走读代替：

```powershell
cd packages\server
npx vitest run 2>$null   # 如有测试套件则运行
```

然后打开 `src/supervisor.ts`，从 `recoverAfterRestart` 顺藤摸瓜到 `handleUnexpectedRpcExit`，回答两个问题：(1) server 重启后，`status: "running"` 的旧档案会发生什么？(2) 子进程意外退出后第几步会重新 spawn？把答案与 `instances.json`（`~/.pi/agent/server/` 下）的字段对照——档案里的每个字段都应该在这两条路径里被读或被写，否则它就是死重量。

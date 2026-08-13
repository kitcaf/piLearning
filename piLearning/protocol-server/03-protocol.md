# 第五章 · 3 pi-protocol：为远程客户端设计的线协议

> 源码：`packages/protocol/src/`（framing.ts、cbor/、codec.ts、schemas.ts），npm 包名 `@earendil-works/pi-protocol`
> 位置：全教程最后一节。前两节的 JSONL/IPC 都跑在本机管道上；本节的协议为真正的网络（web 客户端、跨机器）设计。实验性，monorepo 内暂无消费者——读的是设计意图。

## 1. 它解决什么问题

把第 1 节的 JSONL 直接搬上网络会遇到三个新问题：

- **消息边界**：TCP 是字节流，"一行一条"要扫描每个字节找 `\n`，而且二进制内容（图片）必须 base64 膨胀 33%。
- **不可信输入**：网络对面可能是恶意的。一条声称 4GB 长的消息、一个循环引用的对象、一段畸形 UTF-8，都不能让服务崩溃。
- **断线重连**：网络会断。事件流断了之后，客户端怎么追上状态？

pi-protocol 的三个对策：长度前缀帧、schema 验证的 CBOR、快照权威模型。逐个看。

## 2. 帧：4 字节长度前缀

线格式一句话：**4 字节大端无符号长度 + 一个定长 CBOR 项**。

```typescript
// src/framing.ts · encodeFrame，已裁剪
const frame = new Uint8Array(4 + payload.byteLength);
frame[0] = length >>> 24; frame[1] = length >>> 16;
frame[2] = length >>> 8;  frame[3] = length;
frame.set(payload, 4);
```

上面代码中，接收方先读 4 字节就知道后面还有多少——不扫描内容、不解析、O(1) 定界。对照 JSONL：找 `\n` 要碰每个字节，还要处理"内容里出现分隔符"的转义问题（第 1 节 readline 的坑就是这一类）。长度前缀从根上消灭分隔符问题。

`FrameDecoder` 是配套的增量解码器：接受任意切碎/粘连的字节块（`push(chunk)` 返回零到多条完整帧），内部按 64KB 块暂存未完帧。关键的防御在读到长度的那一刻：

```typescript
// src/framing.ts · FrameDecoder.push，已裁剪
if (frameLength > this.maxFrameLength) {        // 默认 16MB
  this.state = "failed";
  throw new FrameError(`Frame length ${frameLength} exceeds configured limit`);
}
```

上面代码中，超限帧在**分配任何缓冲之前**就被拒绝——恶意的"4GB 长度声明"连一个字节的内存都骗不到。还有一个 `end()` 方法：字节流关闭时调用，如果还有半条帧就报"截断"错——静默吞掉半条消息是分布式 bug 的温床。

## 3. CBOR：二进制的 JSON

CBOR（Concise Binary Object Representation，RFC 8949）数据模型与 JSON 同构（map/array/string/number/bool/null），但二进制编码。pi 自己实现了编解码器（`cbor/`，非依赖），换来的收益：

- **字节串是一等公民**：图片、附件直接以 bytes 传输，免 base64；
- **更紧凑**：字段名和数字的编码开销小于 JSON 文本；
- **定长优先**：编码器输出定长（definite-length）项，接收方能预先分配。

你可能会问：为什么不用 protobuf？protobuf 需要 schema 编译步骤和代码生成，而 pi 的消息类型已经用 typebox（运行时 schema）定义。CBOR 是"无 schema 的二进制 JSON"，与 typebox 验证组合刚好：先解码成普通对象，再跑 schema 验证。验证在 `codec.ts` 的编解码两侧**都**执行：

```typescript
// src/codec.ts · encodeProtocolMessage，已裁剪
const validated = parse(value);                        // 出站也验证
const frame = encodeFrame(encodeCbor(validated, { maxByteLength }));
```

上面代码中，连**自己发出**的消息也过 schema——出站验证抓的是己方 bug（构造了不合法消息），入站验证挡的是对方攻击。另有一个 `isProtocolValue` 前置检查拒绝原型链污染（非纯 Object）、循环引用和 undefined 值，把 JS 对象的"暗门"关在协议之外。

## 4. 状态模型：快照权威，进度瞬态

schemas.ts 定义的消息分三类：hello 握手（带协议版本和 bearer token，版本不符立刻 `hello_error`）、请求/响应信封（id 关联，同第 1 节）、服务器事件。README 里有一句浓缩的设计声明：

> Session and server snapshots are authoritative. Progress events are transient UI hints and **must not** be reduced into authoritative state.

翻译过来：**客户端的真实状态永远来自快照（snapshot），进度事件只许拿来做动画**。对比第 1 节的 RPC 模式——那里客户端靠事件流累积状态（漏一个 `message_end` 状态就错了），在可靠的本机管道上没问题；网络上事件会丢、会乱序、重连有空窗。与其设计"事件重放 + 序号 + 补偿"这套重型机制，pi 直接规定：重连 = 拿新快照，事件流从此刻重新开始，丢掉的进度事件不需要补——反正它们只是"打字机动画"，快照里有定稿。

这个"快照 + 瞬态提示"模型正是第二章 harness 设计文档里 UI model 的原话（*Atomic snapshot plus live event stream. No event replay; reconnect means new snapshot*）——库层早就为这一天铺了路。schema 里的 `TranscriptProgressSchema`（delta 事件）与 `TranscriptItemSchema`（快照项）的分家就是这个模型的类型化。

## 5. 设计取舍

- **CBOR vs JSON**：调试从 `cat` 变成需要工具，这是实打实的代价。所以 pi 只在网络层用 CBOR，本机的 RPC/IPC 保持 JSON——**每层选自己流量特征配得上的编码**。
- **快照重传 vs 事件重放**：快照在会话很大时重传成本高；事件重放实现复杂且服务端要留 buffer。pi 押快照：会话有压缩机制兜着大小（第二章第 4 节），而"简单的重连语义"在网络代码里千金难买。
- **自研 CBOR vs 引依赖**：几百行换零依赖 + 精确控制（maxByteLength、定长输出）。协议层的依赖是攻击面，自研在这里是安全决策不只是 NIH。

总之，pi-protocol 是三层中唯一"为不可信环境设计"的一层：长度前缀防资源攻击、双向 schema 验证防畸形数据、快照模型防状态漂移。单机代码长出网络的时候，这三样就是必须补的课。

## 动手实验

不需要网络，直接把编解码器当库玩：

```typescript
// scratch-proto.ts —— npx tsx scratch-proto.ts（在仓库根目录）
import { encodeClientMessage, createClientMessageDecoder, PROTOCOL_VERSION } from "./packages/protocol/src/index.ts";

const frame = encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION, token: "secret" });
console.log("帧长:", frame.length, "前4字节(长度):", [...frame.slice(0, 4)]);

const decoder = createClientMessageDecoder();
console.log("切两半喂:", decoder.push(frame.slice(0, 5)));   // []：不完整
console.log("喂剩下的:", decoder.push(frame.slice(5)));      // [ { type: 'hello', ... } ]
```

预期：前 4 字节恰是 CBOR 载荷的字节数；切成两半分次 `push`，第一次返回空数组、第二次吐出完整消息——增量解码对任意分包免疫。再试把 token 字段删掉后 `encodeClientMessage`，观察 `ProtocolValidationError`（出站验证工作中）。

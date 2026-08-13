# 第三章 · 2 输入管线：从字节流到"ctrl+c"

> 源码：`packages/tui/src/terminal.ts`（raw mode 与协议协商）、`stdin-buffer.ts`（断包重组）、`keys.ts`（按键匹配，约 1100 行）、`tui.ts`（handleTerminalInput 分发）
> 位置：承接第 1 节的输出方向，本节讲输入方向。两节合起来就是 TUI 框架的全部骨架，为第四章"键盘事件如何变成 agent 操作"铺路。

## 1. 它解决什么问题

终端的输入接口原始得令人发指：stdin 给你的只是**字节流**。按一下方向盘上键，来的是 `\x1b[A` 三个字节；粘贴一段文本，来的是夹在特殊标记里的一大坨；而且这些字节**不保证一次事件送完**——`\x1b[A` 可能分两次 data 事件到达，第一次只有 `\x1b`。

朴素方案 `process.stdin.on("data", handler)` 会在三个地方翻车：

- `\x1b` 单独到达时被当成"用户按了 Esc"，紧接着的 `[A` 被当成用户输入了字符 `[` 和 `A`；
- 粘贴的多行文本被逐行执行（想象粘贴的代码里有一行恰好是危险命令）；
- 同一个"Ctrl+Backspace"在五种终端里是五种字节序列。

输入管线分三站解决：**重组（StdinBuffer）→ 匹配（keys.ts）→ 分发（TUI）**。

## 2. 第一站：断包重组

`StdinBuffer` 的职责一句话：攒字节，直到确认凑成完整序列才吐出。核心是一个"这段字节完整了吗"的判定函数：

```typescript
// src/stdin-buffer.ts · isCompleteSequence，已裁剪
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
  if (!data.startsWith(ESC)) return "not-escape";
  if (data.length === 1) return "incomplete";        // 孤零零一个 ESC，等
  const afterEsc = data.slice(1);
  if (afterEsc.startsWith("[")) return isCompleteCsiSequence(data);  // CSI：等终止字节 0x40-0x7E
  if (afterEsc.startsWith("]")) return isCompleteOscSequence(data);  // OSC：等 BEL 或 ST
  if (afterEsc.startsWith("P")) return isCompleteDcsSequence(data);  // DCS：等 ESC \
  // ...
}
```

上面代码中，判定完全基于 ANSI 转义序列的语法：CSI 序列（`\x1b[` 开头）以 0x40–0x7E 范围的终止字节收尾，没等到就是不完整。`incomplete` 的数据留在缓冲区，与下一个 data 事件拼接后重判。

你可能会问：如果用户真的只按了一下 Esc 呢？那 `\x1b` 会永远"不完整"。答案是**超时兜底**：10ms 内没有后续字节，缓冲区内容原样吐出。这是"Esc 键"和"转义序列前缀"在字节层无法区分的经典难题，所有终端程序（vim 的 `ttimeoutlen`）都用同一招。

粘贴走独立通道。终端启动时开启了括号粘贴模式（bracketed paste，`\x1b[?2004h`），此后粘贴内容被终端包在 `\x1b[200~ ... \x1b[201~` 之间到达。StdinBuffer 检测到起始标记就切换到"攒粘贴"状态，直到结束标记出现，把**整段内容作为一个 paste 事件**吐出——多长的粘贴都不会被误当成一串按键执行。

## 3. 第二站：按键匹配，不解析

字节序列凑齐了，怎么判断它是不是 `ctrl+c`？pi 的 API 形态值得注意：

```typescript
if (matchesKey(data, "ctrl+c")) { ... }
```

上面代码是**匹配式**而非**解析式**——没有一个 `parseKey(data): KeyEvent` 把字节翻译成规范化按键对象，只有"这段字节是否等于那个键"的谓词。看 `matchesKey` 里 `tab` 的分支感受实现风格：

```typescript
// src/keys.ts · matchesKey，已裁剪
case "tab":
  if (modifier === MODIFIERS.shift) {
    return data === "\x1b[Z"                                    // 遗留序列
      || matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift)   // Kitty 协议
      || matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift); // xterm 扩展
  }
  if (modifier === 0) return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
```

上面代码中，同一个"shift+tab"要认三种编码：遗留终端发 `\x1b[Z`，启用 Kitty 键盘协议的终端发 CSI-u 序列，开了 modifyOtherKeys 的 xterm 发第三种。**每个 case 都是一部终端兼容性血泪史**——比如 `matchesRawBackspace` 的注释：裸的 0x08 字节，在 Windows Terminal 里是 Ctrl+Backspace，在某些 tmux 配置里是普通 Backspace，只能靠环境变量启发式判断。

为什么不做解析式 API？因为**遗留终端的按键编码本质上有歧义**（0x08 就是没法唯一解码），解析式必须硬选一个答案并全局承担错误；匹配式把歧义留在每个具体判断里按上下文处理。代价是不能"列出所有按键"，但 TUI 只需要"这是不是我关心的键"。

Kitty 键盘协议（kitty keyboard protocol）是这团乱麻的现代解法：终端启动时主动探测（发查询序列，看终端是否响应），支持则启用，此后所有按键都以无歧义的 CSI-u 格式编码，还能区分按下/释放。`keys.ts` 用一个全局标志 `_kittyProtocolActive` 记录探测结果，匹配逻辑据此调整（比如 Kitty 激活后 `\x1b\r` 不再是 alt+enter 的猜测，而是确定的 shift+enter 自定义映射）。

## 4. 第三站：分发——一条链，一个焦点

重组好的序列进入 `TuiBase.handleTerminalInput`，分发规则两层：

```typescript
// src/tui.ts · handleTerminalInput，已裁剪
for (const listener of this.inputListeners) {        // 第一层：全局监听器链
  const result = listener(current);
  if (result?.consume) return;                        // 吞掉
  if (result?.data !== undefined) current = result.data;   // 或改写后继续传
}
// ...overlay 焦点修正...
if (this.focusedComponent?.handleInput) {
  if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) return;
  this.focusedComponent.handleInput(data);            // 第二层：唯一焦点组件
  this.requestRender();
}
```

上面代码中：

**(a) 全局监听器可以消费或改写输入。** 返回 `{ consume: true }` 短路整条链——这是应用拦截 ctrl+c 的地方（raw mode 下终端不再发 SIGINT，退出必须自己处理）。返回 `{ data: ... }` 则改写数据继续下传，键位重映射就在这实现。

**(b) 组件层没有冒泡，只有一个焦点。** 任意时刻至多一个 `focusedComponent` 收到输入，没有 DOM 式的捕获/冒泡树。你可能会问：弹窗打开时输入怎么进弹窗？靠**焦点管理而不是事件路由**——`showOverlay` 自动把焦点切给弹窗组件，关闭时还原。tui.ts 里几百行的 `overlayFocusRestore` 状态机全在处理"弹窗叠弹窗、中途有人抢焦点"的还原次序，但分发本身始终是一根直线。

**(c) 输入后无条件 `requestRender()`。** 框架不知道组件内部有没有变化，宁可多请求一帧——反正第 1 节的 diff 会发现"没变化"并零输出。这是差分渲染送的便宜：**上游可以无脑触发，下游负责去重**。

最后注意分发链前面还悄悄截胡了几类数据：终端对各种查询的**响应**（背景色 OSC 11、单元格像素尺寸、配色方案变更通知）也从 stdin 进来，混在用户按键流里。`handleTerminalInput` 开头的几个 `consume*Response` 把它们摘出去。stdin 是复用信道，不只是键盘。

## 5. 设计取舍

- **匹配式 vs 解析式按键 API**：见第 3 节。歧义不可消除时，把决策推迟到最了解上下文的调用点。
- **单焦点 vs 事件冒泡**：冒泡让嵌套组件能协作处理输入，但需要组件树有父子关系——pi 的组件是平铺的行生成器，没有树。单焦点 + 全局监听链覆盖了 TUI 的实际需求（一个输入框 + 少量全局快捷键）。
- **10ms 粘连超时**：太短会把慢速 SSH 连接上的转义序列切碎，太长会让 Esc 键有可感延迟。10ms 是对"本地/低延迟连接"的押注，与 vim 的默认值同量级。

总之，输入管线是三次升维：字节 → 完整序列（语法层）→ 语义按键（协议层）→ 组件动作（应用层）。每层只解决一类脏问题，上层永远不需要知道 `\x1b[Z` 是什么。

## 动手实验

直接观察字节流与匹配结果的对应关系：

```typescript
// scratch-keys.ts —— npx tsx scratch-keys.ts（按各种键，ctrl+c 退出）
import { StdinBuffer } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?2004h");           // 开括号粘贴

const buf = new StdinBuffer();
buf.on("data", (seq: string) => {
  console.log(JSON.stringify(seq), matchesKey(seq, "up") ? "← up" : "");
  if (matchesKey(seq, "ctrl+c")) process.exit(0);
});
buf.on("paste", (text: string) => console.log("PASTE:", JSON.stringify(text)));
process.stdin.on("data", (d) => buf.process(d.toString()));
```

预期：按上方向键打印 `"\u001b[A" ← up`；粘贴多行文本时不会出现一串按键日志，而是一条完整的 `PASTE:`；快速连按 Esc 和上键，观察 `\x1b` 从不被切开误报——这就是重组层在工作。

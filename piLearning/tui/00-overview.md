# 第三章 · 0 packages/tui 总览：不闪烁的终端 UI 是怎么画出来的

> 源码：`packages/tui/src/`，npm 包名 `@earendil-works/pi-tui`
> 位置：本章相对独立——不依赖前两章的 LLM 内容，讲的是 pi 的另一条腿：终端渲染。第四章的交互模式会把本章的组件和第二章的事件流接在一起。规划里本章标注"可略读"，我们只讲最有迁移价值的机制：差分渲染与输入管线。

## 1. 它解决什么问题

一个 coding agent 的界面要在终端里做到：流式文本逐字出现、spinner 转动、编辑框实时响应、弹出选择菜单——同时**不闪烁、不丢终端的回滚历史（scrollback）**。

朴素方案有两个，各有致命伤：

- **每帧清屏重画**（`console.clear()` + 全量输出）：每秒几十次全屏重写，闪烁明显，scrollback 被刷成垃圾。
- **用现成框架**（React + Ink 等）：拿到组件模型，但也拿到虚拟 DOM 和一整套依赖；而且多数框架默认接管备用屏幕（alternate screen），退出后聊天记录从终端里消失——对"对话历史就该留在终端里"的 CLI agent 是体验硬伤。

`pi-tui` 自己写了一个极简框架，核心押注一句话：**UI 是行的数组，渲染是数组的 diff**。

## 2. 组件模型：render 返回字符串行

整个框架的组件接口只有一个必选方法：

```typescript
// src/tui.ts
export interface Component {
  render(width: number): string[];   // 给定宽度，返回若干行
  handleInput?(data: string): void;  // 有焦点时收键盘输入
  invalidate(): void;                // 清空渲染缓存
}
```

上面代码中，`render` 拿到当前终端宽度，返回字符串数组，一个元素一行（可含 ANSI 颜色码）。没有 state、没有 props、没有生命周期——组件想存状态就自己加字段，想触发重画就调 `tui.requestRender()`。

根容器的"合成"也朴素到底：

```typescript
// src/tui.ts · Container.render
render(width: number): string[] {
  const lines: string[] = [];
  for (const child of this.children) {
    for (const line of child.render(width)) lines.push(line);
  }
  return lines;
}
```

上面代码中，所有子组件的行**首尾相接**拼成一个大数组——没有布局引擎，组件从上到下摞起来就是终端的天然排版。弹窗（overlay）是唯一的例外：overlay 的行在 diff **之前**被字符级合成进基础行数组的对应位置（`compositeTuiLine`），所以在 diff 眼里弹窗只是"某几行变了"。

对比 React 系框架：pi 用"行数组"替代虚拟 DOM 作为中间表示。它表达力弱得多（没有细粒度局部更新、没有事件冒泡），但换来的是 diff 退化为字符串数组比较——第 1 节的主角。

## 3. 一次渲染的完整旅程

```
组件调 requestRender()
        │  合并 16ms 内的重复请求（≈60fps 节流）
        ▼
TuiBase.doRender()
        │  render(width) → newLines: string[]     ← 全量重新生成
        │  compositeOverlays()                     ← 弹窗合成
        ▼
与 previousLines 逐行比较，找 [firstChanged, lastChanged]
        │
        ▼
只把变化区间的行写给终端（包在同步输出协议里，原子上屏）
        │
        ▼
previousLines = newLines                           ← 下一帧的比较基准
```

上面的流程有个值得先点破的反差：**生成是全量的，输出是增量的**。每一帧所有组件都重新 render——pi 不做"哪个组件脏了"的追踪；但写给终端的只有变化的行。生成一帧字符串数组是微秒级的（组件内部自带缓存），而终端写出是毫秒级的瓶颈——优化只做在真正贵的那一端。

## 4. 两种屏幕模式

同一个 `TUI` 接口有两个实现，构造时二选一：

| | `TuiMainScreen`（默认） | `TuiAltScreen` |
|---|---|---|
| 画在哪 | 主屏幕缓冲区 | 备用屏幕（alternate screen） |
| scrollback | **保留**，历史自然滚入终端回滚区 | 无，应用自己管理视口滚动 |
| 退出后 | 内容留在终端里 | 恢复主屏幕，补印完整文档 |

pi CLI 默认用 `TuiMainScreen`——"聊天记录留在终端里"是刻意的产品决策。这也是差分渲染最难的地方：主屏幕模式下你不能随意定位光标到"第 3 行"，因为内容可能已经滚出视口；第 1 节会看到为此付出的簿记代价。

## 本章路线

| 节 | 内容 | 对应源码 |
|---|------|---------|
| 1 | 差分渲染：行 diff、同步输出、滚动区之外的行 | `tui.ts`、`TuiMainScreen.ts` |
| 2 | 输入管线：字节流断包、按键匹配、焦点分发 | `stdin-buffer.ts`、`keys.ts`、`terminal.ts` |

编辑器组件（`components/editor.ts`，2000+ 行）是纯应用逻辑（多行编辑、kill-ring、undo），对理解架构增量不大，本章不展开；感兴趣时直接读源码即可。

## 动手实验

30 行跑一个计数器，感受组件模型（在仓库根目录）：

```typescript
// scratch-tui.ts —— npx tsx scratch-tui.ts（按 + / - 增减，ctrl+c 退出）
import { ProcessTerminal, TuiMainScreen, matchesKey, type Component } from "@earendil-works/pi-tui";

class Counter implements Component {
  count = 0;
  render(width: number): string[] {
    return [`count = ${this.count}`, `(按 + / - 修改，ctrl+c 退出)`];
  }
  invalidate(): void {}
}

const tui = new TuiMainScreen(new ProcessTerminal());
const counter = new Counter();
tui.addChild(counter);
tui.addInputListener((data) => {
  if (matchesKey(data, "ctrl+c")) { tui.stop(); process.exit(0); }
  if (data === "+") { counter.count++; tui.requestRender(); }
  if (data === "-") { counter.count--; tui.requestRender(); }
  return { consume: true };
});
tui.start();
```

预期：数字原地变化，屏幕不闪、不滚动。设置环境变量 `PI_DEBUG_REDRAW=1` 再跑，观察 `~/.pi/agent/pi-debug.log`——正常按键**不会**产生 fullRender 日志，只有改变终端宽度时才有，这就是第 1 节要讲的差分路径与全量路径的分界。

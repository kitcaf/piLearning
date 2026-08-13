# 第三章 · 1 差分渲染：为什么屏幕不闪

> 源码：`packages/tui/src/tui.ts`（TuiBase，约 1300 行）、`TuiMainScreen.ts`（约 550 行）、`utils.ts`（visibleWidth）
> 位置：承接总览的"UI 是行的数组"。本节讲从行数组到终端字节的最后一公里，是本章的核心。

## 1. 它解决什么问题

总览说了输出是增量的。但"增量更新终端"有三个前提问题要解决：

1. **什么时候画**——事件驱动的 UI 里，一次按键可能触发五个组件各调一次 `requestRender()`，不能画五次。
2. **画哪里**——终端不是随机访问的画布。主屏幕模式下光标定位只在**当前视口内**有效，已滚出视口的行摸不到。
3. **怎么画不闪**——即使只写几行，终端也可能在写到一半时刷新，让用户看到半成品。

三个问题对应下面三节。

## 2. 节流：合并到 16ms 一帧

`requestRender()` 不直接画，只设一个标志：

```typescript
// src/tui.ts · TuiBase，已裁剪
requestRender(force = false): void {
  if (this.renderRequested) return;          // 已排队，合并
  this.renderRequested = true;
  process.nextTick(() => this.scheduleRender());
}

private scheduleRender(): void {
  const elapsed = performance.now() - this.lastRenderAt;
  const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);   // 16ms
  this.renderTimer = setTimeout(() => {
    this.renderRequested = false;
    this.doRender();
    if (this.renderRequested) this.scheduleRender();   // 画的期间又有请求，续一帧
  }, delay);
}
```

上面代码中，同一个 tick 内的任意多次 `requestRender` 合并成一次；两帧之间强制隔 16ms（约 60fps）。LLM 流式输出每秒可能来几百个 delta 事件，每个都触发 `requestRender`，实际落到终端的只有 60 帧。注意最后一行的自我续期：`doRender` 执行期间若有新请求进来，画完立刻排下一帧，不丢更新。

## 3. 行 diff：找到 [firstChanged, lastChanged]

`TuiMainScreen.doRender` 拿到新行数组后，与上一帧逐行比对：

```typescript
// src/TuiMainScreen.ts · doRender，已裁剪
let firstChanged = -1, lastChanged = -1;
const maxLines = Math.max(newLines.length, this.previousLines.length);
for (let i = 0; i < maxLines; i++) {
  const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
  const newLine = i < newLines.length ? newLines[i] : "";
  if (oldLine !== newLine) {
    if (firstChanged === -1) firstChanged = i;
    lastChanged = i;
  }
}
if (firstChanged === -1) { /* 无变化，只调光标，直接返回 */ }
```

上面代码中，diff 的全部智慧就是**字符串全等比较**——不做行内 diff、不做移动检测（内容插入一行，其后所有行都算"变了"）。你可能会问：这不是很浪费吗？看场景：agent UI 的更新模式几乎总是"底部追加/修改"（流式文本、spinner），头部历史行极少变动。首尾夹逼刚好把不变的头部整段跳过；而"中部插一行"这种最坏情况在此场景里罕见，不值得为它上 LCS 算法。**diff 算法的选择永远是对更新模式的押注**。

定位到区间后，输出只涉及这几行：

```typescript
// src/TuiMainScreen.ts · doRender，已裁剪
const lineDiff = computeLineDiff(moveTargetRow);     // 光标要移动几行
if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;     // 下移
else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;  // 上移
buffer += "\r";
for (let i = firstChanged; i <= renderEnd; i++) {
  if (i > firstChanged) buffer += "\r\n";
  buffer += "\x1b[2K";        // 清除当前行
  buffer += newLines[i];      // 写新内容
}
```

上面代码中，光标用相对移动（`\x1b[nA`/`\x1b[nB`）跳到第一个变化行，然后逐行"清行 + 重写"。这要求框架**精确记账光标现在停在哪一行**（`hardwareCursorRow`）——每次输出后更新，一旦算错，后续所有帧都会画歪。这份簿记正是自己写差分渲染最容易翻车的地方，`doRender` 里大量代码在伺候它。

## 4. 同步输出：不闪的最后一块拼图

即使只写 3 行，终端也可能在你写到第 2 行时刷新屏幕。解决方案是同步输出协议（synchronized output，CSI 2026）：

```typescript
let buffer = "\x1b[?2026h";   // 开始同步：终端暂停刷新
/* ...光标移动、清行、写内容全部攒进 buffer... */
buffer += "\x1b[?2026l";      // 结束同步：一次性原子上屏
this.terminal.write(buffer);
```

上面代码中，整帧的所有终端指令攒在一个字符串里、包在 2026 开关之间、**一次 write** 发出。支持该协议的终端（现代终端基本都支持）会把中间状态完全隐藏，用户只看到帧与帧。不支持的终端把这两个序列当无操作忽略，退化为"大概率不闪"（单次 write 本身就很少被切开）。总之，不闪 = 节流（少画）+ diff（少写）+ 2026（原子上屏），三层各挡一类闪烁来源。

## 5. 边界：什么时候不得不全量重画

差分路径有前提，破了就退回 `fullRender`（清屏重画 + 计数器 `fullRedrawCount` +1）。每个退化条件都值得一句"为什么"：

| 条件 | 为什么救不了 |
|---|---|
| 终端宽度变了 | 所有行的换行位置全变，diff 无意义 |
| 终端高度变了 | 视口对齐关系变了（Termux 例外：软键盘弹出会改高度，全量重画会把整个历史重刷一遍，特判跳过） |
| `firstChanged < viewportTop` | **变化行已滚出视口**——主屏幕模式的光标移动够不着它，只能清屏重来 |
| 内容行数缩水 | 需要清掉屏幕上残留的旧行（可用 `setClearOnShrink` 关掉） |

第三行是主屏幕模式的本质约束：scrollback 是终端的领地，程序写进去就改不了。所以 pi 的组件约定"历史消息一旦定稿就不再变"（第四章会看到聊天记录组件按这个约定设计），把变化压在视口内，`fullRender` 就极少触发。

还有一个防御性设计：写出前检查每行的可见宽度，超过终端宽度直接 crash 并把全部行 dump 到日志：

```typescript
if (!isImage && visibleWidth(line) > width) {
  /* 写 pi-crash.log，stop()，throw */
}
```

上面代码中，宽度超限不是"截断了事"而是**故意崩溃**。因为超宽行会触发终端自动换行，把光标记账全部推错，之后每一帧都画在错误位置——静默容忍等于把一个可定位的组件 bug 变成满屏乱码的灵异现象。快崩快修。

顺带说 `visibleWidth`（`utils.ts`）：终端列宽不等于字符串长度——CJK 占 2 列、emoji 占 2 列、ANSI 转义占 0 列、组合字符占 0 列。pi 用 `Intl.Segmenter` 按字素簇（grapheme cluster）切分逐簇计宽，纯 ASCII 走快路径，结果进 LRU 缓存。这个 300 行的函数是整个渲染正确性的地基。

## 6. 设计取舍

- **全量生成 + 增量输出 vs 脏组件追踪**：脏追踪能省掉每帧的组件 render 调用，但需要组件配合上报变化，框架复杂度陡增。pi 押注"生成便宜、输出贵"，把复杂度留在框架外。
- **主屏幕 vs 备用屏幕**：备用屏幕（`TuiAltScreen`）里视口完全归应用管，没有"滚出视口"问题，差分渲染简单得多；代价是没有 scrollback、退出即消失。pi 默认主屏幕，为产品体验吃下了实现复杂度。
- **行级 diff vs 字符级 diff**：字符级能进一步减少输出量，但需要解析 ANSI 状态机来定位列坐标。行级的 `\x1b[2K` 重写一行最多几百字节，不值得。

## 动手实验

用渲染统计验证 diff 生效。跑总览那个计数器实验前，加一行：

```typescript
setInterval(() => console.error("fullRedraws:", tui.fullRedraws), 3000);
```

预期：连续按 `+` 几十次，stderr 里的 `fullRedraws` 保持 0 或 1（首帧）——所有更新都走了差分路径。然后拖动改变终端窗口宽度，数字立刻 +1。再对照 `PI_DEBUG_REDRAW=1` 的日志看触发原因，与第 5 节的表格一一对应。

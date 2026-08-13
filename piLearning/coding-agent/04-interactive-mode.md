# 第四章 · 4 交互模式：事件流长成组件树

> 源码：`packages/coding-agent/src/modes/interactive/interactive-mode.ts`（约 6000 行）、`modes/interactive/components/`
> 位置：本章主线的收尾，把第二章的事件流和第三章的 TUI 正式接起来（第 5、6 节是两篇专题补充）。6000 行全是 UI 胶水，我们只讲一个贯穿性问题：事件怎么变成屏幕上的东西。

## 1. 它解决什么问题

第二章的事件流是时间序列（`message_start → update ×N → end`），第三章的 TUI 是空间结构（组件自上而下摞成行）。交互模式的本职就是做这个投影：**把时间序列折叠成空间结构**。

投影规则一句话：**每条消息/每次工具调用 = 一个组件，事件驱动组件的创建与更新**。

```
AgentSessionEvent                     chatContainer 的孩子们
─────────────────                     ─────────────────────
message_start (user)          ──▶     + UserMessageComponent
message_start (assistant)     ──▶     + AssistantMessageComponent（流式态）
message_update ×N             ──▶       └ updateContent(partial)   原地更新
  （content 里出现 toolCall）  ──▶     + ToolExecutionComponent（pending）
tool_execution_update         ──▶       └ 更新进度
tool_execution_end            ──▶       └ 定稿（成功/失败/diff 渲染）
message_end                   ──▶       流式组件定稿，不再变
```

## 2. 订阅点：又是那个单一入口

交互模式对 AgentSession 的消费只有一个订阅：

```typescript
// src/modes/interactive/interactive-mode.ts，已裁剪
this.unsubscribe = this.session.subscribe(async (event) => {
  await this.handleEvent(event);
});

private async handleEvent(event: AgentSessionEvent): Promise<void> {
  this.footer.invalidate();
  switch (event.type) {
    case "message_start":
      if (event.message.role === "assistant") {
        this.streamingComponent = new AssistantMessageComponent(...);
        this.chatContainer.addChild(this.streamingComponent);
      } /* user/custom 消息：直接 addMessageToChat */
      break;
    case "message_update":
      this.streamingComponent?.updateContent(event.message, true);
      /* 扫描 content 里新出现的 toolCall，为每个建 ToolExecutionComponent */
      break;
    /* ...tool_execution_*、agent_start/end、queue_update... */
  }
  this.ui.requestRender();
}
```

上面代码中，有三个熟面孔在协作：

**(a) `event.message` 是完整快照。** `updateContent` 每次拿整条 partial 消息重算渲染——不需要自己拼 delta。这是第一章"每个事件带 partial"的设计红利传到了最上层：UI 组件零状态拼接。

**(b) 工具组件在 `message_update` 期间就创建。** 注意不是等 `tool_execution_start`——流式输出中 `content` 数组里一出现 `toolCall` 块就建组件（参数还在逐字生成，靠 `updateArgs` 持续刷新）。用户能看着工具参数被"打出来"，这是把流式协议的 `toolcall_delta` 事件用足了。

**(c) 每个事件结尾 `requestRender()`。** 第三章讲过：请求是廉价的，节流和 diff 在下游兜底。UI 层不用琢磨"这个事件值不值得重画"。

## 3. 定稿即冻结：与差分渲染的合谋

第三章第 1 节留了个伏笔：主屏幕差分渲染要求"滚出视口的行不再变化"，否则触发全量重画。交互模式的组件设计兑现了这个约定：

- `message_end` 后，流式组件定稿（最终 markdown 渲染一次），**此后 render 输出不再变**；
- 组件内部缓存渲染结果（`invalidate()` 才作废），历史消息的 render 调用是数组引用返回；
- 正在变化的东西——流式消息、spinner、编辑框、footer——全部聚在**底部**。

于是行 diff 的"首尾夹逼"每次都只命中底部几行，scrollback 里的历史稳如磐石。**渲染性能不是渲染层单独优化出来的，是 UI 结构配合出来的**。

## 4. 输入侧：从按键到 agent 动作

反方向的管线（第三章第 2 节的延续）：编辑器组件持有焦点，Enter 提交时按当前状态分派——agent 空闲则 `session.prompt(text)`；agent 正忙则进入队列，用户用快捷键选择这条消息是插话（steer）还是追加（followUp），对应第二章第 1 节的两条队列。`queue_update` 事件再把队列状态渲染回编辑框上方的提示区，形成闭环。斜杠命令（`/model`、`/tree`…）在提交前被截获，走命令表而不进对话。

## 5. 设计取舍

- **组件按消息分粒度 vs 整个 transcript 一个组件**：后者每次更新要重排全部历史，且无法做"定稿冻结"。按消息分粒度让缓存边界与不变性边界重合。
- **6000 行单文件**：interactive-mode.ts 大得扎眼。它是所有 UI 关注点（键位、弹窗、主题、队列显示、重试倒计时……）的汇聚点，pi 选择了"一个文件装下一个模式"而不是提前抽象。对读者的启示反而是：**胶水层允许胖，只要核心层保持瘦**——胖的是穷举各种 UI 状态，不是复杂度。

## 动手实验

观察"定稿冻结"与差分渲染的配合。启动交互模式并打开重画日志：

```powershell
$env:PI_DEBUG_REDRAW = "1"
.\pi-test.ps1
```

和 agent 聊几轮（或让它跑几个工具），然后查看 `~/.pi/agent/pi-debug.log`。预期：正常的流式输出、spinner、工具执行期间**没有** fullRender 记录——所有更新都命中差分路径；只有改变终端窗口宽度时出现 `terminal width changed`。这验证了第 3 节的合谋：历史组件不变，变化只在底部。

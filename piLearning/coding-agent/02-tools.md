# 第四章 · 2 内置工具：edit 的匹配术与输出的截断术

> 源码：`packages/coding-agent/src/core/tools/`（edit.ts、edit-diff.ts、truncate.ts、output-accumulator.ts、bash.ts）、`core/bash-executor.ts`
> 位置：承接第 1 节。工具是 agent 的手脚；本节挑三个最有含金量的机制：edit 的模糊匹配、所有工具共享的截断保护、bash 的溢出落盘。read/grep/find/ls 结构类似，不逐个讲。

## 1. 它解决什么问题

工具的接口第二章已经定了（`AgentTool.execute`），难的不是接上，而是两类现实问题：

- **模型的输出不完美**：让模型改文件，它给出的"原文"经常和磁盘上的差一点——尾随空格、智能引号、CRLF。严格匹配会让一半的 edit 失败，模型陷入"读文件→再试→再失败"的循环，烧 token 又烧耐心。
- **现实世界的输出无上限**：`cat` 一个 100MB 日志、跑一个刷屏的测试，如果原样塞进 toolResult，一次就撑爆上下文窗口。

两类问题的共同本质：**工具是 LLM 与现实的边界，边界上必须做阻抗匹配**。

## 2. edit：先严格，再模糊，绝不多义

edit 工具的输入是 `{ path, edits: [{ oldText, newText }] }`——**精确文本替换**，不是行号也不是 diff。为什么选这个形态？行号在模型的想象中经常漂移（它看到的是几轮之前的文件），diff 格式模型写不稳。"引用一段原文"是模型最不容易出错的定位方式。

匹配算法是两级降级：

```typescript
// src/core/tools/edit-diff.ts · fuzzyFindText，已裁剪
const exactIndex = content.indexOf(oldText);        // 第一级：严格匹配
if (exactIndex !== -1) return { found: true, index: exactIndex, usedFuzzyMatch: false, ... };

const fuzzyContent = normalizeForFuzzyMatch(content);   // 第二级：归一化后再匹配
const fuzzyOldText = normalizeForFuzzyMatch(oldText);
const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
```

上面代码中，第二级把**双方**都做同一套归一化再找。归一化名单（`normalizeForFuzzyMatch`）每一项都对应模型的一种高频笔误：

```typescript
text.normalize("NFKC")
  .split("\n").map(line => line.trimEnd()).join("\n")   // 尾随空格
  .replace(/[\u2018\u2019...]/g, "'")                   // 智能引号 → ASCII
  .replace(/[\u2010\u2011\u2013\u2014...]/g, "-")       // 各式连字符 → -
  .replace(/[\u00A0\u2002-\u200A...]/g, " ")            // 特殊空格 → 普通空格
```

上面的清单是经验的结晶：模型从训练数据里学来了排版字符（en-dash、NBSP、curly quotes），复述代码时会"顺手美化"。归一化让这些美化不再致命。

两条铁律托底，防止模糊匹配变成灾难：

- **唯一性**：`oldText` 在文件中（归一化后）出现不止一次就报错，绝不猜是哪一处。错误消息会告诉模型"出现了 N 次，请加上下文"。
- **写回保真**：模糊匹配是在归一化空间里算出的替换，直接写回会把全文件的引号连字符都改掉。`applyReplacementsPreservingUnchangedLines` 用行对齐把**未改动的行原样复制回来**，只有真正被编辑的行采用归一化版本。文件的 CRLF/BOM 也被检测并还原（`detectLineEnding`/`stripBom`）。

你可能会问：为什么不用编辑距离做更聪明的模糊匹配？因为"聪明"不可解释——编辑距离匹配到错误位置时，模型和用户都无法理解为什么。归一化表是白名单，每一项都能说出"宽恕的是哪种笔误"，匹配错误的概率可控。**在改用户文件这件事上，可预测比聪明重要**。

另外注意 `prepareEditArguments`（`edit.ts`）：有的模型把 `edits` 数组发成 JSON 字符串、有的还在用旧版 `oldText/newText` 顶层字段——这个第二章讲过的 `prepareArguments` 钩子在 schema 校验前做兼容整形。对模型缺陷的宽容也是工具设计的一部分。

## 3. 截断：行与字节双限，绝不切半行

所有工具输出经过 `truncate.ts` 的统一约束：

```typescript
// src/core/tools/truncate.ts
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;   // 50KB
```

上面代码中，**行数和字节数双限，先到者生效**。为什么要两个？只限行数：单行 1MB 的压缩 JS 就能击穿；只限字节：5 万行短日志的行数噪声一样有害。两个维度各挡一类极端输入。

两个方向的截断服务不同的工具：`truncateHead`（保留开头）给 read——文件开头通常是 import 和定义，信息密度高；`truncateTail`（保留结尾）给 bash——命令输出的结尾是错误信息和退出状态，恰是模型最需要的。**截哪头取决于信息藏在哪头**，没有统一答案。

还有一条不起眼的规则写在文件头注释里：*Never returns partial lines*。截断永远对齐行边界。半行 JSON、半行代码会诱导模型对残缺内容做出错误推断——宁可少给一行，不给半行。

## 4. bash：流式、落盘、可远程

bash 是最重的工具，`bash-executor.ts` 处理三个现实问题：

**输出溢出落盘。** 输出超过阈值时不是简单丢弃，而是开一个临时文件持续接收全量输出：

```typescript
// src/core/bash-executor.ts · executeBashWithOperations，已裁剪
const ensureTempFile = () => {
  if (tempFilePath) return;
  tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
  tempFileStream = createWriteStream(tempFilePath);
  for (const chunk of outputChunks) tempFileStream.write(chunk);  // 已有的先补写
};
```

上面代码中，返回给模型的是截断后的尾部 + 一行"完整输出在 `/tmp/pi-bash-xxx.log`"。模型拿到路径后可以自己决定用 grep/read 去翻完整输出——**截断不销毁信息，只是把信息移到模型够得着的地方**。这比"[输出被截断]"的死胡同好一个数量级。

**输出消毒。** ANSI 转义被剥掉（`stripAnsi`）、二进制垃圾被替换（`sanitizeBinaryOutput`）——彩色输出的转义序列对模型是纯噪声 token。

**操作可插拔。** 执行接口抽象成 `BashOperations`（spawn/kill 的最小集合），edit/read 同理抽象了 `EditOperations`/文件读写。默认实现是本地进程和本地文件系统；换一套 operations，同一个工具就跑在 SSH 或容器里。工具逻辑（参数、截断、渲染）与执行位置解耦——`examples/extensions/sandbox` 就靠这个口子实现容器沙箱。

顺带一提 `file-mutation-queue.ts`：同一文件路径上的写操作（edit/write）会被串行化排队。第二章讲过并行工具执行——两个 edit 并发改同一个文件就是竞态，这个按路径分桶的队列在工具层把它消掉。

## 5. 设计取舍

- **精确文本替换 vs 行号/diff 格式**：见第 2 节。选择接口形态时优先考虑"模型最不容易错"而非"机器最好处理"。
- **归一化白名单 vs 编辑距离**：可解释性压倒匹配率。
- **落盘 vs 纯截断**：多一个临时文件的代价，换"模型可以自助翻旧账"的能力。临时文件由系统 tmpdir 生命周期兜底清理。
- **双限截断的默认值（2000 行 / 50KB）**：偏保守。上下文窗口在涨，这两个数将来可能显得小气，但撑爆上下文的事故成本远高于多一轮"再读一段"。

总之，内置工具的每一个设计都在回答同一个问题：**模型会怎么出错、现实会怎么失控，边界上如何让两边都活下来**。这是写任何 agent 工具都带得走的心法。

## 动手实验

不启动 agent，直接单测感受模糊匹配的边界：

```typescript
// scratch-edit.ts —— npx tsx scratch-edit.ts（在仓库根目录）
import { fuzzyFindText, normalizeForFuzzyMatch } from "./packages/coding-agent/src/core/tools/edit-diff.ts";

const file = `const msg = "hello";   \nconsole.log(msg);\n`;   // 注意行尾空格
console.log(fuzzyFindText(file, `const msg = "hello";`));      // 尾随空格 → fuzzy 命中
console.log(fuzzyFindText(file, `const msg = \u201chello\u201d;`)); // 智能引号 → fuzzy 命中
console.log(fuzzyFindText(file, `const msg = 'hello';`));      // 单引号 ≠ 双引号 → 不命中
```

预期：前两个返回 `found: true, usedFuzzyMatch: true`，第三个 `found: false`——归一化宽恕排版差异，但不宽恕语义差异（单双引号在代码里是不同的东西）。对照 `normalizeForFuzzyMatch` 的白名单验证每一条。

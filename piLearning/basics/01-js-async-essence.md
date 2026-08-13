# 01 · 看透 JS 异步：Promise、Generator 与 async/await 的同一件事

> 定位：本文是 `learning/` 系列的**前置知识**，不涉及 pi 源码。
> 读完再看 [ai/01-types-and-stream.md](../ai/01-types-and-stream.md) 的 `EventStream`、[agent/01-agent-loop.md](../agent/01-agent-loop.md) 的核心循环会顺畅很多——它们把本文的三样东西全用上了。

学 JS 异步的人通常有两种状态：会用，但一遇到嵌套/时序题就懵；或者背下了"微任务宏任务"，但说不清它们为什么存在。

本文走另一条路：**从一条物理事实出发，把 Promise、Generator、async/await 逐层推导出来**。推导完之后，它们会变成推论，而不是需要记忆的特例。

## 目录

1. [唯一的地基](#一唯一的地基函数一旦开始跑就不能被打断)
2. [Promise 的本质](#二promise-的本质它不是异步操作是状态机--回调登记簿)
3. [`then` 的三条公式](#三then-的三条公式能推导-90-的时序题)
4. [Generator：与异步无关的独立发明](#四generator一个与异步毫无关系的独立发明)
5. [核心：async/await = Generator + 自动驾驶仪](#五核心asyncawait--generator--自动驾驶仪)
6. [四个通用心智工具](#六四个通用心智工具)
7. [用模型解释常见困惑](#七用上面的模型解释所有常见困惑)
8. [Promise 做不到的三件事](#八看清边界promise-做不到的三件事)
9. [动手实验](#九动手实验)

---

## 一、唯一的地基：函数一旦开始跑，就不能被打断

整个 JS 异步体系，只建立在这一条物理事实上：

> **单线程 + 运行到完成（run-to-completion）。任何函数开始执行后，没有任何力量能中途暂停它去跑别的代码。**

推论直接就来了：

- 既然不能"暂停等结果"，那想要在未来做事，唯一的办法是**把一个函数交给别人，让别人在未来调用它**。
- 这个"别人"就是事件循环。所谓的队列，只是**存放待调用函数的地方**。

所以：**JS 里不存在真正的"异步函数"，只存在"现在注册、将来被调用的普通函数"。** Promise、await、生成器，全部是这件事的语法包装。

记住这句话，后面所有东西都是它的变形。

---

## 二、Promise 的本质：它不是"异步操作"，是状态机 + 回调登记簿

这是最大的认知障碍。大多数人以为 `Promise` 代表"一件正在进行的异步任务"。**不是。** Promise 对异步操作一无所知，它只是个盒子：

```
Promise = { 状态, 值, 回调列表 }

状态: pending ──→ fulfilled(value)
              └─→ rejected(reason)
```

三条铁律：

1. **单向、一次性**。settle 之后永久冻结，再调 `resolve` 无效。
2. **`then(f)` = 往登记簿里记一笔**。如果已经 settle 了，就直接把 `f` 丢进微任务队列；如果还 pending，就存起来等 settle 时再丢。
3. **回调永远异步执行**。哪怕 Promise 已经 settle，`then` 里的函数也绝不同步跑。这是为了消除"有时同步有时异步"的时序不确定性（著名的 Zalgo 问题）。

你完全可以自己实现一个能用的版本，只有二十几行：

```js
class MyPromise {
    constructor(executor) {
        this.state = 'pending';
        this.value = undefined;
        this.callbacks = [];
        const settle = (state) => (value) => {
            if (this.state !== 'pending') return;    // 铁律1: 一次性
            this.state = state;
            this.value = value;
            this.callbacks.forEach(queueMicrotask);  // 铁律3: 异步
            this.callbacks = [];
        };
        executor(settle('fulfilled'), settle('rejected'));  // 注意: 同步调用!
    }

    then(onFulfilled) {
        return new MyPromise((resolve) => {
            const job = () => resolve(onFulfilled(this.value));
            if (this.state === 'pending') this.callbacks.push(job);  // 铁律2
            else queueMicrotask(job);
        });
    }
}
```

上面代码中，**整个类里没有任何"异步"的东西**——没有定时器、没有 IO、没有线程。`executor` 甚至是在构造函数里**同步调用**的。异步性完全来自外部：谁调 `resolve`、什么时候调。

> **Promise 的价值不在于"让代码异步"，而在于把"回调登记"这件事标准化，使它可以被组合。**

---

## 三、`then` 的三条公式（能推导 90% 的时序题）

`p.then(f)` 返回**一个新 Promise** `p2`，`p2` 的命运由 `f` 的返回值决定：

| `f` 的返回值 | `p2` 的结果 | 额外开销 |
| --- | --- | --- |
| 普通值 `v` | fulfilled(v) | 0 tick |
| 抛异常 `e` | rejected(e) | 0 tick |
| 另一个 Promise `q` | **"认领" q，q 是什么它是什么** | **+2 tick** |

第三条是精髓，也是"链式调用能自动展平"的原因，更是那些经典面试题答案错位的根源：**认领一个 Promise 需要引擎内部再挂两次 `then`，所以多花两个微任务 tick。**

有了这三条，`then` 就不再是"注册回调"这么简单了，它是**函数组合的运算符**：

```js
// 同步世界
const r = h(g(f(x)));

// 异步世界 —— 结构完全同构
p.then(f).then(g).then(h);
```

上面代码中，两种写法的**结合结构完全一致**，只是求值时机不同。这就是重点：

> **Promise 真正解决的不是"回调地狱"的缩进问题，而是让异步操作重新获得了"可组合性"。**

回调风格下你写不出 `Promise.all` 这种东西——因为裸回调没有统一的返回值可供组合。

---

## 四、Generator：一个与异步毫无关系的独立发明

先把异步彻底忘掉。生成器解决的是另一个问题：**如何造一个可以暂停、并且保留现场的函数。**

```js
function* g() {
    let x = 1;
    const y = yield x;   // 暂停,吐出 x; 恢复时,把外面传进来的值赋给 y
    return x + y;
}

const it = g();
it.next();     // { value: 1, done: false }  —— 停在 yield
it.next(10);   // { value: 11, done: true }  —— y = 10, 继续跑完
```

上面代码中，两个必须看清的点：

1. **`yield` 是双向的**。往外吐 `value`，往内收 `next(arg)` 的参数。注意 `it.next(10)` 里的 `10` 变成了 `y` 的值——**这是它能被改造成 `await` 的唯一原因**。
2. **生成器自己不会动**。它是被 `next()` 一格一格推着走的。没人调 `next`，它就永远冻在那里。

一句话：**生成器把函数的执行过程变成了一个可以外部控制的对象。**

---

## 五、核心：async/await = Generator + 自动驾驶仪

现在把两半拼起来。这是"看透"的关键一步。

假设有个函数，它接收生成器，并且**自动帮你调 `next`**：每当生成器 `yield` 出一个 Promise，它就等这个 Promise 完成，然后把结果通过 `next(值)` 送回去：

```js
function run(genFn) {
    const it = genFn();
    return new Promise((resolve, reject) => {
        function step(method, arg) {
            let r;
            try { r = it[method](arg); }          // 推进一格
            catch (e) { return reject(e); }
            if (r.done) return resolve(r.value);  // 跑完了
            Promise.resolve(r.value).then(
                v => step('next',  v),            // 成功 → 把值送回 yield 处
                e => step('throw', e)             // 失败 → 在 yield 处抛异常
            );
        }
        step('next');
    });
}
```

上面代码中，`step` 是一个**自我驱动的循环**：推进生成器一格，拿到 `yield` 出来的 Promise，挂上 `then`，等它完成后再调用自己推进下一格。于是你可以这么写：

```js
run(function* () {
    const a = yield fetch('/a');   // 看起来就像 await
    const b = yield fetch('/b');
    return a + b;
});
```

**`async/await` 就是这个东西被塞进了语言里。** 严格对应关系：

| 语法糖 | 脱糖后 |
| --- | --- |
| `async function` | `run(function* () { ... })` |
| `await X` | `yield X`（由 `run` 负责等待并回送） |
| `await` 的返回值 | `next(v)` 传回来的 `v` |
| `try/catch` 抓到异步错误 | `it.throw(e)` 在 `yield` 处抛出 |
| async 函数的返回值 | `run` 返回的那个 Promise |

Babel 的 regenerator 编译出来的东西，和这段代码在结构上是一模一样的。

至此三者的关系彻底清楚了：

```
Generator    提供「暂停 / 恢复的能力」
Promise      提供「什么时候该恢复的信号」
async/await  提供「自动把两者接起来的驾驶员」
```

任何一个单独拿出来都不够：**生成器不知道何时该继续，Promise 不能暂停函数。**

---

## 六、四个通用心智工具

### 工具 1：切割法 —— 见到 `await` 就画一刀

这是读任何 async 代码的第一动作：

```js
async function f() {
    const a = 1;
    // ────────────────── 刀
    const b = await g();
    // ────────────────── 刀
    console.log(a + b);
}
```

每一刀之间是一段同步代码，**一定完整跑完不会被打断**。刀口处函数 `return` 走人，后半段变成登记在 Promise 上的回调。

由此立刻推出两个常被问的结论：

- **`async` 函数体在第一个 `await` 之前是同步执行的**，不是"整个丢到后台"。
- **刀口是唯一可能发生"世界变了"的地方**。`await` 前后，任何共享状态（`this.x`、全局变量、DOM）都可能已被其他任务改过。async 代码的竞态 bug 全部诞生在刀口上。

### 工具 2：三问法 —— 读任何异步代码都问这三句

1. **谁来 resolve 它？** 找到那个触发源（定时器、IO 回调、或某段代码手里攥着的 `resolve` 函数）。找不到 = 这个 Promise 永远不会完成。
2. **它是什么时候"开始"的？** 见工具 3。
3. **刀口之后那段代码，被登记到哪里去了？** 这就是 continuation，是理解控制流走向的关键。

### 工具 3：Promise 是**热的**，不是懒的

极其常见的误解。看这两段的区别：

```js
// A: 并发。两个 fetch 在同一时刻就发出去了
const p1 = fetch('/a');   // ← 请求此刻已发出
const p2 = fetch('/b');   // ← 请求此刻已发出
await p1; await p2;       // 总耗时 = max(a, b)

// B: 串行
await fetch('/a');
await fetch('/b');        // 总耗时 = a + b
```

上面代码中，A 和 B 的区别不在 `await`，而在 **Promise 是什么时候被创建的**。因为 executor 同步执行，**`new` 的那一刻操作就已启动**，`await` 只是"去取结果"。

这一点上 JS 和 Rust / C# 不同：Rust 的 `Future` 是**冷的**，不 poll 就不动；JS 的 Promise 是**热的**，创建即启动。

由此得出黄金法则：**先集中创建所有 Promise，再统一 await。**

```js
const results = await Promise.all(items.map(fetchOne));   // 并发
for (const i of items) await fetchOne(i);                 // 串行(常见性能坑)
```

### 工具 4：`async` 是一种"函数颜色"，且会传染

```
一旦某个函数变成 async, 它的返回值就是 Promise
→ 调用它的人必须 await
→ 于是调用者也得是 async
→ 一路传染到调用链顶端
```

顶端必须有个"不 await 的人"来兜底（`main().catch(...)`、事件处理器、框架入口）。这就是所谓的**函数颜色问题**（function coloring）——也是 Go 的 goroutine 被认为更优雅的地方（它没有颜色）。

理解这点后，你就知道**为什么不能在同步函数里"等一下"异步结果**——这不是 API 设计不好，是单线程模型的物理限制。

---

## 七、用上面的模型解释所有常见困惑

| 困惑 | 用模型解释 |
| --- | --- |
| `forEach(async x => await f(x))` 为什么不等待 | `forEach` 是同步函数，它只是调用了回调、拿到一堆 Promise 然后**丢掉**。改用 `for...of` 或 `Promise.all(map(...))` |
| 为什么 `try/catch` 能抓到 await 的错 | 驾驶员用 `it.throw(e)` 在 `yield` 那一行**原地抛出**，所以词法上的 try 块自然能抓到 |
| 忘记 await 为什么错误变成 unhandledRejection | 没人给这个 Promise 登记 reject 回调，**登记簿是空的**，错误无处可去 |
| 为什么 `await` 一个非 Promise 也要等一 tick | `await v` ≈ `Promise.resolve(v).then(...)`，then 回调必然进微任务（铁律 3） |
| async/await 和 `.then` 的执行顺序为什么会错位 | 见第三节那张表：`then` 里返回 Promise 需要"认领"，多花 2 tick |
| 微任务 / 宏任务到底是什么 | 它们只是**存放"待恢复的函数"的容器**。微任务 = 由 Promise 产生的恢复点，优先级高、必须一次清空；宏任务 = 外部事件产生的入口点 |
| 为什么 Promise 不能取消 | 因为它是**结果的容器**，不是**操作的句柄**。容器不持有操作的引用。要取消得靠外部的 `AbortController` |

---

## 八、看清边界：Promise 做不到的三件事

知道一个抽象的能力边界，比知道它的用法更能"看透"它。

| 需求 | Promise 为何不行 | 正确工具 |
| --- | --- | --- |
| 多个值 / 持续推送 | Promise 是**一次性单值** | `AsyncIterator`、`EventTarget`、Observable |
| 取消 | 它只是结果容器，不持有操作 | `AbortController` |
| 重试 / 复用 | settle 后永久冻结，无法重跑 | 包一层函数（`() => fetch(...)`）；**Promise 是值，函数才是操作** |

最后一条特别有用：**需要"可重复执行"时，传函数；需要"共享同一次结果"时，传 Promise。**

第一条正是 pi 里 `EventStream` 存在的理由——LLM 流式输出是"持续推送的多个值"，Promise 表达不了，所以要用 `AsyncIterator`。详见 [ai/01-types-and-stream.md](../ai/01-types-and-stream.md)。

---

## 九、动手实验

打开任意 Node REPL 或浏览器控制台，逐题预测输出再运行验证。**能秒答这四题，说明模型已经建立。**

```js
// 题1: async 函数体在第一个 await 之前是同步的
async function f() { console.log(2); await null; console.log(4); }
console.log(1); f(); console.log(3);
// 预期: 1 2 3 4
```

```js
// 题2: executor 同步执行 —— Promise 是热的
const p = new Promise(r => { console.log('A'); r(); });
console.log('B');
// 预期: A B
```

```js
// 题3: 登记簿为空则错误无处可去
async function g() { throw 1; }
g();                      // unhandledRejection
g().catch(() => {});      // 没事
```

```js
// 题4: 并发 vs 串行
const sleep = ms => new Promise(r => setTimeout(r, ms));
console.time('a'); await Promise.all([sleep(1000), sleep(1000)]); console.timeEnd('a'); // ≈1000ms
console.time('b'); await sleep(1000); await sleep(1000);         console.timeEnd('b'); // ≈2000ms
```

**进阶实验**：把第五节的 `run` 函数复制到控制台，用它跑一个 `function*`，然后把同样的逻辑写成 `async/await`，对比两者行为是否完全一致。跑通之后，async/await 对你就不再有任何神秘感。

---

## 一句话总结

> **JS 没有异步函数，只有"被切成若干段的同步函数"，和一套决定"下一段什么时候跑"的调度机制。**
>
> `Promise` 是那套调度机制的标准接口（值的容器 + 回调登记簿），`Generator` 提供切割与恢复的能力，`async/await` 是把两者自动焊接起来的语法糖。

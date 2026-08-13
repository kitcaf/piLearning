# 第一章 · 2 Models、Provider 与认证解析链

> 源码：`packages/ai/src/models.ts`（约 700 行）、`auth/types.ts`、`auth/resolve.ts`
> 位置：承接第 1 节的类型地基。本节讲中间两层——请求到达协议适配器（第 3 节）之前，要先经过"注册表"和"认证"这两道关。

## 1. 它解决什么问题

有了统一类型，还差两件事才能发出一个请求：

1. **找到模型**：运行时手里只有 `"anthropic"` 和 `"claude-sonnet-4-6"` 两个字符串，需要查出完整的 `Model` 对象（价格、窗口、协议、compat 标志）
2. **找到凭证**：这家厂商的 API key 在哪？环境变量？存储的凭证文件?OAuth token 要不要刷新？

朴素方案是全局单例：一个全局模型表、启动时读一遍环境变量。pi 没有全局状态——一切装进一个可显式构造的 `Models` 集合，凭证存储、环境访问全部是可注入接口。这让同一份代码能跑在 CLI（凭证在 `~/.pi/auth.json`）、测试（凭证在内存）、浏览器（没有环境变量）三种环境里。

## 2. 主干：一次 streamSimple 的完整路径

先看全貌。调用 `models.streamSimple(model, context, options)` 后发生什么：

```
models.streamSimple(model, context, options)
  └─ lazyStream(model, async () => {          ← 同步返回流，以下都在背后异步执行
       provider = this.providers.get(model.provider)     ① 查注册表
       resolution = await this.getAuth(model, ...)       ② 解析认证（可能刷新 OAuth）
       requestOptions = { ...options, apiKey, headers }  ③ 把凭证织入请求选项
       return provider.streamSimple(requestModel, context, requestOptions)
     })                                                   ④ 交给 provider → 协议适配器
```

上面流程中，`Models` 层做的事就是 ①②③——它自己不发任何 HTTP 请求。用一句话概括分工：**Models 管"用哪个 key、调谁"，Provider 管"有哪些模型"，Api 管"怎么发请求"**。

`Models` 本体（`ModelsImpl`）核心只是一个 `Map<string, Provider>` 加上认证逻辑：

```typescript
class ModelsImpl implements MutableModels {
  private providers = new Map<string, Provider>();
  private credentials: CredentialStore;   // 可注入：凭证存哪
  private authContext: AuthContext;       // 可注入：怎么读环境变量/文件

  setProvider(provider: Provider): void { this.providers.set(provider.id, provider); }
  getModel(provider: string, id: string): Model | undefined { ... }
  ...
}
```

上面代码中，两个可注入接口值得注意：`CredentialStore`（读写凭证）和 `AuthContext`（`env(name)` 和 `fileExists(path)` 两个方法）。测试时注入内存实现，浏览器里注入"永远返回 undefined"的实现——认证逻辑本身一行不用改。

## 3. createProvider：用一个工厂消灭 30 个类

30 多家厂商如果各写一个 Provider 类，会有 30 份雷同的样板。pi 用**单一工厂函数** `createProvider` 收编一切——内置厂商和用户自定义厂商（models.json）走同一个入口：

```typescript
export function createProvider<TApi>(input: {
  id: string;
  auth: ProviderAuth;                    // 必填：认证语义（见第 4 节）
  models: readonly Model<TApi>[];        // 静态模型目录
  fetchModels?: (ctx) => Promise<...>;   // 可选：动态拉取模型清单
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;  // 单协议或多协议
}): Provider<TApi>
```

两个设计点：

**(a) 静态目录 + 动态覆盖（overlay）。** 多数厂商的模型清单是生成的静态数据；但 OpenRouter、Copilot 这类聚合商的清单每天在变。`createProvider` 内部维护两个数组并按 id 合并，动态项覆盖同名静态项：

```typescript
const currentModels = () => {
  const merged = [...baselineModels];
  for (const model of dynamicModels) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index >= 0) merged[index] = model;   // 覆盖
    else merged.push(model);                 // 追加
  }
  return merged;
};
```

上面代码中，`getModels()` 永远同步返回"最后已知"清单——刷新（`refreshModels`）是独立的异步动作，失败时保留旧清单。**读永远可用，写才可能失败**，UI 因此不需要处理"模型列表加载中"状态。

**(b) api 字段支持"单协议"或"按 model.api 分发的映射"。** OpenAI 一家就同时有 completions 和 responses 两种协议的模型，所以 provider 可以传 `{ "openai-completions": implA, "openai-responses": implB }`，分发在流启动时按 `model.api` 查表。查不到怎么办？

```typescript
if (!streams) {
  return lazyStream(model, async () => {
    throw new ModelsError("stream", `Provider ${input.id} has no API implementation ...`);
  });
}
```

上面代码里没有直接 throw——又是那个契约：配置错误也编码成流内 error 事件。

## 4. 认证：一条声明式的解析链

认证是本节含金量最高的部分。每个 provider 声明自己的认证语义（`ProviderAuth`），核心是一个 `resolve` 函数——**"按什么优先级、从哪些地方找凭证"被写成数据附在厂商档案上**，而不是散落在启动代码里：

```typescript
// providers/anthropic.ts 的真实解析链（节选）
resolve: async ({ ctx, credential }) => {
  if (credential?.key)                       // ① 存储的凭证（用户 login 过）
    return { auth: { apiKey: credential.key }, source: "stored credential" };
  const authToken = await ctx.env("ANTHROPIC_AUTH_TOKEN");
  if (authToken)                             // ② 环境变量（Bearer 头形式）
    return { auth: { headers: { Authorization: `Bearer ${authToken}` } }, source: "..." };
  for (const envVar of ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    const apiKey = await ctx.env(envVar);    // ③ 环境变量（key 形式）
    if (apiKey) return { auth: { apiKey }, source: envVar };
  }
  return undefined;                          // ④ 没配置——不是错误，是状态
},
```

上面代码有两个易忽略的好设计：

- 返回值带 **`source` 字段**（"stored credential"、"ANTHROPIC_API_KEY"）——不是给机器的，是给人的。CLI 的模型列表能告诉你"这个 key 是从哪来的"，排查"为什么用了错的 key"时价值巨大。
- 解析结果是 `ModelAuth { apiKey?, headers?, baseUrl? }` 三件套。注释里有句定义边界的话："如果一个值不能表达为这三者之一，它就是 provider 配置，不是认证"。清晰的边界让 30 家厂商的千奇百怪认证（AWS SigV4、Cloudflare 账户 id、Azure 资源名）都找到了自己的位置。

### OAuth 刷新的并发安全

OAuth token 会过期，过期要刷新，而刷新有个经典坑：**两个并发请求同时发现 token 过期，同时去刷新，第二次刷新用已被轮换（rotate）的 refresh token，直接把凭证刷废**。

pi 的防线在 `CredentialStore` 接口的设计上——`modify` 是唯一写路径，且是串行化的读-改-写：

```typescript
interface CredentialStore {
  read(providerId): Promise<Credential | undefined>;
  /** 唯一写路径。fn 看到的是当前值；按 provider 串行互斥（跨进程也是，若后端支持文件锁）。 */
  modify(providerId, fn: (current) => Promise<Credential | undefined>): Promise<...>;
}
```

刷新逻辑跑在 `modify` **里面**，并在拿到锁后二次检查：

```typescript
const post = await this.credentials.modify(provider.id, async (current) => {
  if (current?.type !== "oauth" || Date.now() < current.expires) return undefined;
  // ↑ 拿到锁后重查：别的请求可能已经刷新过了，直接放弃本次刷新
  return oauth.refresh(current, signal);
});
```

上面代码中，`Date.now() < current.expires` 的二次检查就是双检锁（double-checked locking）模式：第一个请求刷新完成后，排队的第二个请求进入 `modify` 时看到的 `current` 已是新 token、未过期，返回 undefined 表示"不改"。并发刷新被结构性地消灭了，而不是靠调用方自觉。

## 5. 用量计价：连缓存分层都算清楚

`Model.cost` 携带每百万 token 的四种单价（input/output/cacheRead/cacheWrite），`calculateCost` 在每次响应后把 usage 换算成美元。看似简单的乘法里藏着两个真实世界的复杂度：

```typescript
export function calculateCost(model, usage) {
  // ① 阶梯计价：某些模型超过阈值后全请求按更高档计费
  let rates = model.cost;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && ...) rates = tier;
  }
  // ② Anthropic 的 1 小时缓存写入按基础输入价的 2 倍计
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1e6;
  ...
}
```

上面代码的价值不在实现，在态度：**成本核算精确到厂商的计价细则**。agent 是烧钱的东西，pi 把"这次对话花了多少钱"做成了每条 AssistantMessage 自带的一等数据（`usage.cost.total`），UI 的实时花费显示、会话统计都建立在这之上。

## 6. 设计取舍

- **无全局状态**的代价是使用前要显式装配（`createModels()` + 逐个 `setProvider`）。pi 用上层的 `providers/all.ts` 和 coding-agent 的默认装配缓解，但保留了测试和多实例的自由。
- **`getAuth` 每次请求都跑解析链**（而不是缓存结果），多几次环境变量读取，换来 OAuth token 热轮换和"改了环境变量立即生效"。
- 认证边界收窄为 `apiKey/headers/baseUrl` 三件套，个别厂商（Bedrock 的 SigV4 签名）只能在适配器内部另辟通道——这是抽象故意不覆盖的 20%。

总之，Models 层的本质是**两张表加一条链**：provider 注册表、模型目录表、声明式认证解析链。它把"选谁、用什么身份"从请求路径里剥离成纯数据问题。

## 动手实验

验证认证解析链的优先级和 `source` 标签（不发真实请求）：

```typescript
// npx tsx scratch.ts
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

process.env.ANTHROPIC_API_KEY = "sk-test-fake";
const models = createModels();
models.setProvider(anthropicProvider());
console.log(await models.getAuth("anthropic"));
// 预期: { auth: { apiKey: 'sk-test-fake' }, source: 'ANTHROPIC_API_KEY' }
delete process.env.ANTHROPIC_API_KEY;
console.log(await models.getAuth("anthropic"));
// 预期: undefined （未配置不是错误，是状态）
```

再设置 `ANTHROPIC_AUTH_TOKEN` 观察它优先于 `ANTHROPIC_API_KEY`，对照 `providers/anthropic.ts` 里 resolve 的顺序。

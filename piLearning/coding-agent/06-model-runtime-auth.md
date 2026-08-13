# 第四章 · 6 ModelRuntime 与认证落地：库层解析链的产品化

> 源码：`packages/coding-agent/src/core/model-runtime.ts`（约 600 行）、`core/auth-storage.ts`、`core/runtime-credentials.ts`、`core/provider-composer.ts`（概览）
> 位置：第一章第 2 节讲了 pi-ai 库层的认证解析链（环境变量 → 凭证存储 → OAuth）；本节看产品层怎么给这条链配上真实的存储、并发保护和用户配置。选读——不影响主线理解，但覆盖了"多进程共享凭证"这个高频工程问题。

## 1. 它解决什么问题

库层的 `Models` 把凭证存储抽象成 `CredentialStore` 接口就撒手了。产品要落实四件事：

- 凭证**存哪**、怎么防止被其他用户读走
- 三个 pi 进程同时跑（交互 + server 的两个实例），同时刷新同一个 OAuth token 会怎样
- 用户在 `models.json` 里配的自定义厂商、改写的 baseUrl，怎么和内置厂商目录合成
- "当前哪些模型可用"这个 UI 问题（模型选择器只该列出配了 key 的厂商）

`ModelRuntime` 就是这层答案。它实现库层的 `Models` 接口——对 AgentSession 来说它就是第一章那个 `models`，但内部多了四样东西：

```
AgentSession ── streamSimple/getAuth ──▶ ModelRuntime（实现 Models 接口）
                                          ├─ RuntimeCredentials（内存覆盖层）
                                          │    └─ AuthStorage（auth.json + 文件锁）
                                          ├─ ModelConfig（models.json 用户配置）
                                          │    └─ provider-composer（与内置目录合成）
                                          └─ snapshot（可用性快照，喂 UI）
```

## 2. 凭证存储：0600 + 进程间文件锁

`auth-storage.ts` 把凭证放在 `~/.pi/agent/auth.json`，两道防线：

**权限**：文件创建即 `chmod 0600`、目录 `0700`——本机其他用户读不了。

**锁**：所有读改写都经过 `proper-lockfile` 的进程间锁：

```typescript
// src/core/auth-storage.ts · FileAuthStorageBackend，已裁剪
withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
  this.ensureFileExists();
  const release = this.acquireLockSyncWithRetry(this.authPath);   // ELOCKED 时重试 10 次
  try {
    const current = readFileSync(this.authPath, "utf-8");
    const { result, next } = fn(current);
    if (next !== undefined) writeFileSync(this.authPath, next, { mode: 0o600 });
    return result;
  } finally { release(); }
}
```

上面代码中，`fn` 拿到当前文件内容、返回新内容，**读-改-写整体在锁内**。为什么必须锁？想象两个 pi 进程同时发现 OAuth token 快过期：都去刷新、都写文件——后写的覆盖先写的，而 OAuth 刷新常常是**一次性**的（旧 refresh token 刷新后作废），被覆盖掉的那个新 token 丢失，两个进程从此都拿着废 token。文件锁把"检查-刷新-写回"变成原子操作，第二个进程进锁时看到的已经是新 token，直接用即可。

这是"单机 CLI 长出多进程"（第五章 server 每会话一个进程）之后必然要补的课——**凭证文件是多个进程唯一的共享可变状态，必须有并发协议**。

## 3. 两层凭证：内存覆盖 > 文件

`RuntimeCredentials` 在文件存储外再包一层内存覆盖：

```typescript
// src/core/runtime-credentials.ts，已裁剪
export class RuntimeCredentials implements CredentialStore {
  private readonly overrides = new Map<string, string>();
  read(providerId: string): Credential | undefined {
    const override = this.overrides.get(providerId);
    return override ? { type: "api_key", key: override } : this.store.read(providerId);
  }
}
```

上面代码中，覆盖层服务的是"这次运行临时用另一个 key"的场景（RPC 客户端注入、扩展设置的运行时 key），特点是**不落盘**——临时凭证不该在 auth.json 里留下痕迹。同一个"base + override"模式在上一节的系统提示词里刚见过：**事实持久化，临时态放内存，取值时 override 优先**。pi 里这个模式至少出现了三次，值得当成惯用法记住。

## 4. getAuth：每次调用前的新鲜度检查

第一章和第二章反复提到"每次 LLM 调用前才解析认证"，产品层的实现落在 `ModelRuntime.getAuth`。签名里有个不起眼但关键的参数：

```typescript
// src/core/model-runtime.ts
export interface ModelRuntimeAuthOverrides {
  apiKey?: string;
  env?: Record<string, string>;
  /** Require this much remaining OAuth-token validity; defaults to five minutes. */
  minOAuthValidityMs?: number;
}
```

上面代码中，`minOAuthValidityMs` 默认 5 分钟：解析时 OAuth token 剩余有效期不足 5 分钟就**主动刷新**，而不是等到真过期。为什么要提前量？一次 agent 轮次从发请求到流结束可能好几分钟——token 在"发出时有效、流到一半过期"是真实故障模式。5 分钟余量把"检查时有效"升级成"整个请求期间大概率有效"。压缩、分支摘要这些旁路 LLM 调用（第二章第 4 节）也各自走一遍 getAuth，同样受益。

`getAuth` 还负责最后一道合成：把 models.json 里用户配置的自定义 headers 织进解析结果（`resolveConfiguredModelHeaders`）——用户配置的落点不在请求代码里，而在认证解析的出口处统一注入。

## 5. 目录合成与可用性快照

剩下两个职责快速带过：

**provider 合成**（`provider-composer.ts`）：用户在 `models.json` 里可以新增厂商、也可以**改写内置厂商**（换 baseUrl、加模型）。合成规则是内置目录为底、用户配置为 overlay；扩展注册的 provider（第 3 节的 `pi.registerProvider`）再叠一层。没有任何 overlay 时直接用内置对象——注释写明是为了"auth/login/stream 行为分毫不差"，合成层对无配置用户零成本。

**可用性快照**（`snapshot`）：`all`（目录里所有模型）与 `available`（凭证已配置的厂商的模型）分开维护，UI 的模型选择器读后者。快照的刷新做了两个并发处理：并发读者合并到同一个进行中的刷新（coalesce）；**写操作（login/logout）不许观察到早于它开始的刷新**——注释里一句 "Mutations must not observe an in-flight refresh started before them" 点破了这类缓存的经典竞态。

## 6. 设计取舍

- **文件 + 锁 vs 常驻 keychain/daemon**：系统钥匙串（macOS Keychain 等）更安全但平台碎片化；凭证 daemon 又引入常驻进程。0600 文件 + 文件锁是跨平台最大公约数，安全性上承认"本用户账户已沦陷则无解"。
- **提前 5 分钟刷新 vs 401 后重试**：被动方案（收到 401 再刷新重发）少一次时钟判断，但流式请求失败在中途时已产生的 token 费不退，UI 还会闪一次错误。主动新鲜度检查花一次本地时间比较，省掉整类故障。
- **overlay 合成 vs 直接改目录**：用户配置永远不修改内置目录对象，读取时合成。内置目录随版本更新，用户配置随 settings 走，两者独立演化互不污染——和第一章"不改生成文件，改生成脚本"是同一个纪律。

总之，本节没有新的抽象，只有库层接口在产品现实（多进程、用户配置、UI 需求）下的三次落地：`CredentialStore` 落成带锁的 auth.json，`Provider` 目录落成三层 overlay 合成，认证解析落成带新鲜度余量的 getAuth。**库定义动词，产品补足名词**。

## 动手实验

观察可用性快照与凭证的联动：

```powershell
.\pi-test.ps1 --list-models
```

预期:输出的模型列表只包含你配置过凭证（环境变量或 auth.json）的厂商——这就是 `snapshot.available`。然后检查凭证文件的权限与内容形态：

```powershell
Get-Acl ~\.pi\agent\auth.json | Format-List
Get-Content ~\.pi\agent\auth.json | ConvertFrom-Json | Get-Member -MemberType NoteProperty
```

预期：能看到按 provider 组织的凭证条目（只看键名即可，别把值贴给任何人）。若你配置过 OAuth 登录，条目里有过期时间字段——下次任何 LLM 调用前若剩余有效期低于 5 分钟，getAuth 会静默刷新它，这就是第 4 节的新鲜度检查在工作。

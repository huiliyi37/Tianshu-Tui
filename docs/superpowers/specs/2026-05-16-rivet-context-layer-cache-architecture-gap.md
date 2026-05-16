# Rivet Context Layer + Cache Architecture 原始建设思想与差距说明

## 背景

Rivet 的项目目标不是单纯做一个 terminal chat UI，而是让 DeepSeek V4 / OpenAI-compatible provider 在真实编码任务里具备接近 Claude Code、opencode 的长会话开发能力。这个目标依赖三件事同时成立：

1. **开放模型可用**：主模型不是 Claude，也要能稳定执行多轮工具调用、读写代码、运行验证。
2. **长上下文可持续**：1M context window 不能被无序 transcript、超大 tool output、重复上下文快速填满。
3. **prefix cache 高命中**：DeepSeek 的成本和延迟优势来自 token-prefix cache；如果每 turn 都扰动前缀，长上下文能力会变成高成本、低稳定性的负担。

所以 Rivet 的上下文工程从一开始就不是附属优化，而是核心业务能力：它决定开放模型能否在长任务里持续记住目标、文件、错误、验证状态，同时保持请求成本和延迟可控。

---

## 原始项目建设思想

### 1. Cache-first，而不是 compact-first

原始 System Prompt 设计明确记录了 DeepSeek API 的缓存特征：

- `cache_control: ephemeral` 对 DeepSeek /anthropic 端点不可靠。
- 缓存是 token 级 prefix match。
- system prompt 属于 provider cache prefix 的一部分。

因此 Rivet 的原始选择是：

```text
稳定的大前缀 + 动态的小后缀
```

具体落到请求结构上：

```text
system: stable base prompt
工具定义: stable tool definitions
messages: 在用户输入前插入 volatile <context> user message
```

这说明原始设计就是为了满足 prefix cache，而不是后来为了缓存临时改造。

### 2. Volatile 不进 system，是有意为之

原始设计没有把 git status、`.rivet.md`、working set 放入 system prompt。原因是这些内容会频繁变化，一旦放进 system，就会直接扰动 provider prefix cache。

因此设计选择是：

```text
Turn 1: [system, user(<context>), user(current request)]
Turn 2: [system, user(<context>), user(old request), assistant, user(<context>), user(current request)]
```

这样 system 和 tools 保持稳定，volatile context 仍能进入模型视野，但不会破坏最核心的 cache anchor。

### 3. 多层上下文是业务能力，不只是代码组织

Progressive Context Engine 设计把每轮请求拆成六个逻辑层：

```text
L1 Stable System Prompt         稳定，不频繁变，保护 DeepSeek prefix cache
L2 Tool Definitions             稳定，参与 fingerprint
L3 Session Memory               决策、错误、文件、未完成任务
L4 Active Working Set           当前涉及文件、测试、风险、最近验证
L5 Recent Raw Turns             最近几轮完整消息和工具结果
L6 User Current Request         当前输入
```

这些层解决的是不同业务问题：

| 层 | 业务需要 | 不能混淆的原因 |
|----|----------|----------------|
| L1 Stable System Prompt | 保证模型行为、工具纪律、安全规则稳定 | 频繁变动会降低 cache 命中，并让行为不稳定 |
| L2 Tool Definitions | 保证工具 schema 与使用说明稳定 | 工具定义漂移会影响 tool_use 准确率和缓存 |
| L3 Session Memory | 长任务中保留目标、决策、错误、待办 | 如果混入 raw turns，会被压缩或噪声淹没 |
| L4 Active Working Set | 让模型知道当前关注哪些文件和验证风险 | 如果混入 session memory，会让当前工作焦点变钝 |
| L5 Recent Raw Turns | 保留最近对话和工具结果的精确上下文 | 如果被提前摘要，模型会丢失刚发生的细节 |
| L6 User Current Request | 当前用户意图 | 必须在最新位置，不能被历史上下文稀释 |

所以六层设计不是形式主义，而是为了让开放模型在长任务中既能保持稳定行为，又能保持当前注意力。

---

## 当前实现状态

当前代码保留了原始设计中最重要的物理请求形态：

```text
system + tools + volatile user message
```

这是正确的，也是 cache-first 的基础。

但当前实现没有完整落成六个逻辑层。实际结构更像：

```text
stable system/tools
+
一个越来越大的 volatileBlock
  ├── cwd
  ├── .rivet.md
  ├── git status
  ├── working set
  ├── context ledger
  ├── session memory
  ├── tool history
  ├── task progress
  ├── behavior mirror
  └── decisions
```

也就是说：物理通道符合原始缓存设计，但逻辑层被压扁进同一个 `<context>` builder。

---

## 当前与原始设计的差距

### 差距 1：逻辑层没有成为代码边界

原始设计要求每层有明确职责。当前实现里，`buildVolatileBlock()` 同时承担稳定项目上下文、session memory、working set、tool history、task progress、behavior mirror、decisions 的组装。

风险：

- 不能清楚判断某段上下文属于 stable prefix 还是 latest dynamic context。
- 不容易给每层设置 token 预算。
- 不容易解释 cache miss 是哪一层导致。
- 不容易测试“动态信息只进入最新 turn”。

### 差距 2：stable volatile 与 latest volatile 没有显式拆分

当前 `PromptEngine` 有 frozen volatile block，同时在最新 user message 前可能构造 fresh block。这个思路是对的，但代码上仍共享一个 builder。

应该显式拆成：

```text
buildStableVolatileBlock()
buildLatestTurnVolatileBlock()
```

其中 stable block 只包含 cache anchor 能接受的稳定上下文，latest block 才包含 tool history、task progress、behavior mirror、decisions 等最新动态信息。

### 差距 3：fingerprint 没完全覆盖真实 cache anchor

当前 fingerprint 主要覆盖 system prompt 和 tool definitions。真实请求中 frozen volatile block 也会进入稳定前缀区间，但 fingerprint 未完整表达这一点时，`checkDrift()` 可能假绿。

这部分已经在 cache safety 文档中记录，修复方向是加入：

```text
stableVolatileSha256
```

### 差距 4：本地缓存边界比原始 provider cache 边界更弱

原始 prompt 设计主要解决 provider prefix cache。后来新增的 speculative prewarm、`.rivet.md` TTL cache、git status TTL cache 属于本地缓存层。

这些缓存如果不复用工具安全边界，就会引入新的风险：

- prewarm 绕过 `read_file` 的路径校验和 gitignore。
- prewarm key 不 canonical 导致 stale read。
- volatile cache 不按 cwd 分桶导致跨项目串值。

这部分由 `docs/superpowers/specs/2026-05-16-rivet-cache-safety-design.md` 和 `docs/superpowers/plans/2026-05-16-rivet-cache-safety-implementation.md` 覆盖。

### 差距 5：可观测性不足

原始 Progressive Context Engine 设计强调 TUI context cockpit、context diff、section digest。当前虽然已有 `/context`、ledger、cockpit 面板基础，但还不能清楚回答：

```text
本轮请求有哪些 context layers？
哪些参与 fingerprint？
哪些只进入 latest turn？
哪一层变了导致 cache drift？
每层大约消耗多少 token？
```

没有这些信息，工程师只能凭经验判断上下文是否健康。

---

## 原始设计是否满足缓存需要

结论：**满足，而且方向是正确的。**

原始设计满足缓存需要的原因：

1. system prompt 和 tools 被设计成稳定 cache anchor。
2. volatile context 被明确排除在 system 外。
3. volatile context 作为 user message 注入，避免频繁扰动 system prefix。
4. XML section 顺序、空 tag、稳定排序、digest 的设计都是为了减少无意义 prefix drift。
5. Progressive Context 的六层结构让 compact、session memory、working set 不必污染 stable prompt。

当前问题不是原始设计不满足缓存，而是实现只落下了物理通道，没有把六层逻辑边界完整物理化到代码、测试和诊断里。

---

## 修复路线

### P0：先完成 Cache Safety Layer

先执行：

```text
docs/superpowers/plans/2026-05-16-rivet-cache-safety-implementation.md
```

目标：保证本地缓存不绕过安全边界，不返回 stale 内容，不跨 cwd 串上下文。

### P1：补齐 context layer 代码边界

新增明确的 context layer contract，让代码能表达：

```text
layer name
source
stability
message channel
fingerprint participation
digest
token estimate
```

目标不是增加 API message 数量，而是让职责边界可测试。

### P1：拆分 stable/latest volatile block

把当前一个 `buildVolatileBlock()` 的职责拆清楚：

```text
stable volatile: cwd, project instructions, stable session memory, stable working-set anchors
latest volatile: tool history, task progress, behavior mirror, decisions, latest verification state
```

目标：动态上下文只影响最新 turn，不污染 frozen prefix。

### P2：PromptEngine 输出 context layer report

让 `/debug`、`/context`、cockpit 可以展示：

```text
L1 system: stable, fingerprint=yes
L2 tools: stable, fingerprint=yes
L3 session memory: stable volatile, fingerprint=yes
L4 working set: stable/latest split, fingerprint=partial
L5 recent turns: raw messages, fingerprint=no
L6 current request: latest user, fingerprint=no
```

目标：cache miss 和 context drift 可解释。

### P3：引入 per-layer budget

给每层建立预算和降级规则：

```text
session memory: 保留结构化摘要
working set: 超预算只保留 path + reason
recent raw turns: 保留最近 N 轮
latest dynamic: 严格短文本
```

目标：长会话不靠一次性 emergency truncation 维持。

---

## 实施完成后的目标形态

代码层应能回答以下问题：

| 问题 | 回答来源 |
|------|----------|
| 哪些内容属于 stable cache anchor？ | `PromptEngine.getContextLayerReport()` |
| 哪些内容只进入 latest turn？ | `ContextLayer.stability === 'dynamic'` |
| 哪些内容参与 fingerprint？ | `ContextLayer.fingerprint` |
| 哪一层导致 drift？ | `PrefixFingerprint.stableVolatileSha256` + layer digest |
| 每层 token 成本是多少？ | `ContextLayer.tokenEstimate` |

这不是把请求改成六条 message，而是让六层业务语义成为代码边界。

### 已关闭的差距

| 差距 | 状态 | 实现 |
|------|------|------|
| 差距 1：逻辑层没有成为代码边界 | ✅ 已关闭 | `src/prompt/context-layer.ts` — ContextLayer model + report |
| 差距 2：stable/latest volatile 没有显式拆分 | ✅ 已关闭 | `buildStableVolatileBlock()` / `buildLatestTurnVolatileBlock()` |
| 差距 3：fingerprint 没完全覆盖真实 cache anchor | ✅ 已关闭 | `PrefixFingerprint.stableVolatileSha256` |
| 差距 4：本地缓存边界比原始 provider cache 边界更弱 | ⏳ 待 Cache Safety Plan | `docs/superpowers/plans/2026-05-16-rivet-cache-safety-implementation.md` |
| 差距 5：可观测性不足 | ✅ 已关闭 | `ContextPanel` 展示 layer report |

---

## 验收标准

- 文档能解释为什么 Rivet 原始设计是 cache-first。
- 工程师能区分 physical channel 与 logical context layer。
- `PromptEngine` 测试能证明 dynamic context 只进入 latest volatile block。
- fingerprint 能反映 stable prefix 的真实组成。
- context report 能列出每层的 stability、channel、fingerprint 状态。
- cache safety plan 完成后，prewarm / volatile cache 不再绕过安全边界。
- `npm run typecheck`、`npm test`、`npm run build` 全部通过。

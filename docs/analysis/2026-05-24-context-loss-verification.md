# 上下文丢失根因验证 & 遗漏发现

**日期**: 2026-05-25
**来源文档**: `docs/analysis/2026-05-24-context-loss-root-cause.md`（6 个根因 + 1 个新增，共 7 个）
**验证方式**: 逐条对照源码 grep/read，确认行号、逻辑、调用链。

---

## 一、原始文档 7 个根因验证

### 根因 1：消息持久化缺失

**文档判断**: ✅ 准确

| 方法 | 定义位置 | 生产调用方 |
|---|---|---|
| `appendOaiWithChecksum` | `session-persist.ts:176` | **0** |
| `appendWithChecksum` | `session-persist.ts:260` | **0** |
| `append` | `session-persist.ts` | **0** |
| `compactOai` | `session-persist.ts:247` | 仅 `/exit`、`/resume` preflight |
| `appendCompactStart` | `session-persist.ts` | `loop.ts:901` ✅ |
| `appendCompactEnd` | `session-persist.ts` | `loop.ts:976` ✅ |

**补充发现**：文档只提到 `appendOaiWithChecksum` 无人调用。实际上 **最基本的 `append` 方法也没有任何生产调用方**。消息从不在常态下落盘。唯一保留消息的路径是 `/exit` 命令（调用 `compactOai` 全量写入）。

---

### 根因 2：每轮无条件 AgentDiet

**文档判断**: ✅ 准确

调用链还原：

```
loop.ts:943  →  this.p3.dietMessages(dietBefore)
p3-integration.ts  →  applyAgentDiet(messages)
agent-diet.ts      →  无任何 token 闸门，纯根据消息元数据判断
```

触发条件：`!compactResult.compacted`（只要主压缩没触发，每轮都跑）。

agent-diet 的判断维度只有两个：
1. 同一文件后续被再读 → 旧 tool_result → `[diet:redundant]`
2. 同一文件后续被 edit → 旧 tool_result → `[diet:expired]`

**确认**：78K token 下距任何阈值很远，但 diet 仍在每轮主动删除"重复读过"的内容。

---

### 根因 3：消息数 > 6 触发 stale-round

**文档判断**: ✅ 准确

```ts
// stale-round.ts
const RECENT_MESSAGES_TO_KEEP = 4
// constants.ts
export const CACHE_ANCHOR_MESSAGES = 2

// 跳过条件
if (messages.length <= CACHE_ANCHOR_MESSAGES + RECENT_MESSAGES_TO_KEEP) return messages
// → 消息数 <= 6 跳过，> 6 触发
```

触发后：裁剪"非首 2 条 + 非末 4 条"区间内所有 `role === 'tool'` 消息的 content 到 1200 字符。

**确认**：`CACHE_ANCHOR_MESSAGES = 2`，`RECENT_MESSAGES_TO_KEEP = 4`，条件正确。

---

### 根因 4：heap-driven compact 只看比例不看数量

**文档判断**: ✅ 准确

```ts
// loop.ts:962-970
const heapRatio = this.p3.computeHeapRatio(messages)
if (heapRatio >= 0.6 && this.session.getMessages().length >= 10) {
  compactResult = await this.p3.microCompact(messages)
}
```

- heap ratio 是估算值（`estimateOaiMessageTokens` 逐条加和），不是精确 token 计数
- 只在 `compactResult.compacted === false` 时走这段（主压缩没触发后的补丁）

---

### 根因 5：pre-compact-handoff 零密度摘要

**文档判断**: ✅ 准确

```ts
// loop.ts:909-917
const handoff = generateHandoff(this.session.getMessages() as any)
if (handoff.summary && (handoff.filesModified.length > 0 || handoff.hadFailures)) {
  // 只在有文件修改或失败时注入
}
```

`generateHandoff` 的 summary 是模板字符串拼接，信息密度极低。且 `hadFailures` 为 false 且 `filesModified` 为空时不注入任何 handoff。

---

### 根因 6：enforceContextCeiling 双标准

**文档判断**: ✅ 准确

两个不同的 compaction 路径使用不同的阈值逻辑：

| 路径 | 触发时机 | 阈值来源 |
|---|---|---|
| `maybeCompact()` | 每轮主动检查 | `compactPolicyRatios`（策略表驱动） |
| `enforceContextCeiling()` | 每轮最后防线 | 硬上限（独立阈值） |

`enforceContextCeiling` 在 `loop.ts:1069` 无条件调用，是 `maybeCompact` 之后的兜底。如果 `maybeCompact` 因 compact 被禁用而返回 null，`enforceContextCeiling` 仍会以不同的标准执行。

---

### 根因 7：cacheType 策略表 ⚠️ 需修正

**文档判断**: ⚠️ 核心判断错误，需修正。

文档声称 "MiMO/GLM 被推入 aggressive 路径，DeepSeek 也被推入 aggressive 路径"。

实际代码验证：

```ts
// provider-profile.ts
DeepSeek:   cacheType: 'exact-prefix',    persistent: true   → strategy: 'cache-preserving'
Anthropic:  cacheType: 'explicit-breakpoint', persistent: false → strategy: 'balanced'
GLM:        cacheType: 'none',            persistent: false  → strategy: 'aggressive'
MiMO:       cacheType: 'none',            persistent: false  → strategy: 'aggressive'
```

**DeepSeek 走的不是 aggressive，而是最保守的 `cache-preserving`。**

| 模型 | strategy | watch 阈值 | 含义 |
|---|---|---|---|
| DeepSeek | `cache-preserving` | 72% 窗口 | 最保守，尽量不破坏前缀缓存 |
| Anthropic | `balanced` | 65% 窗口 | 中等 |
| GLM/MiMO | `aggressive` | 50% 窗口 | 激进 |

**真正的问题不是策略映射错误，而是：agentDiet 和 stale-round 完全不尊重策略表。** 即使策略是 `cache-preserving`，这两个"反沉淀"机制仍然每轮运行、低阈值触发，直接破坏前缀缓存。

---

## 二、文档遗漏的 8 个根因

### 遗漏 1：工具输出截断（20 行默认）

**严重程度**: 🔴 高

项目指令明确写明："Tool output is truncated at 20 lines by default — raw content is always at the rawPath"。

```ts
// tool-result-truncate.ts
export function truncateToolResult(content: string, maxTokens: number): string {
  const tokens = estimateOaiMessageTokens({ role: 'user', content })
  if (tokens <= maxTokens) return content
  // 截断：保留 60% 头部 + 30% 尾部
  const ratio = maxTokens / tokens
  const maxChars = Math.max(0, Math.floor(content.length * ratio))
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.floor(maxChars * 0.3)
  // ...
}
```

**影响**：Agent 每轮看到的工具输出都是不完整的。完整内容在 `rawPath`（磁盘），但 LLM 只能看到截断版本。这直接导致：
- 长文件读取时丢失关键上下文
- grep 结果被截断到看不出模式
- 级联效应：截断 → 模型猜错 → 重新读取 → agent-diet 把旧的标 redundant

文档完全没提这个。

---

### 遗漏 2：artifact 模式导致消息内容被替换

**严重程度**: 🟡 中

```ts
// tool-pipeline.ts: artifactIntercept
// 当工具输出超过阈值时，替换消息内容为 artifact 引用
```

最近提交 `5318643` 引入了这个功能。工具输出被替换为类似 `[artifact:read_file:abc123]` 的引用——完整内容在磁盘上，但 LLM 消息里只剩引用标记。

虽然在 artifact 读取路径上有处理，但如果 agent-diet 先把一条消息标为 `[diet:redundant]`，后续 artifact 引用也会丢失。

---

### 遗漏 3：基本 `append` 方法无生产调用方

**严重程度**: 🔴 高（根因 1 的延伸）

文档只指出 `appendOaiWithChecksum` 无调用方，但实际上：

```
append            → 0 生产调用方
appendWithChecksum → 0 生产调用方
appendOaiWithChecksum → 0 生产调用方
```

三个写方法全部无人调用。消息持久化是**完全缺失**的，不是"校验和缺失"的问题。

---

### 遗漏 4：agent-diet 移除阈值过低（> 8 条消息）

**严重程度**: 🟡 中

```ts
// agent-diet.ts
const ANCHOR_MESSAGES = 2   // constants.ts
const protectRecent = 6     // agent-diet 内部

// 核心判断
if (messages.length <= ANCHOR_MESSAGES + protectRecent) return messages
// → 消息数 > 8 就开始移除
```

对于深度编码 Agent，8 条消息 = 大约 4 个 round（user + assistant + tool_call + tool_result）。对话稍微深入就触发，导致模型在关键推理阶段被反复剥夺上下文。

---

### 遗漏 5：replaceMessages 破坏前缀缓存

**严重程度**: 🔴 高

agent-diet 移除消息后调用：

```ts
// loop.ts:945
this.session.replaceMessages(dietResult.messages as any)
```

`replaceMessages` 替换整个消息数组。即使只移除了 1-2 条消息，整个数组引用变了，DeepSeek 的前缀缓存（`exact-prefix` 类型）完全失效。

这与根因 7 形成叠加伤害：策略表说 DeepSeek 走 `cache-preserving`，但 agent-diet 每轮都调用 `replaceMessages`，prefix cache 根本无法建立。

---

### 遗漏 6：adaptiveCompactPolicyRatios 回退陷阱

**严重程度**: 🟡 中

```ts
// compact-policy.ts / compaction-controller.ts
// 连续压缩失败 → 降低 tier → 更容易触发 compact → 破坏缓存 → 更多失败
```

低 cache 命中率时自动降低 compact 阈值，形成恶化循环：
1. prefix cache miss → 判定为 compaction 失败
2. 降低 tier 阈值 → 更容易触发 compact
3. compact → 修改消息 → 再次 cache miss
4. 循环

---

### 遗漏 7：pruneStaleToolResults 不区分策略

**严重程度**: 🟡 中

```ts
// prune.ts
// 不管 cacheType 是什么，prune 无条件移除 >1200 字符的 stale tool 结果
```

`prune.ts` 是 `maybeCompact` 的入口轻量裁剪，但它的逻辑不与 provider-profile 中的 cacheType/strategy 联动。`cache-preserving` 策略下也会被 prune。

---

### 遗漏 8：agentDiet / stale-round 在所有策略下行为相同

**严重程度**: 🔴 高（根因 7 的真正问题）

这是对根因 7 的修正总结。核心矛盾：

```
provider-profile  →  strategy = 'cache-preserving'（告诉系统"别动消息"）
agent-diet        →  每轮移除 redundant/expired 消息（不管策略）
stale-round       →  消息 > 6 就截 tool 内容（不管策略）
prune             →  无条件裁剪 stale 结果（不管策略）
enforceContextCeiling → 用独立阈值（不管策略）
```

四个"反沉淀"机制中，**没有一个**在运行时查询 `providerProfile.strategy`。策略表有 3 个档位（cache-preserving / balanced / aggressive），但实际行为在所有档位下完全相同。

---

## 三、根因关联图

```
                   ┌──────────────────────────────────┐
                   │         消息持久化缺失 (R1)        │
                   │    append* 三个方法 0 调用方       │
                   │    Ctrl+C = 全部丢失               │
                   └────────────┬─────────────────────┘
                                │ 消息只在内存
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                      ▼
   ┌──────────────┐    ┌──────────────┐     ┌──────────────────┐
   │  agentDiet   │    │  stale-round │     │  pre-compact     │
   │  每轮移除 (R2)│    │  >6 截断 (R3)│     │  handoff (R5)    │
   │  >8 触发(漏4)│    │  + prune(漏7)│     │  零密度摘要       │
   └──────┬───────┘    └──────┬───────┘     └────────┬─────────┘
          │                   │                       │
          │    都不查询 strategy (漏8)                  │
          │                   │                       │
          ▼                   ▼                       ▼
   ┌──────────────────────────────────────────────────────┐
   │            replaceMessages 破坏前缀缓存 (漏5)          │
   │    + artifact 替换内容 (漏2)                          │
   │    + 工具输出截断 (漏1)                               │
   └──────────────────────┬───────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌───────────┐  ┌──────────────┐  ┌───────────────────┐
   │ heapRatio │  │ enforce      │  │ adaptivePolicy    │
   │ >=0.6 (R4)│  │ Ceiling (R6) │  │ 回退陷阱 (漏6)     │
   └───────────┘  └──────────────┘  └───────────────────┘
```

---

## 四、优先级修复排序

### 🔴 P0 — 阻塞级（不改则不可用）

| # | 问题 | 修复方向 |
|---|---|---|
| R1+漏3 | 消息从不落盘 | `loop.ts` 中每轮调 `persist.append*` |
| 漏5 | replaceMessages 破坏前缀缓存 | diet 返回后 diff 增量更新而非 replaceAll |
| 漏8 | 四个反沉淀机制不尊重策略 | 在 agentDiet/stale-round/prune 入口加 strategy gate |

### 🟡 P1 — 高优先级

| # | 问题 | 修复方向 |
|---|---|---|
| R2+漏4 | agentDiet 每轮无条件 + 阈值过低 | token gate（<30% 窗口时跳过）+ 阈值 8→20 |
| R3 | stale-round >6 触发 | 阈值 6→18，或加 token gate |
| 漏1 | 工具输出截断 | 截断阈值与 compact tier 联动，低压力时不截 |
| 漏7 | prune 不区分策略 | prune 入口加 strategy 判断 |

### 🟢 P2 — 结构性改进

| # | 问题 | 修复方向 |
|---|---|---|
| R5 | handoff 零密度 | 提取最后 N 条 assistant text 关键句 |
| R6 | enforceContextCeiling 双标准 | 统一阈值来源 |
| R7 | 策略表与行为解耦 | agentDiet/stale-round/prune 全部查 strategy |
| 漏2 | artifact 替换 | 评估是否需要阈值联动 |
| 漏6 | adaptive 回退陷阱 | 回退加冷却期 |

---

## 五、验证方法

所有验证通过以下工具完成：

```
grep -n "appendOaiWithChecksum\|appendWithChecksum" src/ --include="*.ts" | grep -v __tests__
grep -n "agentDiet\|applyAgentDiet" src/agent/loop.ts
grep -n "RECENT_MESSAGES_TO_KEEP\|CACHE_ANCHOR_MESSAGES" src/compact/
read_file src/compact/stale-round.ts
read_file src/compact/agent-diet.ts
read_file src/agent/p3-integration.ts
read_file src/agent/session-persist.ts
read_file src/agent/compaction-controller.ts
read_file src/api/provider-profile.ts
read_file src/compact/constants.ts
read_file src/agent/tool-result-truncate.ts
read_file src/agent/tool-pipeline.ts
read_file src/compact/prune.ts
```

---

## 附录：关键修正

| 原始文档描述 | 修正 |
|---|---|
| DeepSeek 被推入 aggressive 路径 | DeepSeek 实际走 `cache-preserving`（最保守） |
| 问题是策略映射出错 | 问题是机制不查询策略 |
| 6 处反沉淀路径 | 至少 12 处（原 7 + 遗漏 8，去重后 12） |
| appendOaiWithChecksum 无人调用 | append 三个方法都无人调用 |

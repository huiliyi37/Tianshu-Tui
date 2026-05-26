# DeepSeek Prefix Cache 不变量登记表

> 最后更新：2026-05-27
> 适用范围：contextWindow >= 1_000_000 的 DeepSeek exact-prefix 模式

---

## 核心原理

DeepSeek prefix cache 是**逐字节精确匹配**。请求 token 序列中任何位置的单字节变化，都会导致该位置之后的所有 cache 失效。

在 1M window 下，我们用 `trySessionSplit`（86%）替代所有 request-time 内容修改操作。

---

## 已确认的 cache killer（已修复）

| # | 问题 | 修复 commit | 机制 |
|---|------|------------|------|
| 1 | Semantic pruning 修改历史消息 | `27a6679` | `semanticPruneLayer1` + `detectStaleness` 替换旧 tool result 为 `[superseded: ...]` |
| 2 | Observation masking 替换旧 tool content | `27a6679` | 超过 MASK_WINDOW 的 tool result 被替换为 `[observation masked...]` |
| 3 | File content dedup 替换重复 tool result | `ceb590d` | 同一文件被 read 两次时，旧的被替换为 `[duplicate content...]` |
| 4 | Disk budget truncation 截断大 tool result | `ceb590d` | >50K chars 的 tool result 被截断为 2KB preview |
| 5 | `consolidatedBlock` 写入 frozen volatile | `a23724c` | habituation promotion 改变 `volatileBlock` 字节 → system prefix 全部失效 |
| 6 | `cachedFreshBlock` 作为独立 user message | `2e37179` | 独立消息位置滑动 → 从该位置之后 prefix 全部失效 |
| 7 | MCP 工具延迟加载重建 PromptEngine | 热更新修复 | tools 数组变化 → system+tools prefix 全部失效 |
| 8 | `pruneStaleToolResults` 写回 session storage | `30637de` | `replaceMessages()` 改变消息历史字节 |

---

## 不可触碰的不变量

以下规则在 `contextWindow >= 1_000_000` 时必须遵守。违反任何一条都会导致 cache 命中率骤降。

### 规则 1：历史消息内容不可修改

```
一旦 message 被 push 到 oaiMessages 数组，其 content 字段在后续所有 API 请求中必须保持字节一致。
```

**禁止操作：**
- 对历史 tool result 做 replace/truncate/mask/dedup
- 对历史 assistant message 做任何内容修改
- 对历史 user message 做内容修改（frozenUserMerged 机制保证）

**守卫位置：** `src/prompt/engine.ts` — `buildOaiRequest()` 中所有 result 数组修改操作必须有 `contextWindow < 1_000_000` 守卫。

### 规则 2：消息数组只追加不重排

```
oaiMessages 数组只能在末尾追加新消息，不能插入、删除、重排中间位置的消息。
```

**禁止操作：**
- `splice()` / `unshift()` 到中间位置
- 删除历史消息（compaction 除外，但 1M 下已禁用）
- 改变消息顺序

**守卫位置：** `src/agent/context.ts` — `addUserMessage` / `addAssistantBlocks` / `addToolResults` 只做 push。

### 规则 3：frozen volatile block 不可变

```
session 开始后，volatileBlock（= frozenBase）的字节内容不能改变。
```

**禁止操作：**
- 向 `volatileBlock` 拼接新内容
- 修改 `buildStableVolatileBlock` 的输入字段（rivetMd、workingSet、sessionMemoryBlock、heuristicRules）

**守卫位置：** `src/prompt/engine.ts` — `this.volatileBlock` 在构造函数中赋值后不再修改。`consolidatedBlock` 走 dynamic appendix。

### 规则 4：cachedFreshBlock 在同一 user message 内不变

```
同一条 user message 的连续 tool-call turns 中，cachedFreshBlock 必须保持字节一致。
```

**禁止操作：**
- 在 tool-call turn 中调用 `invalidateFreshCache()`
- 在 `userContent === cachedFreshForUser` 时仍重新计算 cachedFreshBlock
- 在 tool-call turn 中修改影响 dynamic appendix 渲染的字段（如果这些字段参与了 cachedFreshBlock 的计算）

**守卫位置：** `src/prompt/engine.ts` line 128 — `if (userContent !== this.cachedFreshForUser)` 条件守卫。`invalidateFreshCache()` 只在 `updateSessionMemory()` 和 `setMode()` 中调用。

### 规则 5：tools 数组 session 内稳定

```
tools 的数量、顺序、schema 在 session 内不能变化（MCP 热更新除外，且热更新后接受一次性 miss）。
```

**禁止操作：**
- 动态增删 tools
- 修改 tool description/schema
- 改变 tools 排序

**守卫位置：** `src/prompt/engine.ts` — `updateTools()` 方法只在 MCP 加载完成时调用一次。

### 规则 6：system prompt session 内稳定

```
system prompt 的字节内容在 session 内不能变化。
```

**禁止操作：**
- 修改 `buildSystemPrompt()` 的输入
- 在 session 中途改变 model/provider 配置

**守卫位置：** `src/prompt/static.ts` — system prompt 在 session 开始时构建，之后不变。

---

## 安全操作（不破坏 cache）

| 操作 | 原因 |
|------|------|
| 在 oaiMessages 末尾追加新 assistant/tool message | 只扩展 prefix，不修改已有部分 |
| 修改 cachedFreshBlock 在新 user message 边界 | 只影响最后一条 user message 的尾部 |
| markGitDirty() | 只设 flag，不触发重建 |
| 修改 repairHint/decisions/sessionState 等 setter | 只在下次 user message 边界生效 |
| trySessionSplit | 用 replaceWithCheckpoint 重建整个 session，接受一次性 cold start |

---

## 新功能开发检查清单

添加任何涉及 prompt/message 的新功能时，检查：

- [ ] 是否在 `buildOaiRequest()` 中修改了 `result` 数组的已有元素？→ 加 `contextWindow < 1_000_000` 守卫
- [ ] 是否修改了 `this.volatileBlock`？→ 改为写入 dynamic appendix
- [ ] 是否在 tool-call turn 中调用了 `invalidateFreshCache()`？→ 延迟到 user message 边界
- [ ] 是否改变了 tools 数组？→ 只允许 MCP 热更新路径
- [ ] 是否改变了 system prompt 的输入？→ 不允许 session 中途变化
- [ ] 是否在 `addToolResults` 中修改了旧消息？→ 只允许 push 新消息

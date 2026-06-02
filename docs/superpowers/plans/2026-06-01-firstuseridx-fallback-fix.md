# firstUserIdx Fallback 双消息推送修复

**状态**：待修复（低优先级）
**发现日期**：2026-06-01
**位置**：`src/prompt/engine.ts:239-256`

## 问题描述

`buildOaiRequest` 中用户消息处理有三个分支：`lastUserIdx`、`firstUserIdx`、中间历史。当 `frozenUserMerged` 没有对应条目时（eviction 后），fallback 行为不一致：

| 分支 | fallback 行为 | 消息数 |
|------|--------------|--------|
| `lastUserIdx` | trailer merge（cachedFreshBlock 合入 content） | 1 |
| `firstUserIdx` | push(volatileBlock) + push(raw msg) | **2** |
| 中间历史 | push(raw msg) | 1（缺 volatile） |

`firstUserIdx` 推 2 条消息会偏移后续所有消息的索引，从该位置起 prefix cache 全部失效。

## 触发条件

1. `frozenUserMerged` 总条目 > 64（`MAX_FROZEN_USER_MERGED`）
2. Eviction 从最长数组中删除条目，直到总量 ≤ 64
3. 如果某条用户消息的 key 被完全删除，下次 `buildOaiRequest` 时 `getNextFrozen()` 返回 `undefined`
4. 该消息走到 fallback 路径

**实际概率**：极低。需要 65+ 个冻结条目（约 30+ 轮对话），且 eviction 恰好删掉了第一条用户消息的 key。

## 机制分析

### 为什么 frozen snapshot 系统不该动

当前设计用 `frozenUserMerged` 精确保存每条历史消息被处理时的完整 volatile 内容（含 dynamic appendix）。这使得消息从 latest 变成 historical 时字节完全不变，是实现 99% DeepSeek prefix cache 命中率的核心原因。

如果去掉 snapshot 系统，改为统一用 `volatileBlock`（frozen base）做 trailer merge，每条消息在 transition 时会剥离 dynamic appendix（~1500 tokens），字节发生变化，命中率会掉到 70-95%（取决于对话长度）。

| 对话长度 | 当前命中率 | 去掉 snapshot 后 |
|----------|-----------|-----------------|
| 5 轮 | ~99% | ~70-75% |
| 20 轮 | ~99% | ~85-90% |
| 50 轮 | ~99% | ~95% |

### 行业对比

DeepSeek V4 cache 要求完全匹配 cache prefix unit（官方文档）。行业铁律（Claude Code / Codex / Manus / OpenClacky 一致）：
1. 前缀不变
2. 追加不修改
3. 动态信息后置

Rivet 的 frozen snapshot 是在「把 volatile 注入历史消息」这个约束下做到 append-only 的方式——用快照冻结来模拟不变。代价是需要管理快照的生命周期（eviction），但换来 99% 命中率。

## 修复方案

只修 fallback，不动架构。统一为 trailer merge：

**`firstUserIdx` fallback（第 244-246 行）**：

```ts
// Before: 2 条消息
result.push({ role: 'user', content: this.volatileBlock })
result.push(msg)

// After: 1 条消息，trailer merge
const content = typeof msg.content === 'string' ? msg.content : ''
result.push({ role: 'user', content: this.volatileBlock + '\n---\n' + content })
```

**中间历史 fallback（第 254-255 行）**：

```ts
// Before: 裸消息，缺 volatile
result.push(msg)

// After: trailer merge
const content = typeof msg.content === 'string' ? msg.content : ''
result.push({ role: 'user', content: this.volatileBlock + '\n---\n' + content })
```

### 修复后的行为

Eviction 后，失去 frozen snapshot 的历史消息降级为 `volatileBlock`（frozen base，不含 dynamic appendix）。对比：

| 内容 | 精确度 |
|------|--------|
| frozen snapshot（正常） | `cachedFreshBlock` + "---" + content — 与 latest 时完全一致 |
| volatileBlock fallback（eviction 后） | `frozenBase` + "---" + content — 只有稳定部分，缺 dynamic |

降级会导致该条消息处产生一次 cache miss，但不会级联（消息数量不变，后续前缀仍可命中）。比当前的双推送（消息数量变化导致全量失效）好一个数量级。

## 需要更新的测试

1. 新增测试：eviction 后 `firstUserIdx` fallback 为 1 条消息（trailer merge）
2. 新增测试：eviction 后中间历史 fallback 包含 volatileBlock
3. 现有 eviction 测试（`engine.test.ts:498-527`）验证仍通过

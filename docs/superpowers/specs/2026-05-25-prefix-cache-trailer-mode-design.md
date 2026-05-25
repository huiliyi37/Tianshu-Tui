# Prefix Cache Trailer Mode 设计文档

## 实施状态更新（2026-05-25）

Trailer mode 已在 `2e37179 fix(prompt): trailer mode — merge cachedFreshBlock into last user message` 落地，并由 `974699a test(prompt): add P2 test for cachedFreshBlock trailer mode merge` 补充测试。

当前 `src/prompt/engine.ts` 的行为：

- 不再 push 独立 `cachedFreshBlock` user message。
- 最后一条 user message 的 content 变为 `cachedFreshBlock + '\n---\n' + 原始用户输入`。
- `src/prompt/__tests__/engine.test.ts` P2 断言 user message 数量不增加，cachedFreshBlock 被合并进最后 user content。
- 后续 `27a6679` 又在 1M+ context window 下完全跳过 observation masking，避免 trailer mode 以外的 request-time masking 继续制造字节漂移。

本文下面保留原始设计说明。

## 背景

### 问题

DeepSeek V4 的 prefix cache 是 exact-prefix matching（从 token 0 开始字节级精确匹配）。当前 Rivet 的 `buildOaiRequest` 在 `lastUserIdx` 前面注入一条独立的 `cachedFreshBlock` user message。每当新用户消息到来，这条消息的**位置**从 N 跳到 N+k，导致位置 N 处的字节从 cachedFreshBlock 内容变成了原来的用户消息内容——prefix 从该点之后全部 miss。

实测数据（2026-05-25 session）：
- Turn 4: 92.9% → Turn 5: 69.7%（骤降 23%）
- Turn 7: 96.5% → Turn 8: 70.3%（骤降 26%）
- Turn 9 立刻恢复到 99.4%（DeepSeek 磁盘缓存重建）

### 根因

`cachedFreshBlock` 作为独立 user message 注入在 `lastUserIdx` 前面。每轮新消息到来时：
1. 上一轮的 `lastUserIdx` 不再是 last → 它前面不再有 cachedFreshBlock
2. 新的 `lastUserIdx` 前面注入了 cachedFreshBlock
3. 从上一轮 lastUserIdx 位置开始，字节序列完全变了

### 约束

- DeepSeek V4：64 token 最小粒度，精确前缀匹配，无 cache_control 标记
- TTL 数小时到数天（磁盘存储，MLA 压缩）
- 无写入惩罚（每次 hit 都是纯省钱，90% 折扣）

## 方案

### 核心思路：合并进最后一条 user message（Trailer Mode）

把 `cachedFreshBlock` 从"独立 user message"改为"拼接到最后一条 user message 的 content 开头"。

```
当前：  [...history...] [cachedFreshBlock 独立 msg] [user msg]
改为：  [...history...] [user msg, content = cachedFreshBlock + "\n---\n" + 原始输入]
```

### 为什么这样做

1. 消息数组结构（message count + role 序列）变为纯 append-only
2. prefix = system + frozenBase + 全部历史消息，100% 字节稳定
3. 唯一 miss = 最后一条 user message（本来就是每轮新内容，不可避免）
4. Claude Code 已验证此模式（`<system-reminder>` 注入到 user message 内部）

### 消息结构对比

**修改前：**
```
[0] system (永不变)
[1] user: frozenBase (永不变)
[2] user: 第一条用户消息
[3] assistant: 回复
...
[N-1] tool: 工具结果
[N] user: cachedFreshBlock ← 每轮跳位置！
[N+1] user: 最后一条用户消息
```

**修改后：**
```
[0] system (永不变)
[1] user: frozenBase (永不变)
[2] user: 第一条用户消息
[3] assistant: 回复
...
[N-1] tool: 工具结果
[N] user: cachedFreshBlock + "\n---\n" + 用户输入 ← 位置固定，只有内容变
```

### 预期效果

- 稳态命中率从 88% → 95-99%
- 消除 >10% 的骤降（除 compaction/sessionMemory 更新外）
- tool-call 轮次内 prefix 100% 稳定（cachedFreshBlock 内容在同一 user message 周期内不变）

## 实现要点

### 修改文件

`src/prompt/engine.ts:174`

当前：
```typescript
result.push({ role: 'user', content: this.cachedFreshBlock })
```

改为：不再 push 独立消息。在处理 `lastUserIdx` 的 msg 时，把 cachedFreshBlock 拼接到 content 开头：
```typescript
result.push({ role: 'user', content: this.cachedFreshBlock + '\n---\n' + msg.content })
```

### 边界情况

- `firstUserIdx === lastUserIdx`：当前代码会注入 frozenBase 和 cachedFreshBlock 两条独立消息 + 原始消息（3 条）。修改后只有 frozenBase + 合并后的消息（2 条）。更简洁。
- 空 cachedFreshBlock：如果 cachedFreshBlock 为空字符串，直接用原始 content，不加分隔符。

## 风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 模型混淆 cachedFreshBlock 和用户输入 | 低 | XML 标签 `<context-update>` 已明确分隔 |
| 测试断言失败 | 中 | 更新 P1.1a/P1.1b 测试预期 |
| firstIdx===lastIdx edge case | 已消除 | 合并后逻辑更简单 |

## 验证标准

1. `node --import tsx --test src/prompt/__tests__/engine.test.ts` 全部 pass
2. `npx tsc --noEmit` 0 errors
3. 新 session 的 cache-log.jsonl：Turn 2+ 稳定 95%+，无 >10% 骤降

## 参考

- EPIC (ICML 2025): Position-Independent Caching
- Irminsul (arXiv 2605.05696): MLA-Native Content-Hash KV Cache
- Stream2LLM (arXiv 2604.16395): Append-mode vs Update-mode
- Claude Code: system-reminder 注入到 user message 内部
- DeepSeek API docs: 64-token granularity, exact prefix matching

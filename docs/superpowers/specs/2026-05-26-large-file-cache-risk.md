# 大文件读取对缓存的风险分析与控制

> 2026-05-26 | 对照基线: `docs/superpowers/baselines/2026-05-26-cache-hit-rate-baseline.md`

---

## 风险定性

大文件读取不会直接"打碎"缓存，但会通过**消息历史膨胀**间接降低命中率。机制：

```
Agent 读取 src/foo.ts (1200行, 60K chars)
  → tool result 进入消息历史（被 model-read-cap 截断到 ~40K）
  → 后续 tool-call turn 增长（append-only，前缀稳定）← 不碎 ✅
  → 下一个 user message 的 Turn 0：前缀包含 60K 文件内容
  → 前缀非常长 → DeepSeek 可能 evict → Turn 0 命中率降低 ← 会碎 ⚠️
```

从基线数据验证：Turn 1+ 命中率 92.4%（同轮内稳定），Turn 0 命中率 59.7%（跨轮脆弱）。大文件主要加剧 Turn 0 的脆弱性。

---

## 现有防御层（已生效）

| 层级 | 机制 | 位置 | 效果 |
|------|------|------|------|
| Tool 层 | `readHistory` 去重 | `src/tools/read-file.ts` | 同一文件+offset+mtime → 拒绝重读。短消息替代全量。 |
| Tool 层 | `computeModelReadCap` | `src/tools/model-read-cap.ts` | 1M 窗口下截断到最大 200K chars（实际 5% × 1M × 4 × 1.3） |
| Tool 层 | `truncateContent` head+tail | `src/tools/truncation.ts` | 60%头 + 30%尾，中间省略 |
| Engine 层 | Disk budget | `src/prompt/engine.ts` | 构建请求时 >50K chars → 2KB 预览 |
| Engine 层 | Content dedup | `src/prompt/engine.ts` | 同一内容出现多次 → 旧的出现替换为 placeholder |
| Engine 层 | Observation masking | `src/prompt/engine.ts` | 10 轮前的 tool result → 压缩为摘要（1M+ 跳过） |

---

## 风险场景与当前应对

### 场景 A：同一文件未修改，多次全量读取

**风险**：每次全量读取 → 消息历史膨胀 → Turn 0 变重

**当前应对**：`readHistory` 去重。第二次读取 → 拒绝 + 提示用 offset/limit。

**有效性**：✅ 已完全覆盖。同一文件+offset+mtime 组合被完全拦截。

### 场景 B：读取大文件 → 修改 → 重新全量读取

**风险**：mtime 变了 → 去重失效 → 新内容进入历史 → 旧内容也在历史中 → 历史更长

**当前应对**：无专门防御。这是真实需求——agent 需要确认修改结果。

**可改进**：读取后最近一次修改过的文件，工具可返回 diff 而非全量。但这需要改动 `read_file` 行为 → 影响缓存 → **当前不做**。

**评估**：⚠️ 接受此风险。修改后验证是合理行为，改为 diff 会改变工具输出格式。

### 场景 C：多轮内读取多个不同大文件

**风险**：3+ 个大文件 → 消息历史轻易超过 100K chars → Turn 0 前缀极长

**当前应对**：
- Disk budget：每个 >50K 的结果在 API 请求中截断到 2KB
- Content dedup：同一内容去重
- Observation masking：10 轮后压缩（但 1M+ 跳过）

**可改进**：降低 `computeModelReadCap` 在 1M 窗口的截断阈值。当前 200K max，可降至 50K。但这改变 read_file 的输出格式 → **会导致跨 turn 缓存断裂**。

**评估**：⚠️ 接受此风险。当前防御已足够（readHistory + disk budget + dedup）。

### 场景 D：长时间会话中多次读取同一文件的不同片段

**风险**：每次不同 offset/limit → readHistory 认为不同请求 → 允许多次读取 → 多个片段在历史中

**当前应对**：无。readHistory key 包含 offset+limit，不同片段被视为不同请求。

**可改进**：readHistory 可增加「同文件」检测——如果上次读了 offset=1, limit=all（全量），本次读 offset=100, limit=50（片段），可提示「已读过全量，使用上次结果」。

**安全性**：只修改 readHistory 的去重逻辑（不改变成功读取时的输出格式）→ **缓存安全** ✅

---

## 唯一可安全实施的改进

### 方案：readHistory 增强 —— 同文件片段检测

**当前行为**：
```
readHistory key = cwd::path::offset::limit
→ offset=1,limit=all ≠ offset=100,limit=50 → 不触发去重 → 重新读取
```

**改进行为**：
```
readHistory 新增 file-level 索引：
→ 如果该文件已被全量读取（offset=1,limit=all / mtime 未变）
→ 且本次请求是子集（offset 在范围内）
→ 提示模型使用已有结果，拒绝重读
```

**格式**（与现有去重消息格式一致，不破坏缓存）：
```
read_file: this file was already read in full earlier (X bytes, Y lines).
The file has not changed since. Use the earlier result.
If you need specific details, use read_section or offset/limit on the raw output.
```

**缓存影响**：✅ 零。这只改变了「去重命中时」的返回消息，不影响「正常读取时」的输出格式。

**实施**：修改 `src/tools/read-file.ts` 的 `readHistory` 逻辑，增加 `fileReadHistory`（按 canonicalPath 索引）。

---

## 不应实施的改进（会碎缓存）

| 方案 | 风险 |
|------|------|
| 降低 `computeModelReadCap` | 改变 read_file 输出格式 → 跨 turn 前缀断裂 |
| 文件内容摘要化（structural summary） | 输出格式从「文件内容」变为「摘要」→ 前缀断裂 |
| 修改 engine disk budget 阈值 | 改变 API 请求中的消息内容 → 同轮内前缀可能断裂 |
| 重新启用 1M+ observation masking | 改变旧消息内容 → 前缀断裂 |

---

## 建议

1. **接受现状**：现有防御（readHistory + model-read-cap + disk budget + dedup）已覆盖 90%+ 的大文件风险场景。
2. **唯一安全改进**：readHistory 同文件片段检测（见上文）——改动小、缓存安全。
3. **长期方向**：如果要从根本上解决大文件问题，需要一次性接受 cache miss 代价，将 read_file 改为「片段优先」模式（默认只返回摘要，精读用 offset/limit）。这应作为一个独立的迁移项目评估，与当前主线缓存隔离。
4. **监控**：后续采集缓存日志时，关注 Turn 0 命中率是否因长时间会话而持续走低。如果从 59.7% 降到 <40%，说明大文件积累效应显著。

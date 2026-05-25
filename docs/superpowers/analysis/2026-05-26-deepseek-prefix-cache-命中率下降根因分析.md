# DeepSeek Prefix Cache 命中率下降根因分析

## 背景

在 session `455e9a5a` 的 cache-log 中观察到多次 cache hit rate 骤降（从 95%+ 降至 3.8%、31%、52% 等），严重影响推理成本和延迟。

## 已确认的两个根因

### 问题 1: Semantic Pruning 每轮修改历史消息

**位置**: `src/prompt/engine.ts` — `buildOaiRequest()` 中的 `semanticPruneLayer1` + `detectStaleness`

**机制**:
- 每次 API 调用前，对 anchor 之后的消息运行 pruning
- `detectStaleness` 使用 `LAG_STEPS = 3`：当一个 tool result 在 3 个 assistant turn 之后，且同文件有更新的 read → 内容被替换为 `[superseded: ...]`
- `semanticPruneLayer1` 对重复 grep 结果做类似处理
- 这改变了消息数组中间位置的字节内容，DeepSeek 从该位置开始的 prefix 全部 miss

**证据**:
- Lines 20-21: 两次 `cacheRead=12416`，Line 20 创建了 8623 tokens 的新缓存，但 Line 21 无法读取（因为中间消息被 prune 修改了）
- Line 23: `cacheRead` 从 15104 骤降到 7040（只匹配到 system+tools，消息历史完全不匹配）

**修复**: 在 `contextWindow >= 1_000_000` 时跳过 pruning（与 observation masking 相同策略）。1M 窗口有足够空间，`trySessionSplit`（86% 触发率）负责防止溢出。

### 问题 2: MCP 工具延迟加载触发 Agent 重建

**位置**: `src/main.tsx` — `useMemo` 依赖 `toolVersion`

**机制**:
- MCP 服务器异步连接（约 47s）
- 连接完成后 `setToolVersion(v => v + 1)` → React 重新计算 `useMemo`
- 整个 `AgentLoop` 被重建，包括新的 `PromptEngine`（tools 数组不同）
- 旧 session 的所有消息和缓存全部丢失
- 新请求的 tools 数组比旧的多 ~5986 tokens → prefix 完全不匹配

**证据**:
- Line 12→13: gap=47s, input 从 12129 跳到 13352（+5986 tokens）
- Line 13: `cacheRead=512`（3.8%）— 几乎完全 miss，只有 system prompt 开头匹配
- Turn 重置为 0 — 确认是新 session

**修复**: 移除 `toolVersion` 依赖，MCP 加载后通过 `agentRef.current?.updateTools()` 热更新现有 PromptEngine 的 tools 数组。第一次调用仍会 miss（tools 变了），但后续调用立即恢复 95%+ hit rate。

## 修复后预期效果

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| MCP 加载后首次调用 | 3.8% hit | ~50% hit（tools 变了但消息不变） |
| MCP 加载后第二次调用 | 52% hit | 95%+ hit |
| Mid-conversation（turn 5+） | 随机降至 31-68% | 稳定 95%+ |
| 长间隔（>60s）调用 | 降至 60-70% | 95%+（TTL 数小时，不是瓶颈） |

## 相关文件

- `src/prompt/engine.ts` — pruning 条件守卫 + `updateTools()` 方法
- `src/agent/loop.ts` — `updateTools()` 便捷方法
- `src/main.tsx` — 移除 `toolVersion` 依赖，改用 ref 热更新
- `.rivet/sessions/455e9a5a-*/cache-log.jsonl` — 原始数据

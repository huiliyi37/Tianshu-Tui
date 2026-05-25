# 缓存命中率优化 — 交接文档

更新时间：2026-05-25  
代码基线：`386b8aa fix(agent): isolate per-session state files to prevent multi-process corruption`。

## 当前结论

DeepSeek prefix cache 优化已经从原来的 Phase 0/1 扩展到 Phase 2 主路径：

1. **cache usage 显示路径已修复**：DeepSeek 合并 SSE 帧中的 `usage` 不再被丢弃。
2. **frozen prefix 的主要字节泄漏已修复**：`consolidatedBlock` 不再拼进 `volatileBlock`。
3. **消息历史 append-only 方向已落地**：prune 不再通过 `replaceMessages` 修改 session storage。
4. **cachedFreshBlock 已切到 trailer mode**：不再作为独立 user message 在历史中滑动。
5. **1M+ context window 下常规 compaction / observation masking 已跳过**：以 session split + 95% emergency ceiling 替代。
6. **86% proactive session split 已实现**：分裂前保留 cache anchors，并把 handoff summary 作为新 user message。

换句话说，旧文档里的“Phase 2 未完成”已经过期；当前剩余工作主要是**实测 cache-log / billing 复核**与**Phase 3 可选优化**。

---

## 已完成的关键提交

### Phase 0：修复 cache usage 显示（`42a6760`）

**问题**：cache-log 始终显示 0%，但 billing 确认已有约 90% 实际命中。

**根因**：DeepSeek 把 `finish_reason` 和 `usage`（含 `prompt_cache_hit_tokens`）放在同一帧 SSE chunk 里，而 `processDelta` 只处理分离帧场景。合并帧时 usage 被静默丢弃。

**修复**：`src/api/openai-client.ts` 在 `processDelta` 中新增合并帧检测，当 `finish_reason` 和 `usage` 同帧到达时立即 emit stop/usage 事件。

**测试**：`src/api/__tests__/openai-client.test.ts` 增加合并帧 cache stats 用例。

### Phase 1.1：`consolidatedBlock` 移出 frozen prefix（`a23724c`）

**问题**：field-habituation tracker 触发 promotion 时，旧逻辑会把 `consolidatedBlock` 拼进 `volatileBlock`，导致 frozen prefix 字节变化。实测出现过 Turn 4: 92.9% → Turn 5: 69.7% 的锯齿。

**修复**：`src/prompt/engine.ts` 保持 `volatileBlock === frozenBase`；`consolidatedBlock` 改为注入 dynamic appendix。

**测试**：`src/prompt/__tests__/engine.test.ts` 增加 P1.1a/P1.1b，断言 habituation promotion 后 frozen prefix 不变，consolidated 内容只进入动态注入区域。

### Phase 1.2：prune 改为 request-time mask / 不再改 storage（`30637de`）

**问题**：`pruneStaleToolResults` 的结果曾通过 `session.replaceMessages()` 写回 storage，破坏消息历史字节连续性。

**修复**：`src/agent/compaction-controller.ts` 只计算 prune 统计并记录日志，不再替换 session messages。

**测试**：`src/agent/__tests__/compaction-controller.test.ts` 增加 P1.2，断言 `maybeCompact()` 后 session message content 不变。

### Phase 1.3：工具结果 trailing whitespace 归一化（`ab2996c`）

**问题**：工具输出中的 trailing whitespace 会制造无意义字节差异，导致偶发 miss。

**修复**：`src/agent/tool-pipeline.ts` 在 post-hook 后对最终 tool result 做 `trimEnd()`。

**测试**：`src/agent/__tests__/tool-pipeline.test.ts` 覆盖归一化行为。

### Trailer Mode：`cachedFreshBlock` 合并进最后一条 user message（`2e37179` + `974699a`）

**问题**：旧逻辑把 `cachedFreshBlock` 作为独立 user message 插入在 `lastUserIdx` 前。下一轮用户消息到来时，独立消息位置滑动，导致从该位置之后 prefix 全部失效。

**修复**：`src/prompt/engine.ts` 改为 trailer mode：

```text
最后一条 user message content = cachedFreshBlock + "\n---\n" + 原始用户输入
```

不再 push 独立 cachedFreshBlock message。

**测试**：`src/prompt/__tests__/engine.test.ts` 增加 P2，用例断言 user message 数量不增加，cachedFreshBlock 被合并到最后 user content。

### Phase 2.1：1M+ window 跳过常规 compaction（代码已在当前基线中）

**行为**：`src/agent/compaction-controller.ts` 中，当 `contextWindow >= 1_000_000` 时，`maybeCompact()` 在 prune 统计后直接返回 `{ compacted: false }`，不再触发 `microCompactOai()`。

**保留的安全阀**：`enforceContextCeiling()` 仍在 95% ceiling 触发 checkpoint resume，这是 emergency last resort。

**测试**：`src/agent/__tests__/compaction-controller.test.ts` 覆盖：

- P2.1：1M+ window 即使超过常规 compact threshold 也不 compact。
- P2.1：1M+ window 超过 95% hard ceiling 时仍会 checkpoint resume。

### Phase 2.2：1M+ window 跳过 observation masking（`3654672` → `a09e4ca` → `27a6679`）

**问题**：observation masking 会替换旧 tool message content。即使它只发生在 request 构建阶段，也会改变发送给 DeepSeek 的历史字节，从而破坏 exact-prefix cache。

**最终修复**：`src/prompt/engine.ts` 中，当 `contextWindow >= 1_000_000` 时完全跳过 observation masking；小窗口仍保留原 MASK_WINDOW 逻辑。

**测试**：`src/prompt/__tests__/engine.test.ts` P2.2 断言 85 turns 下 1M window 不 mask，重复 build 得到稳定内容。

### Phase 2.3：86% proactive session split（`ed54f59` + `d858678` + `7c27770`）

**目标**：用 session split 替代 compaction，在 context 达到 86% 时主动缩短历史，保留 cache anchors。

**实现**：`src/agent/compaction-controller.ts` 新增/完善 `trySessionSplit()`：

- 仅在 `contextWindow >= 500_000` 时启用。
- token ratio `< 0.86` 时不触发。
- 触发后保留 `CACHE_ANCHOR_MESSAGES`，追加 `<session-handoff>` user message。
- handoff 包含 task state、recent tools、failures、files seen、recent assistant reasoning。
- `replaceWithCheckpoint()` 被抽出，供 session split 和 95% ceiling 共用。

**关键修正**：`7c27770` 把 `trySessionSplit()` 移到 `addUserMessage()` 之前，避免 split 刚发生时把新用户输入替换掉，造成 message loss。

**测试**：`src/agent/__tests__/compaction-controller.test.ts` 覆盖 86% 触发、低于阈值不触发、小窗口不触发、与 `enforceContextCeiling()` 结构等价等路径。

---

## 已提交的 session runtime 隔离改动

提交：`386b8aa fix(agent): isolate per-session state files to prevent multi-process corruption`

相关文件：

- `src/agent/loop.ts`
- `src/agent/telemetry-writer.ts`
- `src/agent/worker-session.ts`

行为：

- `sensorium.jsonl` 从 `.rivet/sensorium.jsonl` 迁移到 `.rivet/sessions/<sessionId>/sensorium.jsonl`。
- `cache-log.jsonl` 从 `.rivet/cache-log.jsonl` 迁移到 `.rivet/sessions/<sessionId>/cache-log.jsonl`。
- `pheromones.json` / `heuristics.jsonl` 也改为 session scoped 路径。
- worker session 显式传入 `sessionId: worker-<order.id>`，避免多个 worker 写同一 runtime 文件。

这与多会话隔离目标一致。排障时需要优先查看 session scoped 路径；旧 bundle / 旧 commit 才可能继续写 `.rivet/cache-log.jsonl`。

---

## 现在怎么验证

```bash
npx tsc --noEmit
npx tsx --test src/prompt/__tests__/engine.test.ts src/agent/__tests__/compaction-controller.test.ts src/api/__tests__/openai-client.test.ts src/agent/__tests__/tool-pipeline.test.ts
```

### 启动实测

```bash
cd /Users/banxia/app/deepseek-tui/opencode-tui
npm run build
node dist/main.js
```

### 观察 cache 日志

当前默认看：

```bash
tail -f /Users/banxia/app/deepseek-tui/opencode-tui/.rivet/sessions/<sessionId>/cache-log.jsonl
```

如果运行的是旧 commit / 旧 bundle，则仍可能是：

```bash
tail -f /Users/banxia/app/deepseek-tui/opencode-tui/.rivet/cache-log.jsonl
```

### 预期结果

| 指标 | 修复前 | 当前预期 |
|------|--------|----------|
| cache-log 显示 | 始终 0% | 能显示 DeepSeek usage 中的实际 cacheRead/cacheCreate |
| 首轮 | 0% 冷启动 | 仍然正常为 0% 或低命中 |
| cachedFreshBlock 跨用户轮次 | 位置滑动，常见 >10% 骤降 | trailer mode 后不再因独立消息滑动造成骤降 |
| habituation promotion | 可能 -20% 锯齿 | frozen prefix 不变 |
| 1M+ observation masking | 旧 tool content 被替换 | 完全跳过 masking |
| 1M+ regular compaction | 可能重写历史 | `maybeCompact()` 跳过 |
| 86% context | 继续逼近 95% ceiling | 提前 session split |

---

## 剩余工作

### 必做

1. **实测 cache-log**：用真实 DeepSeek API 跑 20+ turns，确认 trailer mode / skip masking 后不再出现由注入位置滑动导致的 >10% 命中率骤降。
2. **确认当前 worktree 里仍未提交的 artifact marker 注释 / 测试归属**：如果继续保留，应单独提交。
3. **更新与 runtime 路径相关的文档/排障指南**：如果 session scoped cache-log 成为正式行为，所有 `.rivet/cache-log.jsonl` 示例都应改为兼容两种路径。

### 可选 Phase 3

1. **客户端工具修复 pipeline**：减少模型因 tool-call JSON 失败而重试。
2. **System prompt HCA 步幅对齐**：研究 128-token HCA 边界对 DeepSeek V4 压缩缓存的影响。
3. **工具结果确定性增强**：除 trailing whitespace 外，继续评估 JSON key 排序、并行工具结果稳定排序是否必要。

---

## 注意事项

- 修改 `src/prompt/static.ts` 或 tool definitions 仍会导致下一轮 prefix cache miss，这是正常的 static prefix 变化。
- `session split` 会保留 cache anchors，但 handoff summary 本身是新 user message；它避免的是大规模历史重写，不代表该轮 100% 命中。
- 如果 cache-log 仍为 0%，先确认运行的是最新 build：`npm run build && node dist/main.js`。
- 如果使用 session scoped runtime 路径，排障时不要只看 `.rivet/cache-log.jsonl`；还要看 `.rivet/sessions/<sessionId>/cache-log.jsonl`。

# Phase 0：修复 DeepSeek Cache 命中率显示

## 状态更新（2026-05-25）

已解决：`42a6760 fix(api): handle combined finish_reason + usage SSE chunk for DeepSeek cache stats`。

该计划保留为实施记录；当前 `src/api/openai-client.ts` 已覆盖 DeepSeek 将 `finish_reason` 与 `usage` 放在同一个 SSE chunk 的场景，`src/api/__tests__/openai-client.test.ts` 已有对应测试。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 TUI cache-log 始终显示 0% 的 bug，使其正确反映 DeepSeek API 实际返回的 `prompt_cache_hit_tokens`。

**架构：** 根因是 `OpenAIClient.processDelta()` 无法处理 DeepSeek 将 `finish_reason` 和 `usage` 合并到同一个 SSE chunk 的场景。当前代码假设这两个字段分两帧到达（OpenAI 行为），当它们合并在一帧时，`usage` 被静默丢弃，最终 `onStopReason` 收到空 `{}` → cache_read_input_tokens = 0。

**技术栈：** TypeScript strict, node:test + node:assert/strict

**关联设计文档：** `docs/superpowers/specs/2026-05-25-deepseek-cache-hit-rate-optimization-design.md`

---

## 1. Scope Check

此计划仅覆盖 Phase 0（修复 cache 显示）。Phase 1-3 的修复（workingSet 迁移、prune 去变异化、零 compaction）将在后续独立计划中实现。

Phase 0 的退出条件已明确：如果最终确认 DeepSeek API 完全不在 streaming response 中返回 `prompt_cache_hit_tokens`（而非解析 bug），则接受无法实时监控，降级为 billing 周期验证。但基于代码分析，组合 chunk 场景是更可能的原因。

## 2. 文件结构

### 修改

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/api/openai-client.ts:372-428` | `processDelta()` — 在 finish_reason 处理后检测同帧 usage | 加逻辑 |
| `src/api/__tests__/openai-client.test.ts` | 新增测试：合并 chunk 场景覆盖 | 加测试 |

### 不变

- `src/api/provider.ts` — `mapDeepSeekUsage` 字段映射正确，无需修改
- `src/agent/turn-stream.ts` — 正常接收 `onStopReason` usage，无需修改
- `src/agent/context.ts` — `recordTurnCache` / `addUsage` 写入路径正确，无需修改
- `src/config/default.ts` — DeepSeek `unsupported: []`，`stream_options` 已发送，无需修改

## 3. 任务

### 任务 1：添加合并 chunk 场景的失败测试

**文件：** `src/api/__tests__/openai-client.test.ts`

**操作：** 在现有测试用例后追加新测试（约在 line 315 `it('6: maps insufficient_system_resource...'` 之前）。

**插入位置：** 第 5 个测试 (`it('5: extracts DeepSeek cache stats from usage chunk')`) 和第 6 个测试之间。

**完整测试代码：**

```typescript
  it('5a: extracts DeepSeek cache stats from COMBINED chunk (finish_reason + usage in one frame)', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    // Single combined chunk: finish_reason AND usage in the same SSE frame.
    // This is the DeepSeek behavior — unlike OpenAI which sends usage as a
    // separate trailing chunk.
    client.processDelta(
      {
        choices: [{ delta: { content: 'final text' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
      },
      callbacks,
    )

    assert.equal(stopReason, 'end_turn')
    assert.equal(stopUsage.cache_read_input_tokens, 60)
    assert.equal(stopUsage.cache_creation_input_tokens, 40)
    assert.equal(stopUsage.input_tokens, 100)
    assert.equal(stopUsage.output_tokens, 20)
  })
```

**验证命令：** `npx tsx --test src/api/__tests__/openai-client.test.ts --test-name-pattern="5a"`

**预期结果：** 测试失败，`stopUsage` 为 `null` 或 `cache_read_input_tokens` 为 `undefined`（因为合并 chunk 场景下 usage 被静默丢弃）。

### 任务 2：实现合并 chunk usage 提取

**文件：** `src/api/openai-client.ts`

**位置：** `processDelta()` 方法，`if (choice.finish_reason)` 块之后（当前约第 426-428 行），`}` 闭合 `processDelta` 方法之前。

**当前代码（lines 425-428）：**
```typescript
    if (choice.finish_reason) {
      this.flushToolCalls(callbacks)
      // Buffer the stop reason — will be emitted when usage chunk arrives
      this.pendingStopReason = choice.finish_reason
    }
  }
```

**修改为：**
```typescript
    if (choice.finish_reason) {
      this.flushToolCalls(callbacks)
      // Buffer the stop reason — will be emitted when usage chunk arrives
      this.pendingStopReason = choice.finish_reason
    }

    // If usage arrived together with finish_reason in the same SSE chunk,
    // emit onStopReason immediately with usage data. This handles providers
    // (DeepSeek) that combine finish_reason + usage into one chunk, unlike
    // OpenAI which sends usage as a separate trailing chunk.
    // Must run AFTER flushToolCalls (tool_use content blocks emitted first)
    // and AFTER pendingStopReason is set (so we can read it here).
    if (chunk.usage && this.pendingStopReason !== null) {
      const usage = chunk.usage
      const stopReason = this.pendingStopReason
      this.pendingStopReason = null
      const cacheRead = usage.prompt_cache_hit_tokens ?? 0
      callbacks.onStopReason?.(mapFinishReason(stopReason), {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0,
      })
    }
  }
```

**场景覆盖分析：**

| 场景 | `chunk.usage` | `this.pendingStopReason` | `choice` | 行为 |
|------|:--:|:--:|:--:|------|
| A. 合并 chunk（DeepSeek） | ✅ | ✅（刚设置） | 有 | 新增分支：emit onStopReason 带 usage ✅ |
| B. 分离 chunk（OpenAI）第一帧 | ❌ | ✅ | 有 | 跳过新分支 → 等 usage chunk ✅ |
| C. 分离 chunk 第二帧 | ✅ | ✅ | 无 | 已有分支：emit onStopReason 带 usage ✅ |
| D. 无 usage（旧版 API） | ❌ | ✅ | 有 | 跳过新分支 → finally 块 emit 空 {} ✅ |
| E. 中间 delta（无 finish） | ❌ | null | 有 | 跳过所有分支 ✅ |

**验证命令：** `npx tsx --test src/api/__tests__/openai-client.test.ts --test-name-pattern="5a"`

**预期结果：** 测试通过。

### 任务 3：运行现有测试确保无回归

**验证命令：**
```bash
npx tsc --noEmit && npx tsx --test src/api/__tests__/openai-client.test.ts
```

**预期结果：** 所有测试通过，特别是测试 5（分离 chunk 的 cache stats 提取）和 6（`insufficient_system_resource` 映射）不应被破坏。

### 任务 4：全量测试 + 类型检查

**验证命令：**
```bash
npx tsc --noEmit && npx tsx --test src/**/__tests__/*.test.ts
```

**预期结果：** 类型检查通过，全部测试通过。

### 任务 5：提交

```bash
git add src/api/openai-client.ts src/api/__tests__/openai-client.test.ts
git commit -m "fix(api): handle combined finish_reason + usage SSE chunk for DeepSeek cache stats

DeepSeek sends usage (including prompt_cache_hit_tokens) in the same SSE
chunk as the final delta with finish_reason, unlike OpenAI which sends
usage as a separate trailing chunk. The existing processDelta only
handled the separate-chunk case — when the chunk had both choices and
usage, the usage was silently dropped, resulting in cache-log showing
0% hit rate despite actual ~90% cache utilization.

Fix: after setting pendingStopReason, check if chunk.usage is also
present and emit onStopReason immediately with usage data."
```

## 4. 验证

### 最小验证（每次提交前）
```bash
npx tsc --noEmit && npx tsx --test src/api/__tests__/openai-client.test.ts
```

### 完整验证（Phase 0 完成时）
```bash
npx tsc --noEmit && npx tsx --test src/**/__tests__/*.test.ts
```

### 手动验证（运行时）
启动 TUI 进行一次对话，观察 cache-log 文件（位于 `.rivet/sessions/<sessionId>/cache-log.jsonl`，旧 commit 可能仍写 `.rivet/cache-log.jsonl`）中的 `hitRate` 字段从 0% 变为非零值。

注意：首轮对话 hitRate 始终为 0%（冷启动，无 prefix cache），需从第 2 轮开始观察。

### 退出条件检查
如果修复后 cache-log 仍然显示 0%（即 DeepSeek 确实不在 API response 中返回 `prompt_cache_hit_tokens`），则：
- 在 `processDelta` 中添加 `console.warn` 日志记录实际收到的 usage 字段名
- 根据实际字段名调整解析逻辑
- 如果确认无 cache 字段，降级为 billing 周期验证

## 5. 自检

### 规范覆盖
| 需求 | 任务 | 状态 |
|------|------|------|
| 修复合并 chunk 场景的 usage 丢失 | 任务 2 | ✅ |
| 测试覆盖合并 chunk 场景 | 任务 1 | ✅ |
| 不破坏现有分离 chunk 场景 | 任务 3 | ✅ |
| 不破坏无 usage 场景（旧 API） | 任务 3 | ✅ |
| 类型检查通过 | 任务 4 | ✅ |
| 提交 | 任务 5 | ✅ |

### 占位符扫描
- [x] 无 TODO / TBD / 待定
- [x] 无"添加适当的错误处理"等模糊描述
- [x] 无"类似任务 N"
- [x] 所有类型、函数、方法在使用前已定义
- [x] 所有文件路径和行号精确

### 类型一致性
- `processDelta` 的 `chunk.usage` 类型已定义在方法签名中（`usage?: { prompt_tokens?: number; ...; prompt_cache_hit_tokens?: number; ... }`）
- `mapFinishReason` 函数签名：`(reason: string) => string` → `'stop' | 'tool_calls' | 'length' | 'insufficient_system_resource'` → `'end_turn' | 'tool_use' | 'max_tokens'`
- `onStopReason` 回调签名：`(reason: string, usage: Record<string, number>) => void`
- 新分支中使用的所有变量（`chunk.usage`, `this.pendingStopReason`, `mapFinishReason`, `callbacks.onStopReason`）均在作用域内定义且类型一致

## 6. 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-25-phase0-修复cache显示.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？

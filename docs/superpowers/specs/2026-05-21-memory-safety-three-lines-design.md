# 三道防线内存安全架构

> **日期**：2026-05-21
> **视角**：天璇（Opus 4.6 · 边界行走者）
> **方法**：Deep Brainstorm（4 方案变异 → 选择 → 适应）
> **问题**：天枢 TUI 几轮对话就爆内存（512MB RSS 限制）

---

## 元问题

天枢运行在 512MB RSS 限制的 Node.js 进程中。当模型调用工具读取大文件或多轮累积 tool_result 时，messages 数组在 V8 堆中无界增长，直到 RSS 触发 85% 阈值 → reliability mode 降级为 minimal → 所有写工具被 block → 会话失效。

**触发链**（实际案例）：
```
read_file(2.2MB html) → readFileSync 全文入堆(~10MB 瞬时峰值)
  → 虽然 modelContent 只有 8K chars，但 rawContent 在堆中存活到 GC
  → 多轮累积: 每轮 ~30K tokens tool_result × N轮
  → RSS 从 200MB → 460MB (89.8% of 512MB)
  → reliability mode = minimal → 会话死亡
```

**根因**：不是单一入口的问题，是三个问题叠加：
1. 单次大文件读取的瞬时堆峰值（无预检）
2. 多轮 tool_result 在 messages 数组中无界累积
3. compaction 触发太晚（cache-preserving 策略下 86%）

---

## 方案演化过程

### 淘汰方案

| 方案 | 灭绝原因 |
|------|---------|
| V4: 轮末 LLM 摘要 | 每轮改写历史 → prefix cache miss；额外 LLM 调用成本 |

### 存活方案融合

V1(入口截断) + V2(轮预算) + V3(虚拟引用) → 三道防线

---

## 架构设计

```
工具调用 → [第一道防线: 入口截断] → 执行 → [第二道防线: 轮预算] → messages
                                                                      ↓
                                              [第三道防线: 轮末主动压缩] ← 轮结束
```

### 第一道防线：入口截断

**目标**：防止大内容进入 V8 堆。

**改动点**：`src/tools/read-file.ts`

```typescript
// 在 readFilePayload 中，existsSync 之后加：
const fileStat = statSync(filePath)
if (fileStat.size > MAX_TOOL_INPUT_BYTES && !options.offset && !options.limit) {
  throw new Error(
    `File too large (${(fileStat.size / 1024).toFixed(0)}KB). ` +
    `Use offset and limit parameters to read specific ranges. ` +
    `Total lines: ~${Math.ceil(fileStat.size / 80)}`
  )
}
```

**常量**：
- `MAX_TOOL_INPUT_BYTES = 100 * 1024` (100KB)
- bash stdout 上限：100K → 32K chars
- grep 输出上限：12K → 8K chars

**效果**：单次工具调用永远不会把超过 100KB 的字符串读入堆。

---

### 第二道防线：轮预算

**目标**：控制单轮所有 tool_result 进入 messages 的总量。

**新文件**：`src/agent/turn-budget.ts`

```typescript
export interface TurnBudget {
  maxTokensPerTurn: number
  usedTokens: number
  isExhausted(): boolean
  consume(tokens: number): boolean
  reset(): void
}

const BASE_BUDGET = 50_000 // tokens
const PRESSURE_BUDGET = 25_000 // RSS > 70% 时

export function createTurnBudget(rssRatio: number): TurnBudget {
  const maxTokensPerTurn = rssRatio > 0.7 ? PRESSURE_BUDGET : BASE_BUDGET
  let usedTokens = 0
  return {
    maxTokensPerTurn,
    get usedTokens() { return usedTokens },
    isExhausted() { return usedTokens >= maxTokensPerTurn },
    consume(tokens: number) {
      usedTokens += tokens
      return usedTokens <= maxTokensPerTurn
    },
    reset() { usedTokens = 0 },
  }
}
```

**集成点**：`src/agent/tool-pipeline.ts` 第 327 行之后

```typescript
// 预算检查：超出则降级为引用
const tokenEstimate = Math.ceil(finalContent.length / 4)
if (!turnBudget.consume(tokenEstimate)) {
  // rawPath 已经由 persistRawOutput 存好了
  finalContent = `<stored ref="${rawToolResult?.rawPath}" chars=${finalContent.length} tool="${tu.name}">\n${finalContent.slice(0, 500)}\n...(budget exceeded, use read_file with offset/limit for full content)</stored>`
}
```

**与 resource-sensor 联动**：
- RSS < 70%: 正常预算 50K tokens
- RSS 70-85%: 收紧到 25K tokens
- RSS > 85%: 0 预算（所有 tool_result 只存引用）

---

### 第三道防线：轮末主动压缩

**目标**：历史轮的 tool_result 在不再需要后自动降级。

**时机**：每轮 API 调用返回后、下一轮开始前。

**规则**：
- 保留 cache anchor messages (前 2 条) 不变
- 保留最近 2 轮 (N, N-1) 的 tool_result 完整
- N-2 及更早的 tool_result 截断为 1200 chars（复用 `compactToolResultBlock` 逻辑）
- 如果本轮已触发 smartCompact/microCompact，跳过轮末压缩（避免重复）

**集成点**：`src/agent/loop.ts` 轮末，在 `maybeCompact` 之前

```typescript
// 轮末主动压缩：N-2+ 轮的 tool_result 降级
if (!compactResult.compacted) {
  this.staleRoundCompact()
}
```

**实现**：复用 `compactToolResultBlock`，只是把触发时机从"compaction 阈值"提前到"轮末常规"。

---

## 与现有系统的协同

| 现有组件 | 协同方式 |
|---------|---------|
| `output-store.ts` (persistRawOutput) | 第二道防线的引用目标已经存好了 |
| `resource-sensor.ts` | 第二道防线读取 RSS ratio 动态调预算 |
| `compactToolResultBlock` (micro.ts) | 第三道防线复用其截断逻辑 |
| `CompactionController` | 第三道防线与 maybeCompact 互斥（避免重复） |
| `CACHE_ANCHOR_MESSAGES` | 三道防线都不触碰 cache anchor |
| `truncateContent` (truncation.ts) | 第一道防线的截断格式复用 |

---

## 内存预算计算

| 场景 | 无防线 | 三道防线 |
|------|--------|---------|
| 单次读 2.2MB 文件 | +10MB 瞬时峰值 | 被第一道拒绝(0 增长) |
| 单轮 10 次工具调用 | +80K chars (~320KB) | 上限 50K tokens (~200KB) |
| 10 轮对话后 messages | ~2MB+ | ~400KB (历史被压缩) |
| 20 轮对话后 messages | ~4MB+ | ~500KB (增长趋于平坦) |
| RSS 增长趋势 | ~20MB/轮 | ~2MB/轮 |

**预期效果**：从"几轮就爆"变为"几十轮仍安全"。

---

## 风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 模型因截断看不到关键内容 | 中 | 引用包含 preview(前500chars) + 行数 + 建议用 offset/limit |
| 第三道防线触发 cache miss | 低 | 只压缩 N-2+ 轮，与 KEEP_RECENT_MESSAGES=4 对齐 |
| 预算太紧影响复杂任务 | 低 | RSS<70% 时预算 50K，足够 10+ 次完整工具调用 |
| statSync 本身的性能开销 | 极低 | statSync 是 O(1) 系统调用 |

---

## 实施路径

### Phase 1（1小时）：第一道防线
1. `read-file.ts`: 加 statSync 预检 + 大文件拒绝
2. `bash.ts`: stdout 上限 100K → 32K
3. `grep.ts`: 输出上限 12K → 8K
4. 测试：读取 >100KB 文件应返回错误提示

### Phase 2（2小时）：第二道防线
1. 新建 `src/agent/turn-budget.ts`
2. `tool-pipeline.ts`: 集成轮预算检查
3. `loop.ts`: 每轮开始时 reset 预算，传入 RSS ratio
4. 测试：单轮超过 50K tokens 的 tool_result 应降级为引用

### Phase 3（2小时）：第三道防线
1. `loop.ts`: 轮末调用 staleRoundCompact
2. 复用 `compactToolResultBlock` 逻辑
3. 与 maybeCompact 互斥控制
4. 测试：N-2 轮的 tool_result 应被压缩到 1200 chars

### Phase 4（30分钟）：集成验证
1. 模拟 20 轮对话，监控 RSS 增长曲线
2. 验证 prefix cache hit rate 不降
3. 验证模型仍能完成编码任务

---

## 退出条件

- 如果第一道防线导致模型无法完成任务 → 放宽到 200KB
- 如果第二道防线预算太紧 → 提高到 80K tokens
- 如果第三道防线导致 cache miss > 20% → 推迟到 N-4 轮再压缩
- 如果三道防线组合后 RSS 增长仍 > 5MB/轮 → 需要更激进的方案（如降低 contextWindow）

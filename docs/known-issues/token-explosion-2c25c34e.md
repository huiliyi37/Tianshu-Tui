# Token 爆炸问题分析 — 会话 2c25c34e

> 状态：已修复（2026-06-11） | 优先级：P1 | 发现日期：2025-06-10
>
> ## 修复落点
>
> - **P0 每 turn 调用数**：T4 storm guard（`tool-accumulator.ts` 4+ 连续同类调用折叠）+ 8+ 次 storm 警告注入 — `5482542`
> - **P1 更早截断**：1M 窗口 60% partial LLM compact / 75% full compact（`compaction-controller.ts`）；per-tool-type 预算 + per-turn read 预算（15% window）+ >70% context-pressure 截断（`per-message-budget.ts`）— `5482542`
> - **P2 tool result 体积上限**：T10 写前分层（`tool-result-tiering.ts`，tier 0/1/2，8K/150K 阈值）— `5bb36a1`；后续收口：read_file/read_section 豁免 tiering（自有 cap 链 + 保全 read→edit）、复用工具级 artifact 避免重复落盘、steer 注入移至所有变换之后防止被 tier-2 替换吞掉
> - **P3 监控**：T9 GlanceBar 真实 session ctx% 指标已落地

## 现象

- **模型**：DeepSeek（通过 opencode.ai/zen/go 代理路由，metadata 记录为 `qwen3.7-max` 因为 config alias 映射）
- **会话**：24 个用户消息，273 次 API 调用，231 次带 tool_calls
- **Prompt tokens**：124,074,872（1.24 亿）
- **Completion tokens**：90,152
- **总费用**：约 $7.87

## 根因定位

### 1. Agentic loop 每 turn 过多 API 调用（主因）

`src/agent/loop.ts:1788` 的 `for (let turn = 0; turn < maxTurns; turn++)` 循环中，每次 tool call 完成后都重发**完整累积上下文**：

| Turn | API 调用数 | Input 范围 | Input 总和 |
|------|-----------|-----------|-----------|
| T0   | 15 次     | 16K → 371K | 3,684,930 |
| T1   | 14 次     | 56K → 367K | 3,336,573 |
| T10  | 10 次     | 57K → 359K | 2,382,320 |
| T20  | 6 次      | ~197K avg  | 1,185,494 |
| T35  | 1 次      | 258K       | 257,967   |

单轮最多 15 次 API 调用，每次都带着完整的累积对话历史。

### 2. Tool result 未截断，context 持续膨胀

243 个 tool result（`read_file`、`grep`、`bash` 等）全部保留在上下文中。input 从 16K 增长到 370K，增幅 23 倍。

### 3. 压缩触发阈值对 1M context window 过高

`src/agent/loop.ts:1713` 的 token gate：
```typescript
const tokenRatio = tokenBudget / contextWindow
const skipGate = tokenRatio < 0.5  // 1M × 0.5 = 500K 才触发
```
contextWindow 配置为 1,000,000，50% 阈值 = 500K tokens 才开始压缩。在 500K 之前，所有 tool result 原样累积。

### 4. 压缩生效后调用数下降但仍不够

Turn 17 开始压缩生效（调用数从 9 降到 7），Turn 27 后降到 3，Turn 35 后降到 1。但此时已经烧了大量 token。

## 缓存数据

| 指标 | 值 |
|------|------|
| Cache log 总 input | 62,037,436 |
| Cache read 命中 | 60,142,464 |
| Cache create | 1,894,972 |
| Metadata prompt tokens | 124,074,872 |
| 差异（2x） | DeepSeek prefix cache billing: 命中部分仍按全量计费或 cache log 只记录了部分 |

## 修复方案

### P0：降低每 turn 最大 API 调用数

- **位置**：`src/agent/loop.ts` agentic loop
- **方案**：当单 turn 内 tool call 轮次超过阈值（如 8）且 context 超过 30% window 时，强制触发压缩或要求模型产出最终回复
- **预期效果**：T0 从 15 次降到 ≤8 次，节省 ~40% token

### P1：更早触发 tool result 截断/摘要

- **位置**：`src/compact/micro.ts`、`src/agent/loop.ts` stale-round compaction
- **方案**：将 50% token gate 降到 30%（1M window 下 300K 就开始截断旧 tool result），或改为绝对值阈值（如 200K）
- **预期效果**：context 增长曲线变缓，从 16K→370K 降到 16K→200K

### P2：Tool result 体积上限

- **位置**：`src/tools/` 各工具的 execute 返回值
- **方案**：所有 tool result 超过 4000 tokens 时自动截断，保留头尾，中间用 `[...truncated N tokens...]` 替代
- **预期效果**：单次 tool call 不再注入大量内容

### P3：监控告警

- **位置**：`src/agent/loop.ts` turn 结束时
- **方案**：当单 turn prompt tokens 超过 contextWindow 的 40% 时，在 TUI 显示警告

## 数据来源

- Cache log: `.rivet/sessions/2c25c34e-f09f-46e1-9cf8-54734fd2db7b/cache-log.jsonl`
- Session log: `~/.rivet/sessions/2c25c34e-f09f-46e1-9cf8-54734fd2db7b.jsonl`
- Sensorium: `.rivet/sessions/2c25c34e-f09f-46e1-9cf8-54734fd2db7b/sensorium.jsonl`
- Config: `~/.rivet/config.json` — `opencode-go-anthropic` provider, alias `opus-4-8` → `qwen3.7-max`

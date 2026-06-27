# 修复 TUI GlanceBar 上下文进度与 API 实际 token 不一致

# 修复 TUI GlanceBar 上下文进度与 API 实际 token 不一致

## 1. 问题描述

TUI 底部 GlanceBar 显示 `◧Xk/Yk`（如 `◧50k/200k`），表示当前上下文用量占模型窗口的比例。用户反馈这个进度与实际上下文 token 不一致。

**具体症状**：
- GlanceBar 显示的 token 数偏小或偏大，与 `/context` 命令中的 `input_tokens` 对不上
- compaction 后 GlanceBar 骤降，但下一轮 API 请求的实际 token 数远高于显示值
- `/model` 切换后 prefixOverhead 不更新，导致系统估算偏离实际

## 2. 根因分析

```mermaid
flowchart TD
    subgraph "TUI 显示路径（启发式）"
        G[GlanceBar ◧Xk/Yk] -->|读取| M[TuiMetrics.estimatedTokens]
        M -->|来自| P[metricsProvider 闭包]
        P -->|调用| E[session.getEstimatedTokens()]
        E -->|返回| H[state.estimatedTokens + state.prefixOverhead]
        H -->|estimatedTokens 来源| HE[estimateOaiMessageTokens msg-by-msg char/4 累加]
        H -->|prefixOverhead 来源| PO[CompactionController.ensurePrefixOverhead 一次性设入]
    end

    subgraph "API 实际路径"
        API[DeepSeek API] -->|返回| U[usage.prompt_tokens / input_tokens]
        U -->|累加到| TU[session.state.totalUsage]
        TU -->|读取| CTX[/context 命令显示]
    end

    G -.->|❌ 不一致| CTX

    classDef heuristic fill:#1e1b4b,stroke:#fbbf24,color:#fef3c7
    classDef real fill:#1e293b,stroke:#38bdf8,color:#e0f2fe
    class G,M,P,E,H,HE,PO heuristic
    class API,U,TU,CTX real
```

**三处断裂点**：

| # | 断裂点 | 文件:行 | 机制 |
|---|--------|---------|------|
| 1 | 启发式估算法 ≠ 真实 tokenizer | `src/compact/micro.ts:51` | `ASCII/4 + CJK/1.5` vs BPE tokenizer；message 越长偏差越大 |
| 2 | prefixOverhead 一次设永不过期 | `src/agent/context.ts:285` + `src/agent/compaction-controller.ts:285` | `/model` 切换后 tool schema 变了但 overhead 不变 |
| 3 | 累计 vs 瞬时混淆 | `src/agent/context.ts:293` vs `src/agent/context.ts:253` | `/context` 同时展示 `estimatedTokens`（瞬时）和 `input_tokens`（累计），用户对比看到差异 |

## 3. 设计方案

### 核心策略：API 真实值校准 + prefixOverhead 自动更新

不做"用 API 值完全替代启发式"（API 值是请求后才有，且是单次请求的 prompt token 而非"当前上下文大小"），而是：**保留启发式作为实时显示基础，在每轮 API 响应后自动校准**。

```mermaid
flowchart TD
    subgraph "修复后"
        MSG[消息变更] -->|addUserMessage / addAssistantBlocks / compact| HE2[estimateOaiMessageTokens]
        HE2 --> ES[state.estimatedTokens]

        API2[API 响应] -->|usage.prompt_tokens| CAL[校准逻辑]
        CAL -->|写入| RC[state.lastRealPromptTokens]
        CAL -->|触发| PO2[recalcPrefixOverhead]

        PO2 -->|更新| ES

        G2[GlanceBar] -->|读取| M2[TuiMetrics]
        M2 -->|estimatedTokens =| ES
        M2 -->|lastRealPromptTokens =| RC

        CTX2[/context] -->|展示双值| ES
        CTX2 -->|展示双值| RC
    end

    classDef new fill:#022c22,stroke:#34d399,color:#d1fae5
    class G2,M2,ES,RC,CTX2,CAL,PO2 new
```

### 三个修复点

**① 每轮 API 响应后存储真实 prompt_tokens（`src/agent/context.ts`）**

在 `SessionContext` 中新增字段 `lastRealPromptTokens: number`，在 `recordTurnUsage()` 或新增方法中从 `Usage` 写入。GlanceBar 可选展示 "◧50k(实48k)/200k" 双值对比，或 hover/tooltip。

**② prefixOverhead 随模型切换自动重算（`src/agent/compaction-controller.ts`）**

当前 `ensurePrefixOverhead()` 是幂等的（第二次调用 no-op）。改为：增加 `force` 参数，`/model` 切换时调用 `ensurePrefixOverhead(force=true)` 强制重算。

**③ 改进 CJK 估算系数（`src/compact/micro.ts`）**

当前 `CJK/1.5` 对中文偏乐观（实际 DeepSeek tokenizer 中文约 1.2-1.8 char/token，波动大）。改用更保守的 `CJK/1.2` 减少低估风险，同时记录偏差供后续校准。

### 不改的

- `getEstimatedTokens()` 仍用启发式（实时性要求——请求前就需要显示）
- GlanceBar 格式不变（`◧Xk/Yk`），仅数据源更准
- Cockpit `/context` 面板同时展示 `estimatedTokens` 和 `lastRealPromptTokens`，让用户能看到两个值

## 4. 逐文件改动

### 4.1 `src/agent/context.ts`

```typescript
// SessionState 新增字段
export interface SessionState {
  // ... existing ...
  /** API 最近一轮返回的真实 prompt_tokens（校准基准） */
  lastRealPromptTokens: number
}

// getEstimatedTokens 不变，但新增 getter
getLastRealPromptTokens(): number {
  return this.state.lastRealPromptTokens
}

// recordTurnUsage 中同步写入
recordTurnUsage(usage: Usage): void {
  // ... existing ...
  if (usage.prompt_tokens !== undefined) {
    this.state.lastRealPromptTokens = usage.prompt_tokens
  }
}
```

### 4.2 `src/agent/compaction-controller.ts`

```typescript
// ensurePrefixOverhead 加 force 参数
ensurePrefixOverhead(force = false): void {
  if (!force && this._prefixOverheadSet) return
  // ... 重算 prefixOverhead ...
  this.deps.session.setPrefixOverhead(tokens)
  this._prefixOverheadSet = true
}
```

### 4.3 `src/compact/micro.ts`

```typescript
// CJK 系数从 1.5 → 1.2（更保守，减少低估）
return Math.ceil(asciiChars / 4) + Math.ceil(cjkChars / 1.2)
```

### 4.4 `src/main.ts`（metricsProvider）

```typescript
app.setMetricsProvider(() => {
  // ... existing ...
  return {
    estimatedTokens: session.getEstimatedTokens(),
    // 新增：最近一轮真实 prompt_tokens（供 GlanceBar 或 /context 展示）
    lastRealPromptTokens: session.getLastRealPromptTokens(),
    maxTokens,
    // ... existing ...
  }
})
```

### 4.5 `src/tui/engine/metrics-glance-controller.ts`

```typescript
// TuiMetrics 新增字段
export interface TuiMetrics {
  // ... existing ...
  /** API 最近一轮返回的真实 prompt_tokens（校准基准） */
  lastRealPromptTokens?: number
}
```

### 4.6 `/model` 切换处（`src/tui/engine/slash-router.ts` 或调用链）

`/model` 切换时触发 `compactionController.ensurePrefixOverhead(true)`。

### 4.7 `src/tui/format/glance-bar.ts`

不做结构性改动。可选：GlanceBar 增加 tooltip/hint 显示 `lastRealPromptTokens`，但首期只改进数据源精度即可。

### 4.8 `src/tui/slash-commands.ts`（`/context` 命令）

展示双值：
```
Context: healthy
Tokens (est): 50,000 / 200,000 (25%)
Tokens (API): 48,234 (last request)
```

## 5. 验证计划

### 单元测试

| 测试文件 | 测试内容 |
|----------|----------|
| `src/agent/__tests__/context.test.ts` | `lastRealPromptTokens` 读写；`recordTurnUsage` 同步写入 |
| `src/agent/__tests__/compaction-controller.test.ts` | `ensurePrefixOverhead(force=true)` 重算行为 |
| `src/compact/__tests__/micro.test.ts` | CJK/1.2 系数估算值变化（与旧值对比） |
| `src/tui/engine/__tests__/glance-metrics.test.ts` | `lastRealPromptTokens` 字段传递 |

### 集成验证

1. `npx tsc --noEmit` 零错误
2. 启动会话，发送消息 → 检查 GlanceBar 显示 vs `/context` 中 `lastRealPromptTokens`
3. `/model` 切换不同模型 → 确认 prefixOverhead 更新
4. compaction 后 → 确认 estimatedTokens 不剧烈偏离 lastRealPromptTokens

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| CJK/1.2 导致过度高估 → 过早触发 compaction | 可配置系数；首期用 1.2 保守值，后续根据实际偏差调优 |
| prompt_tokens 字段不是所有 provider 都返回 | 用 `usage.prompt_tokens ?? usage.input_tokens` 兜底 |
| force recalculation 增加首次请求延迟 | `/model` 切换是低频操作，可接受 |

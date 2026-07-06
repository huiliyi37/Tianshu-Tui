# 缺口④ 推理收敛守护 — 设计文档

> 状态：设计阶段（待评审）
> 关联：`docs/analysis/2026-07-03-discipline-hook-coverage-gap.md` 缺口④

## 问题空间

### 失效路径

模型开始推理 → 推理产生更多需要考虑的情况 → 继续推理展开子分支 → 推理链自我放大 → 单轮消耗 8000+ token 后超时或 max_tokens 截断，且未产出任何工具调用。

### 与其他收敛机制的关系

| 机制 | 覆盖 | 不覆盖 |
|------|------|--------|
| `exploration-stall` | 15+ 连续探索工具（read/grep/glob...）| 需要工具调用才计数；纯推理不触发 |
| `convergence-detector` `noToolTurnCount` | 连续无工具调用 3-5 轮 → abort | 不度量单轮推理长度；不区分"深度推理"和"推理螺旋" |
| `thinking-retry` | 单轮 thinking-only 响应 → 重试 1 次 | 只重试一轮；不检测跨轮加速增长 |
| `textRepetitionPenalty` | 跨轮文本重复 >70% → 降分 | 不重复的螺旋推理（每轮推不同方向）漏过 |
| GLM calibration prompt | 静态约束"每轮推理只产出两件事" | prompt 无运行时守护——淹没在推理惯性中 |

**核心缺口**：没有任何机制度量**单轮推理长度**。模型可以在一个 turn 输出 8000+ 字符的推理，不调用任何工具，也不触发任何现有检测器——直到超时。

### GLM 特殊风险

GLM 的 Preserved Thinking 在服务端累积推理状态。一旦进入推理螺旋，服务端状态会强化"继续推理"的轨迹，使模型更难自行跳出。这是 GLM 独有的正反馈风险——DeepSeek 的推理是无状态的（每轮从零开始），螺旋只影响单轮；GLM 的螺旋跨轮传染。

## 检测信号

### 主信号：单轮推理长度 × 工具调用

```
trigger = lastThinkingLength > THRESHOLD && lastTurnToolCount === 0
```

- `lastThinkingLength`：从 `thinkingAccum.length` 获取（streaming 阶段累积，turn 结束后通过 `TurnStateBag.lastThinkingContent` → `AgentLoop.lastThinkingContent` 写回）
- `lastTurnToolCount`：刚完成的 turn 是否有工具调用（布尔即可，精确计数非必须）

### 阈值分档

| 模型 | 阈值 | 理由 |
|------|------|------|
| default (DeepSeek) | 3000 chars | DeepSeek 单轮推理通常 ≤1500 chars；3000+ 已经是深度推理或螺旋 |
| GLM | 1500 chars | GLM calibration 明确要求"每轮推理只产出两件事"；1500+ 说明 prompt 约束已淹没 |

### 升级信号：加速螺旋

session-scoped 窗口跟踪最近 3 轮的推理长度。若长度单调递增 AND 每轮 toolCount == 0 → escalation advisory（更强措辞）。

## 干预设计

### 通道

`AdvisoryBus.submit`（`ttl: 1`），与现有 discipline hooks（探针残留、外部声称、lossy-observation）同通道。不碰 frozenBase / volatile block / prefix cache。

### Phase

**preTurn** — 在下一轮推理开始前注入 advisory。postTurn 注入会在 turn 间隙闲置；preTurn 确保模型在开始思考前看到提醒。

### Priority

`0.54`，discipline 类别。排在 language-anchor（0.52）之上、external-claim（0.56）之下。理由：推理螺旋直接导致 token 浪费和超时，比语言锚定更紧迫，但不如硬性安全约束（constitutional 0.9）。

### Content

**首次触发**（1 轮长推理无行动）：
```
上一轮输出了 [N] 字符推理但未调用任何工具。
若在分析瘫痪中，选一个最可能的方向用工具验证——工具结果比继续推理更能帮你收敛。
若任务本身就是分析/审查，输出结论而非继续扩展。
```

**升级触发**（连续 2+ 轮长推理无行动）：
```
连续 [N] 轮长推理未行动。推理链在自我放大。
停：用一个工具对当前最可能的假设打探针。如果工具证伪了它——那是进展，不是失败。
天璇胶囊（docs/seed-capsule-tianxuan.md）有换视角方法论可供 recall。
```

### Cooldown

每 2 轮最多触发 1 次（避免对同一螺旋反复提醒）。首次触发和升级触发不共享 cooldown——升级需要立刻通知。

### 误报控制

- 用户明确要求分析/审查/检查类任务时，长推理是正常行为。检测方案：若 prompt 中含"审查""分析""检查""review""audit""analyze"等关键词 → 阈值翻倍（6000 / 3000）
- `producingReport`（convergence-detector 已有）：若模型在产出实质性非重复文本报告 → 豁免。这个信号已由 convergence-detector 计算，可复用到 hook 中

### 环境变量

`RIVET_REASONING_SPIRAL_GUARD=0` 关闭（默认开启）。

## 实现概要

### 需修改的文件

```
src/agent/runtime-hooks.ts          # +lastThinkingLength, +lastTurnToolCount 到 RuntimeHookSnapshot
src/agent/loop-factory.ts           # buildRuntimeSnapshot 填充新字段
src/agent/turn-orchestrator.ts      # 每轮结束后写 lastTurnToolCount 到 TurnStateBag
src/agent/hooks/reasoning-spiral-hook.ts  # 新建：preTurn hook
src/agent/hooks/__tests__/reasoning-spiral-hook.test.ts  # 新建：测试
src/agent/create-runtime-hooks.ts   # 注册 hook
```

### 数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│ turn-orchestrator.ts                                                │
│   streamResult.thinkingAccum ─────────────────────────────────┐     │
│   toolUses.length ─────────────┐                                │     │
│                                ▼                                ▼     │
│   TurnStateBag.lastThinkingContent = thinkingAccum                    │
│   TurnStateBag.lastTurnToolCount  = toolUses.length                   │
│       │                                                               │
│       │  (getter/setter 代理到 AgentLoop)                             │
│       ▼                                                               │
│ AgentLoop.lastThinkingContent                                         │
│ AgentLoop.lastTurnToolCount                                           │
│       │                                                               │
│       │  buildRuntimeSnapshot()                                       │
│       ▼                                                               │
│ RuntimeHookSnapshot.lastThinkingLength = lastThinkingContent.length   │
│ RuntimeHookSnapshot.lastTurnToolCount  = lastTurnToolCount            │
│       │                                                               │
│       │  preTurn hook                                                │
│       ▼                                                               │
│ reasoning-spiral-hook.ts                                              │
│   判断: lastThinkingLength > THRESHOLD && lastTurnToolCount === 0    │
│   动作: AdvisoryBus.submit(advisory)                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Hook 伪代码

```typescript
// src/agent/hooks/reasoning-spiral-hook.ts
export function createReasoningSpiralHook(deps: {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}): PreTurnRuntimeHook {

  // session-scoped: 跟踪最近推理长度趋势（用于升级检测）
  const recentThinkingLengths: number[] = []
  let lastAdvisoryTurn = -1

  return {
    phase: 'preTurn',
    name: 'reasoning-spiral',
    run(ctx: RuntimeHookContext): void {
      const { lastThinkingLength, lastTurnToolCount, turn } = ctx.snapshot
      if (lastThinkingLength === undefined || lastTurnToolCount === undefined) return

      const isGlm = ctx.snapshot.sensorium?.modelFamily === 'glm'
      const threshold = isGlm ? 1500 : 3000

      // 误报豁免：用户明确要求分析/审查
      if (ctx.snapshot.sensoriumInput?.userRequestType === 'analysis') {
        threshold *= 2
      }

      // 未触发
      if (lastThinkingLength < threshold || lastTurnToolCount > 0) {
        recentThinkingLengths.length = 0  // 重置趋势
        return
      }

      // Cooldown
      if (turn - lastAdvisoryTurn < 2) return

      // 趋势跟踪
      recentThinkingLengths.push(lastThinkingLength)
      if (recentThinkingLengths.length > 3) recentThinkingLengths.shift()

      const isEscalating = recentThinkingLengths.length >= 2 &&
        recentThinkingLengths.every((v, i) => i === 0 || v > recentThinkingLengths[i - 1]!)

      lastAdvisoryTurn = turn

      deps.advisoryBus.submit({
        key: 'reasoning-spiral',
        priority: 0.54,
        category: 'discipline',
        ttl: 1,
        content: isEscalating
          ? `连续 ${recentThinkingLengths.length} 轮长推理未行动（${recentThinkingLengths.map(l => formatLength(l)).join(' → ')}）。推理链在自我放大。停：用一个工具对当前最可能的假设打探针。`
          : `上一轮输出了 ${formatLength(lastThinkingLength)} 推理但未调用任何工具。若在分析瘫痪中，选一个最可能的方向用工具验证。`,
      })
    },
  }
}
```

## 与 convergence-detector 的边界

| 维度 | convergence-detector | reasoning-spiral-hook |
|------|---------------------|----------------------|
| 检测对象 | 多轮工具调用模式（7 信号加权） | 单轮推理长度 |
| 检测窗口 | 6-10 turn（按 context window 分档） | 1 turn（阈值）+ 3 turn（趋势） |
| 干预类型 | injectedMessage（kick/abort/force-split） | advisory（轻量提醒） |
| 触发时机 | postTurn 后（loop.ts line 1568） | preTurn（下一轮推理前） |
| 维护策略 | 复杂，7 信号 + phase 权重 | 简单，1 主信号 + 趋势 |

两者互补不重叠：convergence-detector 关注"工具调用是不是在兜圈"，reasoning-spiral-hook 关注"思考是不是在自我放大"。

## 测试策略

```
src/agent/hooks/__tests__/reasoning-spiral-hook.test.ts
```

测试用例：

1. 基本触发：lastThinkingLength=3500, lastTurnToolCount=0 → advisory
2. 不触发（短推理）：lastThinkingLength=500, lastTurnToolCount=0 → 无
3. 不触发（有工具调用）：lastThinkingLength=5000, lastTurnToolCount=3 → 无
4. GLM 低阈值：isGlm=true, lastThinkingLength=2000 → advisory
5. 升级检测：连续 3 轮长度递增（2000→3000→4500）→ escalation advisory
6. 趋势重置：长推理后一轮有工具调用 → 趋势清零
7. cooldown：2 轮内不重复
8. 分析豁免：userRequestType='analysis' → 阈值翻倍
9. producingReport 豁免（复用 convergence-detector 的 `reasoningActive`）

## 实施后验证

- [ ] `npx tsc --noEmit` 通过
- [ ] 测试 9 条全绿
- [ ] 在 GLM 会话中观察：推理长度 >1500 且无工具时，preTurn 是否有 advisory 注入
- [ ] 确认 advisory 不出现在 frozenBase / volatile block 中（prefix cache 安全）
- [ ] 确认 `RIVET_REASONING_SPIRAL_GUARD=0` 可关闭

## 设计取舍记录

1. **为什么是 preTurn 而不是 postTurn**：postTurn 注入的 advisory 在 turn 间隙闲置，下一轮开始时的 context injection 可能把它压到很远。preTurn 直接在新一轮推理开始前注入，模型看到的第一条系统消息就是收敛提醒。

2. **为什么是独立 hook 而不是集成到 convergence-detector**：convergence-detector 已经 7 信号 + phase 权重 + 3 级阈值，再加一个维度会增加调试难度。推理长度检测是单信号、轻量、独立可关——更适合 standalone hook。

3. **为什么阈值是 3000 chars 而不是 token 数**：token 数不在 streaming 阶段累积（需要 tokenizer），而 `thinkingAccum.length` 是免费的。chars→tokens 的粗略换算：中文约 1 char ≈ 1.5 token，英文约 4 chars ≈ 1 token。3000 chars 约 750-4500 tokens，覆盖了"异常长推理"的范围。

4. **`lastTurnToolCount` 为什么是 number 而不是 boolean**：future-proofing——后续可以基于工具调用数做更精细的判断（如 "1 个 grep 但推理了 5000 chars" 也可能是螺旋）。

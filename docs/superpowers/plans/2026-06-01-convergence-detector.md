# 收敛检测机制设计

> 基于天璇方法论：跨领域碎片收敛 → 反证探针 → 温跃层梯度。

## 问题

Session 95708c11：模型在 33 turn 内执行 grep/bash/read_file 循环，98K tokens 积累，无编辑产出。现有机制未拦截：

| 现有机制 | 为什么没拦住 |
|----------|------------|
| doom loop (`trace-store.ts`) | 只检测**完全相同**的 fingerprint 重复。不同 args 的 grep/bash/read_file 产生不同 fingerprint |
| dissipative kick | 依赖 sensorium momentum < 0.2 && stability < 0.3，但探索阶段的 sensorium 波动不一定触发 |
| stuck radio | 只发射消息，不干预循环 |
| maxTurns=50 | 太高，33 轮没到上限 |
| token gate (50%) | tokens=98116, window=200000 → 49%，刚好跳过 |

## 跨领域碎片收敛

天璇方法第1-2步：到 3+ 个无关领域寻找碎片，找收敛模式。

| 领域 | 碎片 | 核心模式 |
|------|------|---------|
| **控制论 (PID)** | 积分误差、振荡检测 | 累积偏离目标的程度，随时间递增 |
| **进化算法** | 停滞检测、多样性崩塌 | N 代无改进 → 增加变异率或终止 |
| **TCP 拥塞控制** | AIMD、RTT 测量 | 加性增窗/乘性减窗，延迟作为拥塞信号 |
| **DB 代价优化** | 计划代价估计、渐进优化 | 代价超阈值 → 中止，大计划受更严格审查 |

**收敛模式（4个领域共同指向）：**

1. **滑动窗口测量** — 不依赖单点，看趋势
2. **渐进升级干预** — soft nudge → hard block
3. **相位感知容忍** — 探索期宽容，执行期严格
4. **多正交信号** — 单一信号不可靠
5. **预算感知阈值** — 200K 和 1M 是不同的世界

## 反证探针

天璇方法第3步：杀死最兴奋的假设。

**假设：** "用 tool diversity 熵 + edit 计数检测收敛"

**反证：**
- 初次探索大型代码库时，读 20+ 文件是**正常的**
- edit 计数=0 在探索阶段是**预期的**
- 区分"合法探索"和"无目标游荡"需要**相位感知 + 时间/进展比**

修正：不能只看绝对值，要看**相位内的预期 vs 实际**。

## 温跃层

天璇方法第4步：找硬线之间的梯度。

```
硬线（现有）:
  maxTurns=50 ──────────────────────────── 一刀切
  token gate 50% ───────────────────────── 二元
  doom loop: 完全相同的 fingerprint ────── 太窄

温跃层（梯度，应利用）:
  ┌─ 探索阶段 ──┬─ 规划阶段 ──┬─ 执行阶段 ──┬─ 验证阶段 ──┐
  │ 宽容         │ 中等         │ 严格         │ 最严格       │
  │ 多样性预期高  │ 聚焦预期     │ 编辑预期     │ 测试预期     │
  └─────────────┴─────────────┴─────────────┴─────────────┘
```

---

## 设计：多层收敛检测器

### 架构

```
                 turn boundary
                      │
  ┌───────────────────┼───────────────────┐
  │  Layer 1: Turn     │  Layer 2: Progress│  Layer 3: Phase    │
  │  Budget (hard)     │  Signals (soft)   │  Tolerance (adapt) │
  │                    │                   │                    │
  │  200K: max 30      │  edit_ratio       │  explore: tolerant │
  │  1M:   max 50      │  target_novelty   │  plan:    moderate │
  │                    │  tool_entropy     │  execute: strict   │
  │                    │  error_rate       │  verify:  strict   │
  │                    │  token_efficiency │  deliver: strictest│
  └───────────────────┴───────────────────┴────────────────────┘
                      │
                      ▼
              ConvergenceScore (0-1)
                      │
      ┌───────────────┼───────────────┐
      ▼               ▼               ▼
   Level 0         Level 1         Level 2        Level 3
   正常           建议信号        停滞警告        强制干预
   continue       immune nudge    kick + radio    split/abort
```

### ConvergenceScore 计算

```
ConvergenceScore = Σ(w_i × signal_i)

signals:
  edit_ratio        = turns_with_edits / window_size     (w=0.25)
  target_novelty    = unique_new_targets / total_targets  (w=0.20)
  tool_entropy      = normalized_shannon(tool_dist)       (w=0.20)
  error_penalty     = 1.0 - failure_rate                  (w=0.15)
  token_efficiency  = output_tokens / input_tokens_avg    (w=0.20)
```

所有信号在滑动窗口（默认 8 turns）上计算，归一化到 [0, 1]。

**相位感知权重调制：** 依据当前 phase class 调整权重矩阵。

| Phase Class | edit_ratio | target_novelty | tool_entropy | error_penalty | token_efficiency |
|-------------|-----------|---------------|-------------|--------------|-----------------|
| explore     | 0.05      | 0.35          | 0.30        | 0.15         | 0.15            |
| plan        | 0.10      | 0.25          | 0.20        | 0.20         | 0.25            |
| execute     | 0.40      | 0.15          | 0.15        | 0.20         | 0.10            |
| verify      | 0.30      | 0.10          | 0.10        | 0.35         | 0.15            |
| deliver     | 0.35      | 0.10          | 0.10        | 0.25         | 0.20            |

### 渐进升级阶梯

阈值由窗口大小决定：

| 参数 | 200K 窗口 | 1M 窗口 | 说明 |
|------|----------|--------|------|
| maxTurns (硬上限) | 30 | 50 | 超过即 force split |
| N_low (Level 0→1) | 8 | 12 | 开始注入 immune nudge |
| N_mid (Level 1→2) | 14 | 22 | 发射 kick + radio |
| N_high (Level 2→3) | 20 | 35 | 强制 compaction 或 abort |
| 滑动窗口大小 | 6 | 10 | 信号计算窗口 |

### Level 动作

| Level | 条件 | 动作 |
|-------|------|------|
| 0 | turn < N_low 或 score > 0.6 | 正常继续 |
| 1 | turn ≥ N_low 且 score ≤ 0.6 | 注入 immune signal: `tool_repeat` 或 `trajectory_warning` |
| 2 | turn ≥ N_mid 且 score ≤ 0.4 | 发射 stuck radio + dissipative kick + 建议 session split |
| 3 | turn ≥ N_high 且 score ≤ 0.2 | 强制 trySessionSplit + 若失败则 abort（返回 partial result） |

### 注入点

在 `loop.ts` 的 turn boundary 中，`perceive` 之后、`intent.evaluate` 之前：

```typescript
// 现有: perception → intent → enforce → API call
// 改为: perception → convergence check → intent → enforce → API call

const convergenceResult = this.convergenceDetector.evaluate({
  turn,
  sensorium: currentSensorium,
  phaseClass,
  contextWindow: this.config.contextWindow,
  recentToolHistory: this.recentToolHistory,
  evidenceState: this.evidence.getState(),
})

if (convergenceResult.level >= 2) {
  // inject dissipative kick message
  this.session.addUserMessage(convergenceResult.injectedMessage)
}
if (convergenceResult.level >= 3) {
  // force session split or abort
  if (await this.compaction.trySessionSplit()) {
    continue // reset counters
  }
  if (convergenceResult.shouldAbort) {
    callbacks.onConvergenceAbort?.(convergenceResult)
    return
  }
}
```

## 实现策略

### Phase 1: 收敛分数计算器（纯函数，无副作用）
- `src/agent/convergence-detector.ts`
- 输入：turn, phaseClass, contextWindow, toolHistory, evidenceState
- 输出：ConvergenceScore + level + injectedMessage?

### Phase 2: 集成到 loop.ts
- 在 perceive → intent 之间插入 convergence check
- 实现 Level 1-3 的动作

### Phase 3: 窗口感知阈值
- 从 config 读取 contextWindow，映射到 200K/1M 参数集
- 支持中间窗口大小（线性插值阈值）

### Phase 4: 测试
- 单元测试：各 phase class 的信号计算
- 集成测试：多轮无进度场景触发 level 升级

## 200K vs 1M 的根本差异

不是简单的 "1M 更宽容"。核心差异在于**策略**：

| | 200K | 1M |
|---|------|-----|
| 哲学 | "抓紧时间" | "你有空间，但必须证明你在用" |
| 探索预算 | 8 turns 后开始要求收敛 | 12 turns 后开始要求收敛 |
| 干预风格 | 较早硬干预 | 渐进软干预 → 后期硬干预 |
| 失败模式 | token 耗尽前未完成 | 无限探索不收敛 |
| 关键信号 | token_efficiency 权重更高 | target_novelty 权重更高 |
| split 策略 | 激进 split（清理上下文） | 先尝试 compact，再 split |

**核心洞察：** 200K 的问题是"资源稀缺"，1M 的问题是"缺乏约束"。收敛检测在 200K 下是**预算管理**，在 1M 下是**自律机制**。

## 风险

- **假阳性**：合法的大范围探索被误判为不收敛 → 通过相位感知权重降低
- **假阴性**：模型在 execute 阶段反复 typecheck→edit→typecheck（合法的 TDD 循环）→ 不应触发收敛检测，因为 edit_ratio 高
- **注入消息污染上下文**：Level 2+ 注入的 user message 会留在对话中 → 用完后应标记为 ephemeral 或在下一次 compact 时优先清理

# 收敛检测机制设计

> 基于天璇方法论：跨领域碎片收敛 → 反证探针 → 温跃层梯度。
> 
> **状态：已实现。** `src/agent/convergence-detector.ts` + 集成 `src/agent/loop.ts`。

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

5 个正交信号，加权求和。所有信号归一化到 [0, 1]。

#### 信号定义

| 信号 | 计算 | 含义 |
|------|------|------|
| `editRatio` | successful_edits / window | 编辑产出比例 |
| `targetNovelty` | unique_targets / window | 目标新颖度 |
| `toolEntropy` | normalized_shannon(tool_distribution) | 工具分布熵 |
| `errorPenalty` | 1.0 - failure_rate | 错误惩罚 |
| `tokenEfficiency` | productive_tools / total_tools | 产出效率 |

#### 实际权重矩阵（经过校准优化）

| Phase Class | edit_ratio | target_novelty | tool_entropy | error_penalty | token_efficiency |
|-------------|-----------|---------------|-------------|--------------|-----------------|
| explore     | 0.05      | 0.35          | 0.30        | 0.15         | 0.15            |
| plan        | 0.10      | 0.25          | 0.20        | 0.20         | 0.25            |
| execute     | **0.50**  | 0.10          | 0.10        | 0.20         | 0.10            |
| verify      | 0.30      | 0.10          | 0.10        | 0.35         | 0.15            |
| deliver     | **0.45**  | 0.10          | 0.10        | 0.25         | **0.10**        |

> **优化点：** execute 的 editRatio 权重从设计的 0.40 上调到 0.50，deliver 从 0.35 上调到 0.45。原因：在这些阶段没有编辑是根本性的方向错误，其他信号即使正常也不应掩盖。deliver 的 tokenEfficiency 从 0.20 下调到 0.10——交付阶段不应再有大量读取。

#### 相位期望惩罚（实现中新增）

针对 execute、verify、deliver 三个**编辑预期阶段**，当 `editRatio < 0.1` 时，整体得分乘以 0.5：

```
if (editExpectedPhases.includes(phaseClass) && signals.editRatio < 0.1)
  penalty = 0.5
```

这是反证探针的结果：在编辑预期阶段零编辑产出的情况下，不能因为工具多样性高就给高分。

### 渐进升级阶梯

阈值由窗口大小决定：

| 参数 | 200K 窗口 | 1M 窗口 | 说明 |
|------|----------|--------|------|
| maxTurns (硬上限) | 30 | 50 | 超过即 force split |
| N_low (Level 0→1) | 8 | 12 | 开始注入 immune nudge |
| N_mid (Level 1→2) | 14 | 22 | 发射 kick + 注入引导消息 |
| N_high (Level 2→3) | 20 | 35 | 强制 session split 或 abort |
| 滑动窗口大小 | 6 | 10 | 信号计算窗口 |

中间窗口大小（如 500K）通过线性插值计算阈值。

### Level 动作

| Level | 条件 | 动作 |
|-------|------|------|
| 0 | turn < N_low 或 score > 0.6 | 正常继续 |
| 1 | turn ≥ N_low 且 score ≤ 0.6 | 日志记录，不干预（预留给 immune hook） |
| 2 | turn ≥ N_mid 且 score ≤ 0.4 | 注入 user message 引导 + 发射 convergence-warning phase change |
| 3 | turn ≥ N_high 且 score ≤ 0.2 | 强制 trySessionSplit；若 score < 0.1 则 abort |

### 注入点

在 `loop.ts` 的 turn boundary 中，`perceive` 之后、`intent.evaluate` 之前：

```typescript
// perception → convergence check → intent → enforce → API call

const convergenceCheck = evaluateConvergence({
  turn,
  phaseClass: phaseClass as PhaseClass,
  contextWindow: this.config.contextWindow,
  recentToolHistory: this.recentToolHistory,
  evidenceState: this.evidence.getState(),
})

if (convergenceCheck.shouldKick && convergenceCheck.injectedMessage) {
  callbacks.onPhaseChange?.('convergence-warning', { ... })
  this.session.addUserMessage(convergenceCheck.injectedMessage)
}
if (convergenceCheck.shouldForceSplit) {
  await this.compaction.trySessionSplit()
}
if (convergenceCheck.shouldAbort) {
  callbacks.onAbort()
  return
}
```

### 注入消息格式

Level 2 示例：
```
**系统感知：当前任务可能进入低效循环。**
- 执行阶段进行了 0% 轮次有编辑产出的操作 — 远低于预期 (≥30%)
- 纯读取无产出，建议立即采取编辑或测试行动验证当前假设

请选择以下行动之一：
- 对当前最可能的方案进行编辑或测试
- 重新阅读用户原始请求，确认方向
- 缩小范围：只解决一个子问题
```

Level 3 示例（追加）：
```
**建议：** 提交已完成部分，重新描述需求并开始新一轮对话。
- 上下文窗口: 200K，当前已使用较多轮次
```

---

## 实现过程中的优化与修复

### Bug Fix 1: Shannon 熵单工具情况

`normalizedShannonEntropy` 在 `distribution.size <= 1` 时本应返回 0.0（重复使用同一工具 = 零多样性），但早期 return 错误地返回了 1.0。修复后正确返回 0.0。

### Bug Fix 2: 移除死代码引入的 undefined 变量

删除重复的 `if (n <= 1) return 0.0` 死代码时，误删了 `const n = distribution.size` 定义，导致 `Math.log(n)` 中 n 为 undefined。修复：保留变量声明。

### 优化 3: tokenEfficiency 纯读取返回值

纯读取（productive=0）从返回 0.1 改为 0.0，更准确地反映"零产出"。

### 优化 4: execute/deliver 权重上调

见上表。execute: editRatio 0.40→0.50, deliver: editRatio 0.35→0.45, tokenEfficiency 0.20→0.10。

### 优化 5: 相位期望惩罚

新增编辑预期阶段的 0.5x 惩罚乘数，解决"工具多样但无编辑产出"挂高分的假阴性。

---

## 测试

16 个单元测试 (`src/agent/__tests__/convergence-detector.test.ts`)，覆盖：

- Level 0-3 各级触发条件
- 所有 5 个 phase class 的行为差异
- 200K vs 1M 阈值差异
- 中间窗口大小的插值
- 空历史、高错误率等边界情况
- 信号值范围验证

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

## 与现有机制的互补

| 机制 | 覆盖 | 不覆盖 |
|------|------|--------|
| doom loop | 相同 fingerprint 重复 | 不同 args 的同工具循环 |
| dissipative kick | 低 momentum + 低 stability | 正常 sensorium 但无进展 |
| **convergence detector** | **多信号滑动窗口 + 相位感知 + 渐进升级** | 单轮内的瞬时异常 |
| stuck radio | 同 phase 8+ turn | 跨 phase 的无进展游荡 |

## 风险

- **假阳性**：合法的大范围探索被误判为不收敛 → 通过相位感知权重 + explore phase 高容忍缓解
- **假阴性**：模型在 execute 阶段反复 typecheck→edit→typecheck（合法的 TDD 循环）→ editRatio 高，不应触发
- **注入消息污染上下文**：Level 2+ 注入的 user message 会留在对话中 → 在下一次 compact 时被优先清理
- **Phase class 抖动**：天枢/天璇/天机/天权之间频繁切换可能导致相位感知权重不稳定 → 信号使用滑动窗口，天然平滑

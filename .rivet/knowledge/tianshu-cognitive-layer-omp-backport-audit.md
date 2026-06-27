# 天枢认知控制层优化建议（源自 omp 反向融合实践）

> 2026-06-27。视角：天枢（opencode-tui）是认知控制层的**源头**，omp（oh-my-pi）是把天枢的设计**简化移植**后的产物。本档案反向利用 omp 的移植实践——ompp 在移植过程中**识别并修正了天枢源码的若干设计缺陷**。这些修正说明天枢原版存在可优化点，本文逐条核实并给出回填建议。
>
> 证据基线：omp 交付基线文档 `/Users/banxia/app/oh-my-pi-doc/glm-5.2-delivery-capability-baseline.md` 记录了 4 处"修正源设计缺陷"。本文对每一条都用工具核对了天枢当前源码 + omp 修正版，确认缺陷真实存在。

---

## 核实结论速览

| # | 缺陷 | 天枢现状 | omp 修正 | 优先级 | 修正彻底性 |
|---|---|---|---|---|---|
| 1 | targetNovelty 公式：全相同给非零 | **存在**（1/N）| `(unique-1)/(total-1)` | 高 | omp 彻底 |
| 2 | editRatio 独立计分，原地打转得高分 | **存在**（execute 权重 0.40）| `editRatio × max(novelty,0.1)` | 高 | omp 彻底 |
| 3 | commitThreshold 二值跳变 | **存在**（`>0.7?0.9:0.6`）| 压力分支线性化 | 中 | **omp 不彻底**（动量分支仍二值）|
| 4 | 无数据信号默认 1.0 抬分 | **存在且更广** | textRep 权重重分配 | 中 | **omp 不彻底**（仅 textRep，未含 oscillation/error）|
| 5 | explorationBreadth 固定值 | **存在**（`<0.3?0.9:0.3`）| stability 分支连续化 | 中 | **omp 不彻底**（complexity>0.5 仍 plateau）|

**关键判断**：omp 的修正方向都对，但有 3 处（#3/#4/#5）omp 自己也没做到位。天枢回填时应**比 omp 更彻底**——把 omp 没处理干净的边界一起补上，而不是照搬它的半成品。

---

## 缺陷 1：targetNovelty 公式有数学缺陷（高优先级）

### 天枢现状（`src/agent/convergence-detector.ts:188-205`）

```typescript
function computeTargetNovelty(windowSize, history): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 1.0
  const seen = new Set<string>()
  let novelCount = 0
  for (const entry of window) {
    if (!seen.has(entry.target)) { novelCount++; seen.add(entry.target) }
  }
  return novelCount / window.length   // ← novelCount = 唯一目标数
}
```

**缺陷**：`novelCount`（首次出现计数 = 唯一目标数）除以总数。N 次全同一目标 → `novelCount=1` → novelty = **1/N**。
- 5 次全同一目标 → 0.20
- 6 次全同一目标 → 0.17（天枢自己的测试 `convergence-detector.test.ts:98,145` 就记录了这个值）

**为什么是 bug**："全部相同"语义上 = 零新颖度，但公式给非零。这会拉高 convergence score，让"反复操作同一目标"被误判为有进展。

### omp 修正（`convergence-detector.ts:173-179`）

```typescript
const hashes = new Set(executed.map(f => f.argsHash))
return (hashes.size - 1) / (executed.length - 1)
```

N 次全同一目标 → `(1-1)/(N-1) = 0` ✅。N 次全不同 → `(N-1)/(N-1) = 1` ✅。数学正确。

### 回填建议

直接采纳 omp 公式。注意 omp 的边界处理：`executed.length===1` 返回 **1**（单次操作视为完全新颖），空返回 0。天枢的 `window.length===0` 返回 1.0（空窗口视为新颖）——这个语义保留即可，但全相同分支必须修。

**影响面**：修这个会**降低**反复操作同一文件场景的 convergence score，与缺陷 2 的修复协同（缺陷 2 也会降低这类场景的分数）。两个一起修更合理。

---

## 缺陷 2：editRatio 独立计分，原地打转得高分（高优先级）

### 天枢现状（`src/agent/convergence-detector.ts:378, 170-182`）

```typescript
// 计分（line 377-384）：editRatio 是独立加项
const raw =
  weights.editRatio * signals.editRatio +        // ← 独立，不与 novelty 交互
  weights.targetNovelty * signals.targetNovelty +
  ...

// editRatio 定义（line 170-182）：成功编辑次数 / 总操作数
const successfulEdits = window.filter(h => editTools.has(h.tool) && h.status === 'success').length
return successfulEdits / window.length
```

**缺陷**：editRatio 只看"有没有编辑"，不看"编辑的是不是新东西"。phase 权重里 `execute: editRatio=0.40`、`deliver: 0.36` 是最高权重。

**具体后果**：连续 10 次成功编辑**同一文件** → editRatio=1.0 → 贡献 `0.40 × 1.0 = 0.40` 给 execute 分数。同时 targetNovelty 因缺陷 1 还有 0.1 残值。结果是：**原地打转被评成强进展**。天枢的 `penalty` 乘法器（line 390-456）只按 phase / `editRatio<0.1` / productive-ratio 触发，**从不管编辑是否新颖**——所以这个误判无法被现有惩罚机制纠正。

### omp 修正（`convergence-detector.ts:271-274, 297`）

```typescript
function weightedScore(signals, weights): number {
  // editRatio 被 targetNovelty 门控：反复编辑同一文件（novelty=0）不算进展
  const effectiveEditRatio = signals.editRatio * Math.max(signals.targetNovelty, 0.1);
  const raw = effectiveEditRatio * w.editRatio + signals.targetNovelty * w.targetNovelty + ...
}
```

`Math.max(novelty, 0.1)` 的 floor 防止信号完全归零（保留少量基线，避免误杀"合理地反复编辑同一文件"的场景，如逐步构建一个大文件）。

### 回填建议

直接采纳。这是与缺陷 1 强耦合的修复——**两个一起做**才有意义：缺陷 1 把 novelty 修对（同目标→0），缺陷 2 让 editRatio 受 novelty 门控，联合效果是"原地打转"在分数上被正确压低。

---

## 缺陷 3：commitThreshold 二值跳变（中优先级）

### 天枢现状（`src/agent/sensorium.ts:350`）

```typescript
commitThreshold: s.pressure > 0.7 ? 0.9 : 0.6,   // ← 0.69→0.6, 0.70→0.9，跳变 0.30
```

**缺陷**：压力边界 0.70 处有不连续的 0.30 跳变。agent 的提交意愿在边界附近抖动——pressure 0.69 和 0.70 行为差异巨大，但语义上几乎相同。

### omp 修正（`sensorium.ts:213-221`）—— 注意不彻底

```typescript
function resolveCommitThreshold(vec): number {
  if (vec.pressure > 0.7) { return clamp01(0.7 + (vec.pressure - 0.7) * 0.5) }  // 压力分支：线性 0.7→0.85
  if (vec.momentum < 0.3) return 0.75   // ← 动量分支仍是二值
  return 0.5                            // ← 默认仍是二值
}
```

omp 只把**压力分支**线性化了（0.7→0.85 连续），**动量分支和默认值仍是离散 0.75/0.5**。所以 omp 自己也没完全消除跳变——压力边界 0.7 处仍有 0.7→0.75 的不连续。

### 回填建议（比 omp 更彻底）

天枢回填时把三个分支都连续化：

```typescript
function resolveCommitThreshold(s): number {
  // 压力主导区：连续插值（采纳 omp）
  if (s.pressure > 0.7) return clamp01(0.7 + (s.pressure - 0.7) * 0.5)
  // 动量不足区：连续插值（omp 没做，天枢补上）
  if (s.momentum < 0.3) return clamp01(0.5 + (0.3 - s.momentum) * (0.25 / 0.3))  // 0.3→0.5, 0.0→0.75
  return 0.5
}
```

这样压力 0.7 和动量 0.3 两个边界都平滑。注意 vigor.ts 会在 base 上叠加 `+0.15/-0.1`（`vigor.ts:186,196`），那是独立的后处理，不受影响。

---

## 缺陷 4：无数据信号默认 1.0 抬分（中优先级）—— 天枢比 omp 更严重

### 天枢现状

天枢**多个**信号在无数据时返回 1.0，且权重不重分配：

| 信号 | 无数据条件 | 返回值 | 权重(execute) |
|---|---|---|---|
| `textRepetitionPenalty` (line 327,336,357,363) | `window<3` / `wordSets<3` / `totalPairs=0` | **1.0** | 0.12 |
| `oscillationPenalty` (line 299,303) | `window<6` / `unique.size≠2` | **1.0** | 0.06 |
| `errorPenalty` (line 233) | `window.length===0` | **1.0** | 0.18 |
| `confidence` (sensorium:142) | `filesModified<=0` | **1.0** | — |
| `stability.verificationCoverage` (sensorium:219) | 无修改文件 | **1.0** | — |

**缺陷**：1.0 = "无惩罚"，但这个 1.0 带着完整权重进入加权和，**把分数往上拉**。"没有文本数据"让 agent 看起来比实际更健康。execute phase 里仅 textRep+oscillation+errorPenalty 三个无数据信号就能贡献 `0.12+0.06+0.18 = 0.36` 的虚高。

### omp 修正（`convergence-detector.ts:278-294`）—— 注意只修了一个

```typescript
const w = { ...weights }
if (signals.textRepetitionPenalty >= 1) {           // ← 仅 textRepetitionPenalty
  const excess = w.textRepetitionPenalty
  w.textRepetitionPenalty = 0
  const others = ['editRatio','targetNovelty','toolEntropy','errorPenalty','tokenEfficiency','oscillationPenalty']
  const perSignal = excess / others.length
  for (const key of others) w[key] += perSignal
}
```

omp **只对 textRepetitionPenalty 做了权重重分配**，oscillationPenalty / errorPenalty 的无数据 1.0 仍原样保留。omp 自己也不一致。

### 回填建议（比 omp 更彻底）

天枢应该对所有"无数据→1.0"的惩罚信号统一处理。设计一个 `normalizeWeightsForMissingData(signals, weights)` 工具：遍历所有信号，凡是被标记为"无数据"（return 1.0 的 sentinel）的，把其权重均摊给有数据的信号。

实现要点：需要信号函数能区分"真 1.0（确实无重复）"和"无数据 1.0"。最干净的方式是让 compute 函数返回 `{ value, hasData }` 而非裸 number。这是较大的重构，但收益是彻底消除虚高。

**降级方案**（改动小）：只对 textRepetitionPenalty + oscillationPenalty 两个"确实常有数据"的信号做重分配（它们无数据是常态窗口期，不是真没数据）；errorPenalty 的空窗口=0 错误，返回 1.0 在语义上**是对的**（没错误=满分），保留。

---

## 缺陷 5：explorationBreadth 固定值（中优先级）

### 天枢现状（`src/agent/sensorium.ts:349`）

```typescript
explorationBreadth: s.stability < 0.3 ? 0.9 : 0.3,   // ← 0.29→0.9, 0.30→0.3，跳变 0.60
```

**缺陷**：stability 0.30 边界处 0.60 跳变。agent 的探索广度在边界抖动。

### omp 修正（`sensorium.ts:204-211`）—— 注意不彻底

```typescript
function resolveExplorationBreadth(vec): number {
  if (vec.stability < 0.3) return clamp01(0.7 + (0.3 - vec.stability) * 0.5)  // stability 分支：0.7→0.85 连续
  if (vec.complexity > 0.5) return 0.5                                          // ← complexity 分支仍 plateau
  return clamp01(0.3 + vec.complexity * 0.3)                                    // 默认：0.3→0.45 连续
}
```

omp 把 stability 低分支和默认分支连续化了，但 `complexity>0.5` 分支返回固定 0.5，**complexity=0.5 处仍有跳变**（默认分支在 complexity=0.5 时是 0.45，跳到 0.5）。

### 回填建议（比 omp 更彻底）

```typescript
function resolveExplorationBreadth(s): number {
  if (s.stability < 0.3) return clamp01(0.7 + (0.3 - s.stability) * 0.5)   // 采纳 omp
  // omp 的 complexity>0.5 plateau 改为连续：高复杂度时广度随 complexity 继续升
  return clamp01(0.3 + s.complexity * 0.4)   // 0→0.3, 0.5→0.5, 1.0→0.7，全程连续
}
```

消除 complexity=0.5 处的跳变，且高复杂度时给更高广度（符合"复杂任务需要更宽搜索"的直觉）。

---

## 回填实施建议

### 优先级与依赖

```
缺陷1 (targetNovelty) ─┐
                       ├─ 协同修复（同一次提交，共享测试场景"反复编辑同一文件"）
缺陷2 (editRatio门控) ─┘

缺陷3 (commitThreshold) ── 独立
缺陷4 (无数据抬分)     ── 独立（建议先做降级方案）
缺陷5 (explorationBreadth) ── 独立
```

**建议顺序**：先做 1+2（耦合，影响最大，execute/deliver 占总分权重最高），再做 4（降级版）、3、5。

### 验证要求

每处修复都要：
1. 改 `convergence-detector.test.ts` / `sensorium.test.ts` 里锁定旧行为的断言（缺陷 1/3/5 的测试目前**断言了缺陷行为**，如 `convergence-detector.test.ts:98,145` 写死 targetNovelty≈0.17；`sensorium.test.ts:315-326` 写死二值——这些是回归保护，改实现必须同步改断言到正确值）。
2. 新增"反复编辑同一文件"场景测试，断言修复后分数显著低于修复前。
3. 跑 cognitive-season.ts / loop.ts 集成测试，确认 convergence 分数变化没有破坏干预触发逻辑。

### 风险

- **分数整体下移**：缺陷 1/2/4 的修复都会**降低** convergence score（修掉了虚高）。如果天枢有依赖"convergence 高=健康"的下游逻辑（如自动提交、减少干预），修复后可能触发更多干预/更少自动提交。需要检查 `cognitive-controller.ts` / `commit-nudge.ts` 的阈值是否需要同步下调。
- **这是行为改变**，不是纯重构。建议分原子提交，每个缺陷一个 commit + 独立测试，便于回滚。

---

## 反思：为什么天枢原版有这些缺陷

omp 的移植实践揭示了一个有用的元模式：**简化移植反而暴露了源设计的隐含假设**。天枢原版：
- targetNovelty 用 `1/N` 可能是早期实现的简化，测试把 0.17 当"正确值"锁定了，再没人质疑。
- editRatio 独立计分假设了"编辑=进展"，但在 doom-loop 场景下这个假设失效（doom-loop 恰是反复编辑同一处）。
- 二值跳变（缺陷 3/5）是"够用就行"的快速实现，没有考虑边界平滑。

omp 之所以能发现这些，是因为移植时被迫重新理解每个信号的语义——"这个 1.0 是什么意思""为什么是 0.9 不是 0.85"。**这个"重新审视"的契机是天枢自身迭代时缺乏的**。

启示：天枢可以建立一个惯例——周期性用 omp 的移植视角反向审计自己的核心算法（convergence/sensorium/doom-loop），把它们当成"要移植到新基座"来重新质问每个常数和公式。

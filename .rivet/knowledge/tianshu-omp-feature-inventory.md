# 天枢 ← omp 可补强特性清单

> 2026-06-27。对 oh-my-pi（omp）v16 源码的对比审查。omp 是天枢认知控制层设计的简化移植方，但在独立演进中引入了数项天枢没有的改进。本文记录值得回填的特性，以及不建议拿的项及其理由。

## 项目关系

omp 是 [Pi](https://github.com/badlogic/pi-mono) 的 fork，Bun + Rust 混合架构，~55K 行 Rust 核心。天枢的 convergence-detector、sensorium、compaction 等模块被 omp 简化移植为同名文件（`packages/agent/src/` 下），随后 omp 在独立迭代中做了优化。

审查方法论：并行对比同名模块源码 + 差异矩阵分析 + 逐条称量取舍。

---

## 第一部分：convergence-detector 精度提升（3 项，高价值低风险）

### 1.1 targetNovelty 改用 argsHash

| 维度 | 天枢当前 | omp |
|------|----------|-----|
| 判重依据 | `entry.target`（文件路径字符串）| `argsHash`（工具参数哈希）|
| 文件 | `convergence-detector.ts:196-205` | `packages/agent/src/convergence-detector.ts` |
| 差异场景 | `edit_file(a.ts, "x", "y")` 和 `edit_file(a.ts, "y", "z")` → 同一目标 | → 不同目标 |

天枢的路径匹配把"对同一文件做不同编辑"误判为重复。omp 的 argsHash 区分了"同一文件的同一操作"和"同一文件的不同迭代"。这个改动让 novelty 信号精确区分原地打转和迭代推进。

**改动范围**：`computeTargetNovelty` 内部。需要在 `ToolHistoryEntry` 上增加 `argsHash` 字段，或将 hash 逻辑收敛到 `evaluateConvergence` 调用方传入。

### 1.2 tokenEfficiency 改用真实 LLM output token

| 维度 | 天枢当前 | omp |
|------|----------|-----|
| 计算方式 | read/write/test 工具比例 + balanceBonus | `exp(-outputTokens/toolCount / 500)` |
| 文件 | `convergence-detector.ts:241-280` | `packages/agent/src/convergence-detector.ts` |

天枢的启发式有三个问题：(1) bash 被归为"test 类 productive"，但 bash 常见于探索性命令；(2) 读工具间的比例差异被忽略；(3) balanceBonus 的阈值（0.5-2.0）是经验常数。omp 直接用模型 output token 计数做指数衰减——token 越多、效率越低。这个信号来源更直接。

**改动范围**：`ConvergenceInput` 新增 `outputTokens?: number`，从 `loop.ts` 的 usage 快照传入（已有 `totalUsage` 字段）。`computeTokenEfficiency` 内部重构。

**注意**：`outputTokens` 在 `onStopReason` 回调中可用，但 convergence check 发生在此之前。需要从上一轮的 usage 中取——即"上轮产出效率"。这与 omp 的语义一致。

### 1.3 oscillationPenalty 从严格二值改为位置反转计数

| 维度 | 天枢当前 | omp |
|------|----------|-----|
| 触发条件 | 最后 8 个 fingerprint 恰好 2 个唯一值 | 全量 fingerprint 做 A-B-A 位置反转计数 |
| 漏报场景 | A→B→A→C→A→B （中途插入新目标 → 唯一值=3 → 返回 1.0）| 可检测渐进式震荡 |
| 文件 | `convergence-detector.ts:288-315` | `packages/agent/src/convergence-detector.ts` |

天枢的 `new Set(window).size !== 2` 是硬门槛——只要指纹超过 2 种就完全退出检测。omp 的算法遍历全量指纹，计数 `hash[i] === hash[i-2] && hash[i] !== hash[i-1]`（A-B-A 位置模式），可以在多目标场景下也检测出震荡。

**改动范围**：`computeOscillationPenalty` 内部，100% 向后兼容。omp 的公式：
```
reversals = count of hash[i]==hash[i-2] && hash[i]!=hash[i-1] for i >= 2
ratio = reversals / (len - 2)
penalty = ratio > 0.4 ? 0.0 : ratio > 0.2 ? 0.3 : 1.0
```
需要同步更新 `oscillationHasData` 函数（当前用 `size===2` 判有数据，新算法不需要这个条件）。

---

## 第二部分：sensorium 精度提升（1 项，中价值）

### 2.1 complexity 改用 Shannon 熵

| 维度 | 天枢当前 | omp |
|------|----------|-----|
| 计算方式 | `unique/total`（窗口 5）| `-Σ p_i·ln(p_i) / ln(n)` 归一化 Shannon 熵 |
| 文件 | `sensorium.ts:253-256` | `packages/agent/src/sensorium.ts` |

`{A×4, B×1}` 和 `{A×3, B×2}` 在天枢都返回 0.4，但前者更不均匀（更接近循环）。熵能区分这个偏斜。代价是窗口需扩到全量 toolCallHistory（熵对小样本不稳定），但 sensorium.ts 的 `toolCallHistory` 参数当前限制最大 5——需要放宽。

**注意**：`computeComplexity` 的返回值被 `computeStrategy` 的 `s.complexity > 0.7` 用于推理强度判断。用熵替代后，需要重新标定阈值（熵的值域与 simple ratio 不同，同一下限 0 但典型值偏低）。建议保持 `unique/total` ratio 作为快速信号，新增 `complexityEntropy` 作为补充维度，而非替换。

---

## 第三部分：compaction 能力（3 项，中高价值、中风险）

### 3.1 LLM 驱动的对话摘要压缩

omp 在 compaction 时调用模型对旧对话历史做结构化摘要，生成压缩后的 system message 插入。天枢当前是纯规则驱动压缩（prune → stale-round → context-collapse → micro-compact），零 LLM 成本但压缩质量有上限。

omp 的实现要点：
- `generateSummary()` → 调用模型生成摘要文本
- `generateHandoff()` → 跨 session/model 的交接文档
- `generateTurnPrefixSummary()` → mid-turn 截断时的前半轮摘要

**设计建议**：作为天枢 compaction 的第 5 层（LLM summary），仅在 `nHigh` 阈值触发。不替代现有规则压缩，而是叠加。需要消耗额外 token（约 200-500 output + 摘要内容的 input），设计为 opt-in 或仅在 >25 turns 时自动触发。

### 3.2 跨 compaction 边界的文件操作追踪

omp 在 compaction 时提取 `readFiles` / `modifiedFiles` 集合并持久化到 `CompactionEntry.details`，后续轮次可引用"上次压缩前我们打开了哪些文件"。天枢的 compaction 不追踪跨边界的文件操作。

**改动范围**：`src/compact/` 的 entry 结构需要扩展。收益是让模型在压缩后仍知道"我们在哪些文件上工作过"。

### 3.3 stored-conversation token floor

omp 在 compaction 时用本地估计 (`storedConversationEstimate`) 做 provider 报告 token 的下限保护。天枢的 `adaptiveCompactPolicyRatios` 没有这个 floor——如果 provider 低报 token 数，compaction 会延迟触发，导致上下文压力超标。

**改动范围**：`src/compact/constants.ts` 的阈值计算。

---

## 第四部分：工具层（2 项，高差异化价值、高移植成本）

### 4.1 tree-sitter AST 编辑/搜索（ast-edit, ast-grep）

omp 有基于 tree-sitter 的语义级代码编辑和搜索工具。天枢只有文本级 edit_file / grep。ast-edit 能做"给所有 export 函数加 JSDoc"类的结构化修改。

**障碍**：需要 Rust native binding（`@oh-my-pi/pi-natives`），移植成本高。短期可考虑用 Node.js tree-sitter binding（`tree-sitter` + `tree-sitter-typescript`）做轻量版。

### 4.2 多语言代码沙箱（eval）

omp 有 Python/JS/Ruby/Julia 持久化 kernel 的代码执行工具。天枢目前靠 bash 间接执行代码。

---

## 不建议拿的项

| omp 特性 | 理由 |
|----------|------|
| XHigh reasoning effort | 天枢的 `thetaCycleInterval` 在复杂度 >0.5 时 3 轮一次 theta 反思，是不同方向的解决方案。叠加 XHigh 会过度消耗 token |
| fingerprint-based momentum | 与天枢的预测准确率 momentum **互补**，但替换会丢失预测信号。建议融合而非替换 |
| LLM compaction 替代零成本压缩 | 天枢的五层规则压缩（semantic prune、staleness、AgentDiet、code-fold、per-tool budget）是差异化优势，omp 没有这个深度 |
| 浏览器自动化（11+ 文件）| omp 特定生态，天枢不需要 |
| TTS / SSH / IRC | omp 特定生态 |
| checkpoint/rewind | 天枢的 session resume 已有类似语义 |
| 单维压力 | omp 只有 `promptTokens/contextWindow`，天枢的多维压力（verification debt + CVM + growth）更丰富——不值得降级 |
| 离散策略跃变 | omp 仍在用 `>0.6 ? High : ...` 的二值跳变，天枢已连续化——不值得倒退 |

---

## 天枢在 omp 之上的差异化优势（保留清单）

审查中发现天枢有数个 omp 完全缺失的能力，这些是竞争优势，不应在移植中弱化：

1. **信息素系统**（PheromoneRef + gitChangeRate + fsEventRate 三源 freshness）
2. **多维压力感知**（verification debt + CVM overhead + growth penalty）
3. **注意力质量评分**（AttentionQuality — toolDensity/diversity/size/userRatio/storm 五维融合）
4. **连续化策略函数**（commitThreshold、explorationBreadth 全程平滑）
5. **thetaCycleInterval**（复杂度自适应反思节奏）
6. **AgentDiet 五层规则压缩**（semantic prune → staleness → code-fold → context-collapse → micro）
7. **per-tool-type 预算**（grep/read_file/bash/run_tests/delegate_task 分别管控）

---

## 回填优先级与依赖

```
优先级 1（本迭代可做）：
  ├─ 1.1 targetNovelty → argsHash          ← convergence-detector.ts 小幅改动
  ├─ 1.3 oscillationPenalty → 位置反转      ← 函数内部重构，100% 向后兼容
  └─ 3.3 stored-conversation token floor    ← constants.ts 一行

优先级 2（需要上游改动）：
  └─ 1.2 tokenEfficiency → 真实 token       ← 需要 loop.ts 传入 outputTokens

优先级 3（需要加深设计）：
  ├─ 2.1 complexity → Shannon 熵           ← 需要重新标定阈值
  ├─ 3.1 LLM compaction 摘要               ← 需要设计触发条件和 prompt
  └─ 3.2 跨边界文件追踪                     ← 需要扩展 CompactionEntry

优先级 4（大工程）：
  ├─ 4.1 AST 编辑/搜索
  └─ 4.2 代码沙箱
```

---

## 自检清单

- [x] 每项声称都有 omp 文件定位和天枢文件定位
- [x] "不建议拿"的每项都有具体理由
- [x] 天枢差异化优势清单防止移植中弱化
- [ ] 1.1 argsHash 需要验证 ToolHistoryEntry 是否已含 argsHash 字段
- [ ] 1.2 outputTokens 需要验证 loop.ts 中 usage 快照的可用时机
- [ ] 2.1 Shannon 熵需要在实际窗口下做分布模拟确定典型值区间

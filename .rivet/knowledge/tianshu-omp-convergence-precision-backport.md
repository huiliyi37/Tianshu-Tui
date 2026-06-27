# 天枢收敛检测精度提升 —— omp 反向移植实施文档

> 2026-06-27。从天枢←omp 特性清单（`tianshu-omp-feature-inventory.md`）中提取的前三项——收敛检测器（`convergence-detector.ts`）的精度提升。

三项改动共享同一文件 `src/agent/convergence-detector.ts`，改动半径小、测试覆盖好，建议在一次提交中完成。

## 概览

| # | 改动 | 天枢当前 | omp 做法 | 收益 |
|---|---|---|---|---|
| 1 | targetNovelty 维度升级 | 文件路径字符串判重 | `argsHash`（工具名+参数哈希）判重 | 区分"同一文件迭代推进" vs "同一文件同一操作重复" |
| 2 | tokenEfficiency 信号源 | 工具分类启发式（read/write 比例） | 真实 LLM output token 数 `exp(-tokensPerCall/500)` | 直接测量，不用间接代理 |
| 3 | oscillationPenalty 检测算法 | 严格要求窗口内恰好 2 个唯一值 | 位置反转计数 `hash[i]===hash[i-2] && !== hash[i-1]` | 捕获渐进式震荡（A→B→A→C→A→B），不漏报 |

---

## 改动 1：targetNovelty 改用 argsHash

### 现状（天枢）

`convergence-detector.ts` 的 `computeTargetNovelty`（当前行约 197-206）：

```typescript
function computeTargetNovelty(windowSize, history): number {
  const window = history.slice(-windowSize)
  // ...
  for (const entry of window) {
    if (!seen.has(entry.target)) { novelCount++; seen.add(entry.target) }
  }
  // ...
}
```

判重依据：`entry.target` —— 文件路径字符串。`ConvergenceInput.recentToolHistory` 的类型是 `Pick<ToolHistoryEntry, 'tool' | 'status' | 'target'>`。

**问题**：`edit_file(a.ts, old="x", new="y")` 和 `edit_file(a.ts, old="y", new="z")` 被判为同一目标，尽管它们做的是不同的操作。相反，`read_file(a.ts)` 和 `read_file(b.ts)` 被判为不同目标——它们确实是不同的文件访问，但都是读取行为。仅凭文件路径无法区分"合理的迭代编辑"和"反复修改同一文件同一内容"的 doom loop。

### omp 做法

`oh-my-pi/packages/agent/src/convergence-detector.ts:175-182`：

```typescript
function computeTargetNovelty(fingerprints: Fingerprint[]): number {
  const executed = fingerprints.filter(/* kind === "executed" */);
  if (executed.length === 0) return 0;
  if (executed.length === 1) return 1;
  const hashes = new Set(executed.map(f => f.argsHash));
  return (hashes.size - 1) / (executed.length - 1);
}
```

`argsHash` = 工具名 + 参数组合的哈希。`edit_file(path, old, new)` 和 `edit_file(path, old2, new2)` 如果参数不同则 argsHash 不同。

### 实施步骤

**A. 扩展 `ToolHistoryEntry` 类型**

`src/prompt/volatile.ts:113-117`，在 `ToolHistoryEntry` 中新增 `argsHash?: string` 字段：

```typescript
export interface ToolHistoryEntry {
  tool: string
  target: string
  status: 'success' | 'failed' | 'running'
  argsHash?: string  // ← 新增：工具名 + 序列化参数组合的哈希
  error?: string
}
```

**B. 写入 argsHash**

在 `src/agent/loop.ts` 中，工具调用记录写入 `recentToolHistory` 的位置，计算 `argsHash`。计算方式：`tool + ':' + JSON.stringify(sortedArgs)` 的简单哈希。

使用 `node:crypto` 的 `createHash('sha256').update(str).digest('hex').slice(0, 8)`，或者更轻量的字符串拼接做 Set key（omp 用的是后者）。推荐**先做字符串拼接**——性能足够，且 Set 判重不需要密码学哈希，只需确定性。

```typescript
// 在写入 recentToolHistory 处
const argsHash = `${toolName}:${JSON.stringify(args, Object.keys(args).sort())}`
```

**C. 扩展 `ConvergenceInput.recentToolHistory`**

当前类型为 `Pick<ToolHistoryEntry, 'tool' | 'status' | 'target'>`，改为包含 `argsHash`：

```typescript
recentToolHistory: ReadonlyArray<Pick<ToolHistoryEntry, 'tool' | 'status' | 'target' | 'argsHash'>>
```

**D. 修改 `computeTargetNovelty`**

用 `argsHash ?? entry.target` 作为判重键（fallback 到 target 保证向后兼容——旧 session 可能没有 argsHash）：

```typescript
function computeTargetNovelty(windowSize, history): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 1.0
  const seen = new Set<string>()
  for (const entry of window) {
    seen.add(entry.argsHash ?? entry.target)
  }
  if (seen.size === 1) return window.length === 1 ? 1.0 : 0.0
  return (seen.size - 1) / (window.length - 1)
}
```

注意：保留了刚修的 `(size-1)/(length-1)` 公式（commit `7f1bd173`），只改判重键。

### 测试要求

- 新增测试：同一文件不同参数编辑 → novelty 应高于同一文件相同参数编辑
- 回归测试：现有的 novelty 测试行为不变（对路径级判重场景，argsHash fallback 到 target 时与当前行为一致）
- 边界：`argsHash` 为 undefined 时 fallback 到 `target`，旧测试仍通过

### 风险

低。`argsHash` 是可选的（`?`），fallback 保证了向后兼容。唯一需要注意的是 `JSON.stringify` 的参数排序——必须 `Object.keys(args).sort()` 保证确定性。

---

## 改动 2：tokenEfficiency 改用真实输出 token

### 现状（天枢）

`convergence-detector.ts` 的 `computeTokenEfficiency`（当前行约 262-310）：

```typescript
function computeTokenEfficiency(windowSize, history, _evidence): number {
  // 工具分类计数：readTools vs writeTools vs testTools
  // 用 productiveRatio + balanceBonus 启发式
  const rawEfficiency = productive / total
  // ...
}
```

用工具类型分类做代理。天枢当前 `ConvergenceInput` 中**没有 output token 计数字段**。

### omp 做法

`oh-my-pi/packages/agent/src/convergence-detector.ts:218-223`：

```typescript
function computeTokenEfficiency(toolCount: number, outputTokens: number): number {
  if (toolCount === 0) return 1;
  const tokensPerTool = outputTokens / toolCount;
  if (tokensPerTool <= 0) return 1;
  return Math.exp(-tokensPerTool / TOKEN_PER_TOOL_CUTOFF); // CUTOFF = 500
}
```

直接使用 LLM 返回的 `outputTokens` / `toolCount` 做指数衰减。500 token/tool 以上开始显著衰减。

### 实施步骤

**A. 在 `ConvergenceInput` 中新增字段**

```typescript
export interface ConvergenceInput {
  // ... existing fields ...
  /** Total LLM output tokens consumed so far in this session.
   *  Used by tokenEfficiency signal to measure real output cost vs tool calls. */
  outputTokens?: number
}
```

**B. 在 `loop.ts` 的调用点传入 outputTokens**

`loop.ts:1174-1184`，从 `this.usage.output_tokens`（或 session 的 total usage）传入。注意：`outputTokens` 应该是**累计值**，因为 tokenEfficiency 做 `tokens / toolCount` 计算——这个比率在连续多轮中保持稳定，用累计值比单轮值更平滑。

```typescript
const convergenceCheck = evaluateConvergence({
  // ... existing fields ...
  outputTokens: this.session?.getTotalUsage?.().output_tokens ?? this.totalTokens,
})
```

需要确认 `AgentLoop` 中可访问的 usage 数据源。一种方式是看 `loop-factory.ts` 中 `SelfApi.getUsage()` 的返回路径；另一种是直接从 loop 实例的 `config` 或状态中取。

**C. 替换 `computeTokenEfficiency`**

将现有的工具分类启发式替换为 omp 的指数衰减公式。保留一个混合模式过渡：当 `outputTokens` 不存在时回退到旧公式；存在时使用新公式。

```typescript
function computeTokenEfficiency(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
  evidence: ConvergenceInput['evidenceState'],
  outputTokens?: number,
): number {
  const toolCount = Math.min(windowSize, history.length)
  if (outputTokens !== undefined && toolCount > 0) {
    const tokensPerTool = outputTokens / toolCount
    if (tokensPerTool <= 0) return 1.0
    return Math.exp(-tokensPerTool / 500)
  }
  // Fallback: existing heuristic
  // ... 旧代码 ...
}
```

**D. 更新调用签名**

`computeConvergenceScore` 和 `evaluateConvergence` 需要传递 `outputTokens` 到 `computeTokenEfficiency`。

### 测试要求

- 新增测试：已知 outputTokens 和 toolCount，验证指数衰减值正确
- 边界：toolCount=0 → 1.0；tokensPerTool=0 → 1.0；tokensPerTool=500 → ~0.37；tokensPerTool=1500 → ~0.05
- 回归：旧测试（没有 outputTokens 传参）通过 fallback 仍走旧公式

### 风险

中低。需要确认 `loop.ts` 中 outputTokens 的可用性——如果当前 loop 实例没有直接暴露累计 token 数，可能需要从 `session` 或 `callbacks` 获取。优先查 `loop-factory.ts:SelfApi.getUsage()` 的路径。

---

## 改动 3：oscillationPenalty 位置反转替代严格二值

### 现状（天枢）

`convergence-detector.ts` 的 `computeOscillationPenalty`（当前行约 294-315）：

```typescript
function computeOscillationPenalty(fingerprints: ReadonlyArray<string>): number {
  const window = fingerprints.slice(-8)
  if (window.length < 6) return 1.0
  const unique = new Set(window)
  if (unique.size !== 2) return 1.0   // ← 严格二值：>2 直接退出
  const [a, b] = [...unique] as [string, string]
  let alternations = 0
  for (let i = 1; i < window.length; i++) {
    if (window[i] !== window[i! - 1]) alternations++
  }
  if (alternations >= 5) return 0.0
  if (alternations >= 3) return 0.3
  return 1.0
}
```

**问题**：要求 `new Set(window).size === 2`。当 agent 执行 A→B→A→C→A→B（3 个唯一值），直接退出返回 1.0（无惩罚），漏报了渐进式震荡。

### omp 做法

`oh-my-pi/packages/agent/src/convergence-detector.ts:229-244`：

```typescript
function computeOscillationPenalty(fingerprints: Fingerprint[]): number {
  const executed = fingerprints.filter(f => f.kind === "executed");
  if (executed.length < 4) return 1;

  const hashes = executed.map(f => f.argsHash);
  let reversals = 0;
  for (let i = 2; i < hashes.length; i++) {
    if (hashes[i] === hashes[i - 2] && hashes[i] !== hashes[i - 1]) {
      reversals++;
    }
  }
  const possibleReversals = hashes.length - 2;
  const oscillationRate = reversals / possibleReversals;
  return clamp01(1 - oscillationRate);
}
```

遍历全部 executed fingerprint 做 A-B-A 位置反转检测——`hash[i] === hash[i-2] && hash[i] !== hash[i-1]`。不要求恰好 2 个唯一值。返回 `1 - reversals/possibleReversals`，连续而非二值。

### 实施步骤

**A. 配合改动 1 获取 argsHash 级 fingerprint**

当前 `toolFingerprints` 的来源是 `this.traceStore.toolFingerprints`（`loop.ts:1181`）。如果这些 fingerprint 已经是工具名级（而非 argsHash 级），需要确认其来源和粒度。

查 `trace-store.ts` 中 `toolFingerprints` 的赋值逻辑：

```bash
grep -n "toolFingerprints" src/agent/trace-store.ts
```

**如果 toolFingerprints 当前是工具名级**，需要改为 argsHash 级（与改动 1 协同）。最简单的方式：直接在 `loop.ts` 构建 fingerprint 时使用 argsHash。

**如果当前已经是 argsHash 级**（从 `recentToolHistory` 的某个字段构建），则直接使用。

**B. 替换 `computeOscillationPenalty`**

```typescript
function computeOscillationPenalty(fingerprints: ReadonlyArray<string>): number {
  if (fingerprints.length < 4) return 1.0  // need at least 4 to detect oscillation
  let reversals = 0
  for (let i = 2; i < fingerprints.length; i++) {
    if (fingerprints[i] === fingerprints[i - 2] && fingerprints[i] !== fingerprints[i - 1]) {
      reversals++
    }
  }
  const possibleReversals = fingerprints.length - 2
  const oscillationRate = reversals / possibleReversals
  return Math.max(0, Math.min(1, 1 - oscillationRate))
}
```

返回连续值 0-1，不再使用旧的三段分档（0.0 / 0.3 / 1.0）。

**C. 检查下游消费者**

`computeConvergenceScore` 中 `oscillationPenalty` 作为 `weights.oscillationPenalty * signals.oscillationPenalty` 的加项使用——连续值天然兼容。无需改动。

`buildInjectedMessage` 中 `signals.oscillationPenalty < 0.3` 的判断仍然有效（连续值 < 0.3 仍然表示严重震荡）。

### 测试要求

- 新增测试：3 个唯一值的震荡序列（A→B→A→C→A→B→C→B）→ 旧算法返回 1.0，新算法应返回 < 1.0
- 新增测试：完全无震荡（全不同）→ 新算法 1.0
- 新增测试：严重 A-B-A-B-A-B-A-B → 新算法约 0.0
- 边界：<4 个 fingerprint → 1.0

### 风险

低。改动完全在 `computeOscillationPenalty` 函数内部，签名不变。唯一需要确认的是输入 `toolFingerprints` 的粒度是否为 argsHash 级——如果不是，需要和改动 1 一起调整。

---

## 改动依赖图

```
改动1 (argsHash) ─────┐
                       ├── 改动3 依赖改动1的 argsHash 粒度
改动2 (outputTokens) ──┤     (或至少依赖同一 fingerprint 源)
                       │
改动3 (positional) ────┘
```

建议顺序：先做改动 1（argsHash 基础设施），再做改动 3（oscillationPenalty 用 argsHash 级 fingerprint），最后做改动 2（tokenEfficiency 独立，无依赖）。

---

## 测试策略

| 文件 | 现有测试数 | 改动影响 | 需新增 |
|------|-----------|----------|--------|
| `convergence-detector.test.ts` | 43 | 3 个信号函数改动 | ~6-8 个测试 |
| `loop.test.ts` | ~30 | ConvergenceInput 新增字段 | 确认调用点传参不报错 |

### 关键测试场景

1. **argsHash 粒度**：`edit_file(a.ts, "x", "y")` vs `edit_file(a.ts, "y", "z")` → novelty 应不同
2. **tokenEfficiency 数学**：outputTokens=3000, toolCount=6 → tokensPerTool=500 → score≈0.37
3. **震荡升级**：序列 `['a','b','a','c','a','b','c','b']` → oscillationPenalty < 0.7（旧算法 = 1.0，漏报）

### 验证命令

```bash
npx tsc --noEmit
node --import tsx --test src/agent/__tests__/convergence-detector.test.ts
node --import tsx --test src/agent/__tests__/loop.test.ts
```

---

## 实施检查清单

- [ ] `ToolHistoryEntry` 新增 `argsHash?: string`
- [ ] `loop.ts` 写入 `recentToolHistory` 处计算 argsHash
- [ ] `ConvergenceInput.recentToolHistory` 类型扩展包含 `argsHash`
- [ ] `computeTargetNovelty` 改用 `argsHash ?? target` 判重
- [ ] 查 `traceStore.toolFingerprints` 粒度，确认为 argsHash 级
- [ ] `computeOscillationPenalty` 替换为位置反转算法
- [ ] `ConvergenceInput` 新增 `outputTokens?: number`
- [ ] `loop.ts` 传入 outputTokens
- [ ] `computeTokenEfficiency` 新增指数衰减路径 + fallback
- [ ] 更新测试：novelty 新增粒度测试、tokenEfficiency 新增数学测试、oscillation 新增多值震荡测试
- [ ] typecheck 通过
- [ ] 受影响测试全绿

---

## 核验补充（2026-06-27 代码审查）

以下发现来自对当前源码的实地核验，修正/补充原计划的若干假设。

### 发现 1：`fingerprintToolCall` 已存在，无需从零构造

`trace-store.ts:75-80` 已有 `fingerprintToolCall(name, input, outputClass)`，做的事正是计划描述的 argsHash——SHA256 of `{name, sortedInput, outputClass}`（`sortedStringify` 保证 key 排序确定性）。计划改动 1 的 `argsHash` 字段可以直接复用这个函数，无需在 `loop.ts` 或 `tool-history-recorder.ts` 中另写一套哈希逻辑。

### 发现 2：`toolFingerprints` 是双路径写入（⚠ 关键偏差）

`traceStore.toolFingerprints` 有**两个写入点**，粒度不同：

| 写入路径 | 位置 | 指纹生成 | 粒度 |
|----------|------|----------|------|
| `tool-execution.ts:384` | `recordToolNamedFingerprint(tu.id, tu.name)` | `tu.id`（API 返回的 tool_use_id） | 随机 UUID，永不重复 |
| `tool-pipeline.ts:1047` | `recordToolFingerprint(traceStore, fp, ...)` 其中 `fp = fingerprintToolCall(...)` | SHA256(name + sortedInput + outputClass) | **已是 argsHash 级** |

`tool-pipeline.ts` 路径在验证 harness 运行后才执行（有 `outputClass`），而 `tool-execution.ts` 路径在工具结果返回时立即执行。两条路径写入同一个数组，导致 `toolFingerprints` 中交替出现随机 UUID 和 argsHash。

**对改动 3 的影响**：随机 UUID 永远不会重复，会稀释震荡检测——UUID 让 `unique.size` 偏大，旧算法漏报更严重，新算法（位置反转）也会被 UUID 间隔打断 `hash[i]===hash[i-2]` 的匹配。

**修正方案**：改动 3 必须同时修改 `tool-execution.ts:384`，将 `tu.id` 替换为 `fingerprintToolCall(tu.name, tu.input, '<running>')`（此时尚无 outputClass，用 sentinel 占位）。或者更彻底——删除 `tool-execution.ts` 路径的 `recordToolNamedFingerprint` 调用，只保留 `tool-pipeline.ts` 路径的写入（因为 `tool-pipeline.ts` 有 outputClass 信息，指纹更精确）。

**推荐后者**（删除 `tool-execution.ts:384` 路径），理由：
- 消除重复写入：同一个工具调用写两次 fingerprint 是无意义的
- `tool-pipeline.ts` 的指纹更精确（含 outputClass）
- 验证 harness 失败时也会执行到 `tool-pipeline.ts:1047`（`fingerprintToolClass` 用 error class），不会丢失数据

但需确认 `tool-history-recorder.ts:85` 中 `self.traceStore.toolFingerprints[...]` 的读取是否依赖 `tool-execution.ts` 写入的时序。该行在 `tool-history-recorder.ts` 中用于 P3/Immune hook 的 `fp` 参数——如果先删 `tool-execution.ts` 写入，则 `tool-history-recorder.ts` 执行时 `toolFingerprints` 可能还没有该工具调用的指纹。需要把 `tool-history-recorder.ts:85` 改为直接用 `fingerprintToolCall(name, input, '<pending>')` 而非从数组中取，或者将 immune/physarum hook 的调用推迟到 pipeline 指纹写入后。

### 发现 3：`recentToolHistory` 的写入点不在 `loop.ts`

计划说"在 `loop.ts` 中写入 `recentToolHistory` 的位置计算 `argsHash`"。实际写入点在 `tool-history-recorder.ts:24`：

```typescript
self.recentToolHistory.push({
  tool: name,
  target,
  status: isError ? 'failed' : 'success',
  error: isError ? result.slice(0, 50) : undefined,
})
```

此处已有 `name`（工具名）和 `input`（参数），可以直接调用 `fingerprintToolCall(name, input, isError ? 'failed' : 'success')` 生成 `argsHash` 并存入 `ToolHistoryEntry`。

**修正**：改动 1 的 argsHash 计算应在 `tool-history-recorder.ts:24-29` 处完成，而非 `loop.ts`。

### 发现 4：`loop-factory.ts:230` 映射需同步

```typescript
recentToolHistory: self.recentToolHistory.map(h => ({ tool: h.tool, status: h.status, target: h.target })),
```

此处对 `recentToolHistory` 做了 Pick 映射传给某个消费者。如果 `ConvergenceInput.recentToolHistory` 类型扩展了 `argsHash`，此映射需同步添加 `argsHash: h.argsHash`。

### 发现 5：`recentToolHistory` 窗口上限 5，信号窗口是 6/10

`tool-history-recorder.ts:30`：`if (self.recentToolHistory.length > 5) self.recentToolHistory.shift()`。上限是 5 条。但收敛检测器的信号窗口是 6（200K tier）和 10（1M tier），意味着 `computeTargetNovelty`、`computeTokenEfficiency` 等永远用不满声明的窗口大小。这不阻塞当前改动，但合并时注意：信号计算中 `history.slice(-windowSize)` 在 history 只有 5 条时，与 `slice(-6)` 效果相同（都是取全部 5 条），不会报错。

### 更新后的实施检查清单（含以上发现）

- [ ] `ToolHistoryEntry` 新增 `argsHash?: string`
- [ ] `tool-history-recorder.ts:24` 处计算 argsHash（用 `fingerprintToolCall`）并存入
- [ ] `ConvergenceInput.recentToolHistory` 类型扩展包含 `argsHash`
- [ ] `loop-factory.ts:230` 映射同步添加 `argsHash`
- [ ] `computeTargetNovelty` 改用 `argsHash ?? target` 判重
- [ ] **改动 3 前置**：删除 `tool-execution.ts:384` 的 `recordToolNamedFingerprint` 调用，只保留 `tool-pipeline.ts:1047` 路径（或改为也用 `fingerprintToolCall`）
- [ ] `computeOscillationPenalty` 替换为位置反转算法
- [ ] `ConvergenceInput` 新增 `outputTokens?: number`
- [ ] `loop.ts` 传入 outputTokens（从 session usage 或 loop config 获取）
- [ ] `computeTokenEfficiency` 新增指数衰减路径 + fallback
- [ ] 更新测试：novelty 新增粒度测试、tokenEfficiency 新增数学测试、oscillation 新增多值震荡测试
- [ ] typecheck 通过
- [ ] 受影响测试全绿

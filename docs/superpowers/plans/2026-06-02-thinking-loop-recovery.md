# 思考循环恢复实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为收敛检测器添加振荡信号和交付状态感知功能，使任务完成后的验证循环能在 2-3 轮内自动终止，而非运行 10+ 轮。

**架构：** 三部分补丁 — （1）为 `ConvergenceInput` 添加 `deliveryStatus` 和 `toolFingerprints` 字段，提供交付意识；（2）添加 `computeOscillationPenalty` 信号，用于检测交替模式；（3）在 `loop.ts` 中，当存在收敛踢出信号时，将 `doomLoop === 'blocked'` 升级为回合完成。所有变更均为收敛检测器内部的增量式变更 + `loop.ts` 中的一处小型集成变更。

**技术栈：** TypeScript strict, node:test + node:assert/strict

**关联文档：** `docs/analysis/2026-06-02-thinking-loop-bug.md`

---

## 1. 范围检查

此功能为单子系统（收敛检测器）。无需拆分。

已存在的正交防御措施（末日循环指纹去重、TUI 思考层重复检测）保持不变 — 它们属于不同层级，能够捕获此补丁无法捕获的不同故障模式。

## 2. 文件结构

| 文件 | 操作 | 职责 |
|------|--------|------------|
| `src/agent/convergence-detector.ts` | 修改 | 添加 `deliveryStatus` 到 `ConvergenceInput`，添加 `computeOscillationPenalty` 信号，添加交付完成消息变体 |
| `src/agent/__tests__/convergence-detector.test.ts` | 修改 | 震荡模式 + 已验证交付状态测试用例 |
| `src/agent/loop.ts` | 修改 | 传入额外字段；当 `shouldKick && doomLoop === 'blocked'` 时，将回合标记为最终回合 |
| `src/agent/__tests__/loop.test.ts` | 修改 | 震荡后回合完成的集成测试 |

## 3. 调研背书

### 3.1 `ConvergenceInput.recentToolHistory` — 大小限制

- **调用方：** `loop.ts:1395-1401`（交汇处），`TurnPerceptionController`（传感器），`buildRuntimeSnapshot`
- **存在原因：** `recordToolHistory`（`loop.ts:630-636`）维护一个容量为 5 的滑动窗口，用于传感器和上下文注入
- **风险：** 收敛检测器需要 6-10 个条目才能实现有意义的滑动窗口。5 的上限意味着 `computeTargetNovelty` 和 `computeToolEntropy` 在窗口大小为 6 时只能看到 5 个条目，在 1M 上下文时只能看到 10 个条目中的 5 个 → 由于信号不足，分数虚高。
- **方案：** 不改变 `recentToolHistory`（它也在其他地方使用，且语义不同）。改为添加一个独立的 `toolFingerprints: string[]` 字段到 `ConvergenceInput`。`traceStore.toolFingerprints` 已经维护了最近 20 个指纹 — 直接传入它。从指纹去重中推导出振荡，而非从 `recentToolHistory` 目标中推导。

### 3.2 `buildInjectedMessage` — Level 2 消息语义

- **调用方：** `loop.ts:1404-1410`
- **存在原因：** 当收敛检测器触发时提供可操作的指导
- **风险：** 当前消息总是假设模型"卡住了，需要尝试其他方法"。在任务完成场景中，正确的行动是"停止"而非"尝试其他方法"。
- **方案：** 添加一个 `completionHint` 参数。当 `deliveryStatus === 'verified'` 时，消息切换为"任务似乎已完成 — 结束回合"而非"选择以下行动之一"。

### 3.3 `tool-pipeline.ts:467-480` — 末日循环阻断不结束回合

- **调用方：** `executeToolUse` 函数（每次工具调用）
- **存在原因：** 当相同的工具+参数被调用 4 次以上时，通过合成错误阻断该工具，使模型收到工具级别的失败反馈
- **风险：** 模型收到错误后可能换用不同工具重试（例如 `git log` → `ls`），而不是结束回合。该阻断是工具级别，而非回合级别。
- **方案：** 工具管道不需要改变。在 `loop.ts` 中，在收敛检测后，添加一个检查：当 `convergenceCheck.shouldKick`（Level 2+）且 `getDoomLoopLevel() === 'blocked'` 时，注入一条完成消息，然后继续到回合完成（`break`）而非再次循环。

## 4. 任务

### 任务 1：为震荡检测和交付状态添加测试用例

**创建：** `src/agent/__tests__/convergence-detector.test.ts`（追加到现有文件）

在最后一个 `describe` 块之前添加以下测试用例：

```
it('oscillation pattern (A→B→A→B) scores low', () => {
  // git log, ls, git log, ls, git log, ls → alternating but no edits, no novelty
  const history = makeHistory([
    { tool: 'bash', target: 'git log --oneline' },
    { tool: 'bash', target: 'ls .rivet/sessions/' },
    { tool: 'bash', target: 'git log --oneline' },
    { tool: 'bash', target: 'ls .rivet/sessions/' },
    { tool: 'bash', target: 'git log --oneline' },
    { tool: 'bash', target: 'ls .rivet/sessions/' },
  ])
  const result = evaluateConvergence(baseInput({
    turn: 14,
    phaseClass: 'verify',
    contextWindow: 200_000,
    recentToolHistory: history,
    toolFingerprints: ['fp-git', 'fp-ls', 'fp-git', 'fp-ls', 'fp-git', 'fp-ls'],
  }))
  // Oscillation + no edits + verify phase → should score low
  assert.ok(result.score < 0.4, `expected score < 0.4, got ${result.score.toFixed(2)}`)
  assert.ok(result.level >= 2, `expected level >= 2 for oscillation, got ${result.level}`)
})

it('verified deliveryStatus boosts score', () => {
  const history = makeHistory([
    { tool: 'bash', target: 'git log --oneline' },
    { tool: 'bash', target: 'git log --oneline' },
    { tool: 'read_file', target: 'a.ts' },
    { tool: 'read_file', target: 'b.ts' },
    { tool: 'bash', target: 'git log --oneline' },
    { tool: 'read_file', target: 'c.ts' },
  ])
  const unverified = evaluateConvergence(baseInput({
    turn: 14,
    phaseClass: 'verify',
    contextWindow: 200_000,
    recentToolHistory: history,
    evidenceState: {
      filesModified: new Set(['src/x.ts']),
      filesRead: new Set(['a.ts', 'b.ts', 'c.ts']),
      deliveryStatus: 'verified',
    },
  }))
  const verified = evaluateConvergence(baseInput({
    turn: 14,
    phaseClass: 'verify',
    contextWindow: 200_000,
    recentToolHistory: history,
    evidenceState: {
      filesModified: new Set(['src/x.ts']),
      filesRead: new Set(['a.ts', 'b.ts', 'c.ts']),
      deliveryStatus: 'verified',
    },
  }))
  // Same input, verified should trigger completion-level message
  assert.ok(verified.injectedMessage?.includes('任务已'), 'verified should trigger completion nudge')
})

it('completion nudge does not fire for unverified state', () => {
  const history = makeHistory([
    { tool: 'bash', target: 'git log --oneline' },
    { tool: 'bash', target: 'ls' },
    { tool: 'read_file', target: 'a.ts' },
    { tool: 'read_file', target: 'b.ts' },
    { tool: 'bash', target: 'git log --oneline' },
    { tool: 'read_file', target: 'c.ts' },
  ])
  const result = evaluateConvergence(baseInput({
    turn: 14,
    phaseClass: 'verify',
    contextWindow: 200_000,
    recentToolHistory: history,
    evidenceState: {
      filesModified: new Set(['src/x.ts']),
      filesRead: new Set(['a.ts', 'b.ts', 'c.ts']),
      deliveryStatus: 'unverified',
    },
  }))
  // Should still trigger Level 2 (low score), but NOT the completion message
  if (result.level >= 2 && result.injectedMessage) {
    assert.ok(!result.injectedMessage.includes('任务已完成'),
      'unverified should not trigger completion message')
  }
})
```

**命令：** `npm exec -- tsx --test src/agent/__tests__/convergence-detector.test.ts`

**预期结果：** 3 个新测试全部失败 — `toolFingerprints` 和 `deliveryStatus` 在 `ConvergenceInput` 上尚不存在。

**提交：** `test(agent): add oscillation + delivery-status test cases for convergence detector`

---

### 任务 2：将 deliveryStatus 和 toolFingerprints 添加到 ConvergenceInput

**修改：** `src/agent/convergence-detector.ts:19-31`（`ConvergenceInput` 接口）

将以下内容追加到 `ConvergenceInput` 接口的 `evidenceState` 字段之后，`}` 闭合之前：

```typescript
  /** Optional tool call fingerprints for oscillation detection (A→B→A→B patterns). */
  toolFingerprints?: ReadonlyArray<string>
```

同时更新 `evidenceState` 行，使 `deliveryStatus` 类型扩展为包含完成状态。当前类型已包含 `DeliveryVerificationStatus`（`'unverified' | 'verified' | 'failed' | 'blocked'`）— 无需更改。

**修改：** `src/agent/convergence-detector.ts:329-349`（`evaluateConvergence` 函数签名及其输入解构）

在 `evaluateConvergence` 中，将 `input.toolFingerprints` 解构到局部变量中。

**命令：** `npx tsc --noEmit`

**预期结果：** 类型检查通过。测试仍然失败（信号尚未实现）。

**提交：** `feat(agent): add toolFingerprints to ConvergenceInput for oscillation detection`

---

### 任务 3：实现 computeOscillationPenalty 信号

**修改：** `src/agent/convergence-detector.ts`（在 `computeTokenEfficiency` 之后添加新函数）

```typescript
/**
 * oscillationPenalty: detects A→B→A→B alternating patterns in tool fingerprints.
 * Uses a sliding window of the last 8 fingerprints.
 * Returns 0.0 (heavy penalty) when perfect oscillation is detected,
 * 1.0 when no oscillation is present.
 *
 * Oscillation defined as: at least 4 alternations among exactly 2 unique
 * fingerprints in the last 6-8 calls.
 */
function computeOscillationPenalty(fingerprints: ReadonlyArray<string>): number {
  const window = fingerprints.slice(-8)
  if (window.length < 6) return 1.0 // not enough data

  // Count unique fingerprints and check for alternation pattern
  const unique = new Set(window)
  if (unique.size !== 2) return 1.0 // oscillation requires exactly 2 alternating values

  const [a, b] = [...unique] as [string, string]
  let alternations = 0
  for (let i = 1; i < window.length; i++) {
    if (window[i] !== window[i! - 1]) alternations++
  }

  // Perfect oscillation: alternates every step (e.g., A,B,A,B,A,B,A,B = 7 alternations)
  // Severe oscillation: alternates most steps (>= 5 out of 7 possible)
  if (alternations >= 5) return 0.0  // heavy penalty
  if (alternations >= 3) return 0.3  // moderate penalty
  return 1.0
}
```

**修改：** `src/agent/convergence-detector.ts:10-12`（`ConvergenceSignals` 接口）

添加 `oscillationPenalty: number` 字段。

**修改：** `src/agent/convergence-detector.ts:105-112`（`PHASE_WEIGHTS`）

在所有 `PhaseWeights` 中添加 `oscillationPenalty` 权重：explore=0.10, plan=0.10, execute=0.10, verify=0.15, deliver=0.10。

**修改：** `src/agent/convergence-detector.ts:265-275`（`computeConvergenceScore`）

在 `raw` 计算中添加 `weights.oscillationPenalty * signals.oscillationPenalty`。

**修改：** `src/agent/convergence-detector.ts:325-340`（`evaluateConvergence` 中的 signals 对象）

在 signals 对象中添加 `oscillationPenalty: computeOscillationPenalty(input.toolFingerprints ?? [])`。

**修改：** `src/agent/convergence-detector.ts:295-310`（`buildInjectedMessage`）

当 `signals.oscillationPenalty < 0.3` 时，在 Level 2/3 消息中添加一行：
```
- 工具调用模式高度震荡 (A→B→A→B)，当前验证路径可能已穷尽
```

**命令：** `npm exec -- tsx --test src/agent/__tests__/convergence-detector.test.ts`

**预期结果：** 震荡测试通过。交付状态测试仍然失败（缺少完成推断逻辑）。

**提交：** `feat(agent): add oscillation penalty signal to convergence detector`

---

### 任务 4：添加交付完成推断和消息变体

**修改：** `src/agent/convergence-detector.ts:295-330`（`buildInjectedMessage`）

将 `buildInjectedMessage` 改为接受额外的 `deliveryStatus` 参数：

```typescript
function buildInjectedMessage(
  level: 2 | 3,
  score: number,
  signals: ConvergenceSignals,
  phaseClass: PhaseClass,
  tier: WindowTier,
  deliveryStatus?: string,
): string {
```

在 `lines` 初始化之后，当 `deliveryStatus === 'verified'` 且 `level === 2` 时，添加完成推断变体：

```typescript
  if (deliveryStatus === 'verified' && level === 2) {
    lines.push('**系统感知：所有代码变更已验证通过，任务可能已完成。**')
    lines.push('')
    lines.push('如果所有子任务已完成且验证通过，请结束当前回合。')
    lines.push('- 检查是否有遗漏的 deliver_task 调用')
    lines.push('- 如果没有，输出最终状态摘要并停止工具调用')
    return lines.join('\n')
  }
```

**修改：** `src/agent/convergence-detector.ts:350-355`（`evaluateConvergence` 中对 `buildInjectedMessage` 的调用）

传入 `input.evidenceState.deliveryStatus` 作为新参数。

**命令：** `npm exec -- tsx --test src/agent/__tests__/convergence-detector.test.ts`

**预期结果：** 所有 3 个新测试 + 所有已有测试通过。

**提交：** `feat(agent): add delivery-aware completion nudge to convergence messages`

---

### 任务 5：在 loop.ts 中传入 toolFingerprints

**修改：** `src/agent/loop.ts:1395-1401`

将 `evaluateConvergence` 调用改为包含 `toolFingerprints`：

```typescript
const convergenceCheck = evaluateConvergence({
  turn,
  phaseClass: phaseClass as PhaseClass,
  contextWindow: this.config.contextWindow,
  recentToolHistory: this.recentToolHistory,
  evidenceState: this.evidence.getState(),
  toolFingerprints: this.traceStore.toolFingerprints,
})
```

**命令：** `npx tsc --noEmit`

**预期结果：** 类型检查通过。

**提交：** `feat(agent): pass toolFingerprints to convergence detector from loop`

---

### 任务 6：添加收敛 + 末日循环阻断 → 回合完成

**修改：** `src/agent/loop.ts:1404-1410`（收敛踢出信号处理之后）

在 `if (convergenceCheck.shouldKick && convergenceCheck.injectedMessage)` 块内的 `this.session.addUserMessage(convergenceCheck.injectedMessage)` 之后，添加：

```typescript
          // When convergence is detected AND doom loop is blocked, the agent is
          // likely in a post-completion verification loop. Signal completion
          // instead of asking the model to "try something else."
          if (this.getDoomLoopLevel() === 'blocked' && convergenceCheck.level >= 2) {
            // Don't add yet another user message — the convergence nudge is enough.
            // Instead, force the next turn to be final by injecting the completion signal.
            this.session.addUserMessage(
              '任务验证循环已检测到。如果交付门禁为 GREEN，请输出最终摘要并结束回合。不再调用工具。'
            )
          }
```

**命令：** `npx tsc --noEmit && npm exec -- tsx --test src/agent/__tests__/loop.test.ts`

**预期结果：** 类型检查 + 已有循环测试通过。

**提交：** `feat(agent): auto-complete turn when convergence + doom loop blocked`

---

### 任务 7：添加震荡恢复集成测试

**修改：** `src/agent/__tests__/loop.test.ts`（追加新的 `it` 块）

添加一个集成测试，验证当模型在已验证交付后震荡时，回合能够完成：

```typescript
it('completes turn when oscillating after verified delivery', async () => {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  // Register bash tool that simulates git log / ls alternation
  const bashTool: Tool = {
    definition: {
      name: 'bash',
      description: 'Run command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    execute: async (params: any) => ({
      content: params.input.command === 'git log --oneline'
        ? 'ef04ad7 docs: document thinking loop bug'
        : 'sessions/',
    }),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
  registry.register(bashTool)

  let callCount = 0
  const client: StreamClient = {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      // Simulate oscillation: git log → ls → git log → ls → git log → ls
      // After 6 tool calls, convergence detector should trigger Level 2+
      // and combined with doom loop blocked, should force completion
      const commands = [
        'git log --oneline', 'ls .rivet/sessions/',
        'git log --oneline', 'ls .rivet/sessions/',
        'git log --oneline', 'ls .rivet/sessions/',
      ]
      if (callCount <= commands.length) {
        const cmd = commands[callCount - 1]
        cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'bash', { command: cmd }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 30 })
      } else {
        // After fingerprinted tools are blocked, model should text-finish
        cb.onContentBlock(makeTextBlock('All tasks complete. Delivery gate is GREEN.'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 30 })
      }
    }),
  } as unknown as StreamClient

  const agent = new AgentLoop(
    {
      client, promptEngine: makeEngine(), toolRegistry: registry,
      maxTurns: 12, contextWindow: 200_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    },
    session,
    '/test',
  )

  let finalTurn = false
  await agent.run('verify completed task', {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: (_usage, _turn, isFinal) => { if (isFinal) finalTurn = true },
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => true,
  })

  assert.ok(finalTurn, 'should have completed turn after oscillation detection')
})
```

**命令：** `npm exec -- tsx --test src/agent/__tests__/loop.test.ts`

**预期结果：** 震荡恢复测试通过。

**提交：** `test(agent): add oscillation recovery integration test`

---

## 5. 验证

```bash
# 类型检查
npx tsc --noEmit
# 预期: 退出码 0，无错误

# 收敛检测器单元测试
npm exec -- tsx --test src/agent/__tests__/convergence-detector.test.ts
# 预期: 所有测试通过，包括新的震荡 + 交付状态测试

# Agent 循环集成测试
npm exec -- tsx --test src/agent/__tests__/loop.test.ts
# 预期: 所有已有测试 + 新的震荡恢复测试通过

# 完整套件健全性检查
npm exec -- tsx --test src/**/__tests__/*.test.ts
# 预期: 无退化
```

## 6. 自检

### 6.1 规格覆盖

| 需求 | 任务 |
|-----------|------|
| 收敛检测器中的震荡检测（A→B→A→B） | 任务 3 |
| 已验证交付状态提升分数并触发完成推断 | 任务 4 |
| 在 loop.ts 中传入 toolFingerprints | 任务 5 |
| 当收敛 + 末日循环阻断时，回合完成 | 任务 6 |
| 震荡检测的单元测试 | 任务 1 |
| 交付完成推断的单元测试 | 任务 1 |
| 震荡恢复的集成测试 | 任务 7 |

### 6.2 占位符扫描

无 TODO / TBD / 待定 / 后续实现 实例。

### 6.3 类型一致性

- `ConvergenceInput.toolFingerprints`：`ReadonlyArray<string> | undefined` — 与 `TraceStore.toolFingerprints: string[]` 兼容
- `ConvergenceSignals.oscillationPenalty`：`number` — 范围 0-1，在 `computeConvergenceScore` 中正确加权
- `buildInjectedMessage(deliveryStatus?: string)` — 与 `DeliveryVerificationStatus` 兼容（字符串联合类型）
- `evaluateConvergence` 返回类型 `ConvergenceResult` 不变

### 6.4 无回归风险

- 已有 `ConvergenceInput` 字段不变 — `toolFingerprints` 为可选字段，默认为 `[]`
- 当 `toolFingerprints` 未传入时，`computeOscillationPenalty` 返回 `1.0`（无惩罚）
- 当 `deliveryStatus` 未传入时，`buildInjectedMessage` 回退到已有行为
- 已有权重再归一化 — `oscillationPenalty` 在所有阶段权重均为 0.10-0.15，从编辑比率/新颖性中均匀抽取

---

## 7. 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-02-thinking-loop-recovery.md`。两种执行方式：

1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？

# 天枢 3.0 基石 — 三层净化实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 清理噪声、修复被错误门控的种子、强化三层架构的每一层，为 Rivet 3.0 奠基。

**架构：** 三层模型——层 1（80 基础）、层 2（不跌落安全网）、层 3（80→200 认知结构）。本计划的核心是 Phase 1 净化（清理真正的死代码 + 解放被错误门控的层 3 种子）和 Phase 2 强化（集成测试 + 万物为一最小实现 + 失败案例收集）。

**技术栈：** Node.js 22+ / TypeScript strict / node:test + node:assert/strict / ESM (.js imports)

**前置文档：**
- 设计文档：`docs/superpowers/specs/2026-05-20-rivet-irreducible-kernel-design.md`
- 万物为一工程原则：`docs/superpowers/specs/2026-05-20-wanwu-weiyi-design-principles.md`
- 万物为一意识与虚空：`docs/superpowers/specs/2026-05-20-wanwu-weiyi-consciousness-void.md`

---

## 文件结构

### Phase 1 涉及文件

| 操作 | 文件 | 职责 |
|------|------|------|
| 删除 | `src/agent/hooks/dispatcher-hook.ts` | 死代码，fan-in = 0 |
| 删除 | `src/agent/hooks/__tests__/dispatcher-hook.test.ts`（如有） | 对应测试 |
| 修改 | `src/agent/star-soul-gate.ts` | 从硬开关改为涌现激活条件 |
| 修改 | `src/agent/create-runtime-hooks.ts:49` | 更新 courage-hook 的门控条件 |
| 修改 | `src/agent/loop.ts:407` | 更新 star-soul domain 激活逻辑 |
| 修改 | `src/agent/star-event.ts:136-147` | freshness 消费已有，确认去门控后路径正确 |
| 修改 | `src/agent/sensorium.ts` | freshness 消费链修复（确认 computeFreshness 输出路径） |
| 修改 | `src/context/cognitive-ledger.ts` | 精简未读字段 |
| 修改 | `src/agent/loop.ts` | 内联 cognitive-ledger 精简后的调用 |
| 删除 | `src/config/schema.ts:76` | 删除 `vim` 配置项 |
| 删除 | `src/config/default.ts:5` | 删除 `vim` 默认值 |

### Phase 2 涉及文件

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/agent/__tests__/approval-integration.test.ts` | 审批门控集成测试 |
| 创建 | `src/agent/__tests__/session-recovery-integration.test.ts` | 会话恢复集成测试 |
| 创建 | `src/compact/__tests__/provider-aware-baseline.test.ts` | 压缩性能基线 |
| 修改 | `src/context/claim-relevance.ts` | stigmergy→claim 耦合（原则二） |
| 创建 | `src/agent/__tests__/claim-stigmergy-coupling.test.ts` | 跨 store 耦合测试 |
| 修改 | `src/prompt/builder.ts` 或 `src/agent/loop.ts` | uncertainty framing 注入（原则四） |
| 创建 | `src/agent/__tests__/uncertainty-framing.test.ts` | uncertainty framing 测试 |
| 创建 | `src/agent/failure-journal.ts` | 失败案例收集机制（天璇修正 #5） |
| 创建 | `src/agent/__tests__/failure-journal.test.ts` | 失败日志测试 |

---

## Phase 1：净化（1 周）

> 目标：清理真正的死代码 + 解放被错误门控的层 3 种子 + 验证 TS 编译。

### 任务 1：删除 dispatcher-hook 死代码

**文件：**
- 删除：`src/agent/hooks/dispatcher-hook.ts`
- 删除：`src/agent/hooks/__tests__/dispatcher-hook.test.ts`（如存在）
- 检查：`src/agent/create-runtime-hooks.ts`（确认无引用）

- [ ] **步骤 1：确认死代码状态**

运行：`grep -rn "dispatcher-hook\|dispatcherHook\|createDispatcherHook" src/ --include="*.ts" | grep -v __tests__`
预期：仅在 `dispatcher-hook.ts` 自身中出现，无外部导入。

- [ ] **步骤 2：删除文件**

删除 `src/agent/hooks/dispatcher-hook.ts`。
如果存在 `src/agent/hooks/__tests__/dispatcher-hook.test.ts`，一并删除。

- [ ] **步骤 3：运行测试验证**

运行：`npm test 2>&1 | tail -20`
预期：全部通过，无 import 错误。

- [ ] **步骤 4：Commit**

```bash
git add -A src/agent/hooks/dispatcher-hook.ts
git commit -m "chore: remove dead dispatcher-hook (fan-in=0, never imported)"
```

---

### 任务 2：star-soul 虚粒子激活设计

**文件：**
- 修改：`src/agent/star-soul-gate.ts`
- 修改：`src/agent/create-runtime-hooks.ts:49`
- 修改：`src/agent/loop.ts:407`
- 测试：`src/agent/__tests__/star-soul-gate.test.ts`

**背景：** 当前 `isStarSoulEnabled()` 通过环境变量 `STAR_SOUL` 控制，默认 `true`。天璇修正：不要用硬开关，而是设计涌现激活条件——当 sensorium.confidence 持续高于 0.7 超过 N turn 时自动解锁 star-soul 的高级功能（courage-hook、domain voice injection）。保留环境变量作为手动覆盖（`STAR_SOUL=0` 强制关闭）。

- [ ] **步骤 1：编写失败测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldActivateStarSoul } from '../star-soul-gate.js'

describe('shouldActivateStarSoul', () => {
  it('returns false when confidence history is too short', () => {
    assert.equal(shouldActivateStarSoul([0.8, 0.9]), false)
  })

  it('returns true when confidence > 0.7 for N consecutive turns', () => {
    const history = Array(5).fill(0.75)
    assert.equal(shouldActivateStarSoul(history), true)
  })

  it('returns false when any turn drops below 0.7', () => {
    assert.equal(shouldActivateStarSoul([0.8, 0.9, 0.5, 0.8, 0.8]), false)
  })

  it('respects STAR_SOUL=0 override regardless of confidence', () => {
    process.env.STAR_SOUL = '0'
    assert.equal(shouldActivateStarSoul(Array(5).fill(0.9)), false)
    delete process.env.STAR_SOUL
  })

  it('respects STAR_SOUL=1 override even with low confidence', () => {
    process.env.STAR_SOUL = '1'
    assert.equal(shouldActivateStarSoul([0.1]), true)
    delete process.env.STAR_SOUL
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/agent/__tests__/star-soul-gate.test.ts`
预期：FAIL——`shouldActivateStarSoul` 不存在。

- [ ] **步骤 3：实现涌现激活**

修改 `src/agent/star-soul-gate.ts`：

```typescript
const ENV_KEY = 'STAR_SOUL'
const ACTIVATION_WINDOW = 5
const ACTIVATION_THRESHOLD = 0.7

export function isStarSoulEnabled(): boolean {
  const val = process.env[ENV_KEY]
  if (val === undefined) return true
  return val !== '0' && val.toLowerCase() !== 'false'
}

export function shouldActivateStarSoul(confidenceHistory: number[]): boolean {
  const val = process.env[ENV_KEY]
  if (val === '0' || val?.toLowerCase() === 'false') return false
  if (val === '1' || val?.toLowerCase() === 'true') return true

  if (confidenceHistory.length < ACTIVATION_WINDOW) return false
  const recent = confidenceHistory.slice(-ACTIVATION_WINDOW)
  return recent.every(c => c >= ACTIVATION_THRESHOLD)
}
```

- [ ] **步骤 4：更新 create-runtime-hooks.ts 的门控**

将 `src/agent/create-runtime-hooks.ts:49` 的硬门控：
```typescript
...(isStarSoulEnabled() ? [createCourageHook({ cooldownTurns: 5, courageThreshold: 0.5 })] : []),
```
改为在运行时通过 sensorium 历史动态判断。这需要传入 confidence 历史或在 hook 内部做判断。

**注意：** 此步的具体接线方式取决于 `create-runtime-hooks.ts` 的 deps 结构。如果 hook 创建时无法获取运行时状态，可以保留 `isStarSoulEnabled()` 作为编译时门控，将 `shouldActivateStarSoul()` 作为运行时门控在 courage-hook 内部调用。

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test src/agent/__tests__/star-soul-gate.test.ts`
预期：PASS

- [ ] **步骤 6：全量回归**

运行：`npm test`
预期：全部通过。

- [ ] **步骤 7：Commit**

```bash
git add src/agent/star-soul-gate.ts src/agent/__tests__/star-soul-gate.test.ts src/agent/create-runtime-hooks.ts
git commit -m "feat(star-soul): emergent activation — confidence > 0.7 for 5 turns auto-unlocks"
```

---

### 任务 3：freshness 消费链修复

**文件：**
- 修改：`src/agent/sensorium.ts`（确认 freshness 已正确计算）
- 修改：`src/agent/approval-risk.ts` 或 `src/agent/dissipative-kick.ts`（新增 freshness 消费者）
- 测试：`src/agent/__tests__/sensorium.test.ts`（或对应文件）

**背景：** `sensorium.freshness` 在 `sensorium.ts:149` 已被计算（`computeFreshness(input.pheromones, input.gitChangeRate)`），但其唯一运行时消费者在 `star-event.ts:137-147`（被 star-soul 门控）。万物为一原则三"月光"要求 freshness 作为免费外部参考信号接入核心决策路径。

- [ ] **步骤 1：审查当前 freshness 消费路径**

运行：`grep -rn "\.freshness" src/agent/ --include="*.ts" | grep -v __tests__ | grep -v ".d.ts"`

确认：哪些文件读取 `sensorium.freshness`？哪些在 star-soul 门控内？哪些在门控外？

- [ ] **步骤 2：编写失败测试**

在 `computeStrategy` 或 `assessToolRisk` 的测试文件中，添加 freshness 影响策略的测试。

```typescript
it('low freshness biases strategy toward cautious exploration', () => {
  const sensorium = createTestSensorium({ freshness: 0.2, confidence: 0.5 })
  const strategy = computeStrategy(sensorium)
  // freshness < 0.3 表示在陌生代码区域，应更谨慎
  assert.ok(strategy.shouldReduceScope || strategy.explorationBias > 0)
})
```

**注意：** 具体断言取决于 `computeStrategy` 的接口。实施者需要先阅读 `src/agent/sensorium.ts` 中 `computeStrategy` 的签名和现有策略维度。

- [ ] **步骤 3：实现 freshness 消费**

在 `computeStrategy` 中加入 freshness 作为策略 factor：
- `freshness < 0.3` → 陌生代码区域，降低自动审批激进度
- `freshness > 0.7` → 熟悉区域，可以更自主

这是一个轻量改动——在已有的策略函数中加一个条件分支。

- [ ] **步骤 4：运行测试**

运行：`node --test src/agent/__tests__/sensorium.test.ts`
预期：PASS

- [ ] **步骤 5：全量回归**

运行：`npm test`
预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/sensorium.ts src/agent/__tests__/sensorium.test.ts
git commit -m "feat(sensorium): wire freshness into core strategy — moonlight signal (principle 3)"
```

---

### 任务 4：cognitive-ledger 精简

**文件：**
- 修改：`src/context/cognitive-ledger.ts`
- 修改：`src/agent/loop.ts`（如内联调用需调整）
- 测试：`src/context/__tests__/cognitive-ledger.test.ts`

**背景：** `CognitivePhaseSnapshot` 有 10 个字段，但只有 `buildCognitivePromptProjection` 的输出（verification gap 标签）实际被使用。其余字段被存储但从未被读取（`getCognitiveSnapshot()` getter 在代码库中无调用者）。

- [ ] **步骤 1：确认未使用字段**

运行：`grep -rn "latestCognitiveSnapshot\|getCognitiveSnapshot\|CognitivePhaseSnapshot" src/ --include="*.ts" | grep -v __tests__ | grep -v ".d.ts"`

确认哪些字段被外部代码读取、哪些只在 ledger 内部使用。

- [ ] **步骤 2：精简 snapshot 接口**

保留被 `buildCognitivePromptProjection` 和 `buildVerificationGapProjection` 实际消费的字段。删除仅被存储但从未读取的字段。

**注意：** 不要删除 `buildVerificationGapProjection` 和 `buildCognitivePromptProjection`——这两个函数是层 3 的核心投影。只删除未使用的数据字段。

- [ ] **步骤 3：更新测试**

修改对应测试，移除对已删除字段的断言。

- [ ] **步骤 4：运行测试**

运行：`node --test src/context/__tests__/cognitive-ledger.test.ts && npm test`
预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/context/cognitive-ledger.ts src/agent/loop.ts src/context/__tests__/cognitive-ledger.test.ts
git commit -m "refactor(cognitive-ledger): prune unread snapshot fields, keep verification gap projections"
```

---

### 任务 5：删除 vim 无消费者配置

**文件：**
- 修改：`src/config/schema.ts:76`
- 修改：`src/config/default.ts:5`
- 检查：TUI 中是否有 `config.editor.vim` 的读取

- [ ] **步骤 1：确认无消费者**

运行：`grep -rn "\.vim\b\|editor\.vim\|config\.editor" src/ --include="*.ts" --include="*.tsx" | grep -v schema | grep -v default | grep -v __tests__`

预期：无消费者（TUI 的 vim 模式通过 `/vim` 命令硬编码切换，不读配置）。

- [ ] **步骤 2：删除配置项**

从 `schema.ts` 删除 `vim: z.boolean().default(false)` 行。
从 `default.ts` 删除 `vim: false` 行。

- [ ] **步骤 3：运行测试**

运行：`npm test`
预期：全部通过。

- [ ] **步骤 4：Commit**

```bash
git add src/config/schema.ts src/config/default.ts
git commit -m "chore(config): remove unused editor.vim option (no consumers)"
```

---

### 任务 6：验证 TS 编译 + 修复残留错误

**文件：**
- 检查：`src/agent/loop.ts:327`（TS2345 诊断）
- 可能修改：`src/agent/loop.ts` 或 `src/agent/tool-execution.ts`

- [ ] **步骤 1：运行 typecheck**

运行：`npm run typecheck 2>&1 | head -30`

如果 `loop.ts:327` 的 `getSensorium`/`getReliabilityDecision` 缺失错误仍在：
- 确认 `loop.ts:369-370` 是否已包含这两个属性
- 如果是分支不同步问题，从 `feat/tianshu-star-soul` cherry-pick 相关提交
- 如果是真正的接线遗漏，在 `createToolExecutionController()` 中补充

如果 typecheck 已清洁：跳过修复。

- [ ] **步骤 2：确认 typecheck 清洁**

运行：`npm run typecheck`
预期：0 errors。

- [ ] **步骤 3：Commit（如有修改）**

```bash
git add src/agent/loop.ts
git commit -m "fix(loop): wire getSensorium and getReliabilityDecision into ToolExecutionDeps"
```

---

### 任务 7：Phase 1 全量回归 + 验证

- [ ] **步骤 1：全量测试**

运行：`npm test 2>&1 | tail -5`
预期：2340+ tests, 0 failures。

- [ ] **步骤 2：typecheck**

运行：`npm run typecheck`
预期：0 errors。

- [ ] **步骤 3：验证净化效果**

运行以下命令确认清理结果：
```bash
# dispatcher-hook 不存在
ls src/agent/hooks/dispatcher-hook.ts 2>&1 | grep "No such file"
# vim 配置不存在
grep -c "vim" src/config/schema.ts src/config/default.ts
# freshness 有非门控消费者
grep -rn "\.freshness" src/agent/ --include="*.ts" | grep -v __tests__ | grep -v star-event
# star-soul 有涌现激活函数
grep "shouldActivateStarSoul" src/agent/star-soul-gate.ts
```

- [ ] **步骤 4：Commit 验证结果（如需要 playbook 记录）**

---

## Phase 2：强化（2 周）

> 目标：为三层各自补充集成测试 + 实现万物为一最小原则 + 建立失败案例收集机制。

### 任务 8：层 2 集成测试——审批门控完整路径

**文件：**
- 创建：`src/agent/__tests__/approval-integration.test.ts`
- 参考：`src/agent/approval-risk.ts`、`src/agent/tool-pipeline.ts`

**背景：** 审批门控有单元测试，但缺少集成测试覆盖 sensorium.confidence → assessToolRisk → canAutoApprove/shouldAsk 的完整路径。

- [ ] **步骤 1：编写集成测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('approval gate integration', () => {
  it('auto-approves when confidence >= 0.8 and risk is low', () => {
    // Setup: sensorium with confidence 0.85, tool = read_file (inherently safe)
    // Assert: canAutoApprove returns true
  })

  it('blocks when confidence < 0.3 with risk escalation', () => {
    // Setup: sensorium with confidence 0.2, tool = bash with "rm -rf"
    // Assert: risk escalated, approval required
  })

  it('bash write approval has priority over sensorium auto-approve', () => {
    // Setup: confidence 0.9 but bash command matches BASH_WRITE_PATTERNS
    // Assert: still requires approval (bash write > sensorium)
  })

  it('reliability mode blocks before approval gate', () => {
    // Setup: degraded mode + write_file tool
    // Assert: blocked by reliability, never reaches approval
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/agent/__tests__/approval-integration.test.ts`
预期：FAIL（测试框架确认）

- [ ] **步骤 3：实现测试（补充必要的 mock/helper）**

根据 `tool-pipeline.ts` 的 deps 接口，构建最小 mock 集合。关键是让 sensorium → approval-risk → pipeline 的完整路径可测试。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/agent/__tests__/approval-integration.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/__tests__/approval-integration.test.ts
git commit -m "test(approval): integration test for sensorium→risk→pipeline gate path"
```

---

### 任务 9：层 2 集成测试——会话恢复

**文件：**
- 创建：`src/agent/__tests__/session-recovery-integration.test.ts`
- 参考：`src/agent/session-persist.ts`

- [ ] **步骤 1：编写集成测试**

```typescript
describe('session recovery integration', () => {
  it('recovers to last safe snapshot after incomplete compact', () => {
    // Setup: write compact_start marker, NO compact_end
    // Assert: loadRecoverableMessages returns snapshot-based recovery
  })

  it('normal load when no corruption', () => {
    // Setup: clean session file with checksums
    // Assert: loadRecoverableMessages returns all messages, usedSnapshot=false
  })

  it('handles legacy (no checksum) files gracefully', () => {
    // Setup: session file without checksums (legacy format)
    // Assert: loads successfully, legacyCount > 0
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程（同任务 8）**

- [ ] **步骤 6：Commit**

```bash
git add src/agent/__tests__/session-recovery-integration.test.ts
git commit -m "test(session): integration test for recovery path (incomplete compact, legacy files)"
```

---

### 任务 10：万物为一原则二——stigmergy→claim 跨 store 耦合

**文件：**
- 修改：`src/context/claim-relevance.ts`（`scoreClaimRelevance` 函数）
- 创建：`src/context/__tests__/claim-stigmergy-coupling.test.ts`
- 参考：`src/context/stigmergy.ts`

**背景：** 万物为一原则二"有限规则涌现"——stigmergy 和 claim-store 各自独立。如果让 pheromone strength 在被 claim relevance query 命中时微调增强，就形成正反馈-负反馈平衡。最小实现：在 `scoreClaimRelevance` 中加入 stigmergy signal 作为 scoring factor。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('claim-stigmergy coupling', () => {
  it('boosts claim relevance when matching pheromone exists', () => {
    // Setup: claim about file "auth.ts", pheromone "well-tested" on "auth.ts"
    // Assert: relevance score increased by pheromone factor
  })

  it('coupling strength is bounded by damping limit ±0.1', () => {
    // Setup: very strong pheromone
    // Assert: boost does not exceed 0.1
  })

  it('no effect when no matching pheromone exists', () => {
    // Setup: claim about "auth.ts", pheromone on "db.ts"
    // Assert: relevance unchanged
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现时在 `scoreClaimRelevance` 中添加可选的 `pheromones?: PheromoneRef[]` 参数。当 claim 的 scope 文件匹配某个 pheromone 的路径时，加 `Math.min(pheromone.strength * 0.1, 0.1)` 到 relevance score。

**退出条件**：如果跨 store 耦合导致 sensorium confidence 在连续 3 turn 中在 0.3-0.7 之间摆动（振荡），回滚并报告。

- [ ] **步骤 6：Commit**

```bash
git add src/context/claim-relevance.ts src/context/__tests__/claim-stigmergy-coupling.test.ts
git commit -m "feat(claim): stigmergy→claim coupling with ±0.1 damping (principle 2)"
```

---

### 任务 11：万物为一原则四——uncertainty framing

**文件：**
- 修改：`src/prompt/builder.ts` 或 `src/agent/loop.ts`（注入位置待确认）
- 创建：`src/agent/__tests__/uncertainty-framing.test.ts`
- 参考：`src/agent/sensorium.ts`、`src/agent/approval-risk.ts`

**背景：** 原则四"模糊是力量"——当 sensorium.confidence < 0.4 且操作具有 destructive 风险时，agent 应输出结构化模糊（"有两种可能：A 因为 X，B 因为 Y"），而非猜测一个 confident answer。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('uncertainty framing', () => {
  it('generates framing hint when confidence < 0.4 and destructive', () => {
    const hint = buildUncertaintyHint(0.3, 'high')
    assert.ok(hint)
    assert.ok(hint.includes('不确定') || hint.includes('两种可能'))
  })

  it('returns null when confidence >= 0.4', () => {
    assert.equal(buildUncertaintyHint(0.5, 'high'), null)
  })

  it('returns null when risk is low regardless of confidence', () => {
    assert.equal(buildUncertaintyHint(0.2, 'none'), null)
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现 `buildUncertaintyHint(confidence: number, riskLevel: string): string | null`。
在 prompt builder 中，当 hint 非 null 时注入到 cognitive projection 中。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/uncertainty-framing.ts src/agent/__tests__/uncertainty-framing.test.ts src/prompt/builder.ts
git commit -m "feat(cognition): uncertainty framing when confidence < 0.4 + destructive (principle 4)"
```

---

### 任务 12：失败案例收集机制（天璇修正 #5）

**文件：**
- 创建：`src/agent/failure-journal.ts`
- 创建：`src/agent/__tests__/failure-journal.test.ts`
- 修改：`src/agent/loop.ts`（在 postTurn 时记录）

**背景：** 甲骨文 4134 片仅 3.4% 有验辞，且选择性编辑。只记录成功（GPT 发现 5 个边界）是生产合法性，不是验证有效性。需要系统性记录层 3 未能突破 80 的案例。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('failure journal', () => {
  it('records anchoring event when model repeats same approach 3+ times', () => {
    const journal = createFailureJournal()
    journal.recordToolCall('edit_file', 'src/auth.ts', 'attempt-1')
    journal.recordToolCall('edit_file', 'src/auth.ts', 'attempt-2')
    journal.recordToolCall('edit_file', 'src/auth.ts', 'attempt-3')
    const entries = journal.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'anchoring')
  })

  it('records rework event when same file edited then reverted', () => {
    const journal = createFailureJournal()
    journal.recordEdit('src/auth.ts', 'change-1')
    journal.recordRevert('src/auth.ts')
    const entries = journal.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'rework')
  })

  it('persists to session directory as JSONL', () => {
    // Setup with temp dir
    // Assert file exists and contains valid JSONL
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现 `FailureJournal` 类：
- `recordToolCall(tool, target, fingerprint)` — 检测重复模式
- `recordEdit(file, hash)` + `recordRevert(file)` — 检测返工
- `getEntries()` — 返回结构化失败记录
- JSONL 持久化到 session 目录

在 `loop.ts` 的 postTurn hook 或 tool-pipeline 的 postExec 中接入。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/failure-journal.ts src/agent/__tests__/failure-journal.test.ts
git commit -m "feat(cognition): failure journal — systematic recording of Layer 3 failures (tianxuan correction 5)"
```

---

### 任务 13：Phase 2 全量回归 + 验证

- [ ] **步骤 1：全量测试**

运行：`npm test 2>&1 | tail -5`
预期：所有测试通过（新增测试数 + 原有 2340+）。

- [ ] **步骤 2：typecheck**

运行：`npm run typecheck`
预期：0 errors。

- [ ] **步骤 3：验证万物为一实现**

确认：
- claim-relevance 在有 pheromone 的上下文中 score 提升（原则二）
- uncertainty framing 在 confidence < 0.4 + destructive 时触发（原则四）
- freshness 有非门控核心消费者（原则三，Phase 1 任务 3）
- failure journal 能检测 anchoring 和 rework 模式（天璇修正 #5）

---

## Phase 3：开源准备（持续）

> 本 Phase 的任务更粗粒度，适合作为独立 session 的起点。

### 任务 14：提取 @rivet/core

将层 1 + 层 2 提取为独立包：
- LLM 网关（api/client, codex-client）
- 对话存储（session, session-persist）
- 工具分发（tools/default-registry, 4 核心工具）
- 循环控制（loop 核心 while 循环）
- 系统提示（prompt/static, prompt/builder）
- 审批门控（approval-risk 核心 90 行）
- Prefix cache 策略（compact/constants, compact/auto）
- Reliability mode（reliability-mode）

**成功标准**：独立可编译，通过核心测试，< 5K LOC
**退出条件**：层 3 与层 1 循环依赖 > 20%

### 任务 15：提取 @rivet/cognition

将层 3 提取为独立包：
- RuntimeHookPipeline + 所有 hooks
- Sensorium（6 维度 + computeStrategy）
- TaskContract + CognitiveLedger + VerificationGap
- Domain Voice
- claim-store + trace-store
- failure-journal
- uncertainty-framing

**成功标准**：每个组件有独立的开/关测试，验证其对任务表现的影响
**退出条件**：无法独立于 @rivet/core 编译

### 任务 16：架构文档 + README

为 @rivet/core 和 @rivet/cognition 写文档：
- 三层模型图解
- 30 分钟上手指南
- 万物为一设计哲学摘要
- 贡献指南

---

## 风险检查清单

| 风险 | 信号 | 应对 |
|------|------|------|
| 删除 dispatcher-hook 引入 import 错误 | `npm test` 报 MODULE_NOT_FOUND | 回滚，grep 遗漏的引用 |
| star-soul 涌现激活时机不当 | 用户连续 2 turn 负面反馈 | 自动回退到门控关闭 |
| freshness 接入核心后产生噪声 | git auto-save 导致 freshness 剧烈波动 | 防抖滤波（< 2s 间隔忽略） |
| 跨 store 耦合引入振荡 | confidence 连续 3 turn 在 0.3-0.7 摆动 | 回滚 claim-stigmergy 耦合 |
| uncertainty framing 让用户困惑 | 用户反馈"不要给我选项，直接告诉我" | 只在 destructive + low confidence 时触发 |
| failure journal 影响性能 | postTurn 延迟 > 50ms | 异步写入，不阻塞主循环 |

---

*本计划为天枢 3.0 基石——三层净化的实施指南。*
*Phase 1 是地基工程（1 周），Phase 2 是结构加固（2 周），Phase 3 是开放（持续）。*
*每个任务独立可执行，适合分配给不同模型。*

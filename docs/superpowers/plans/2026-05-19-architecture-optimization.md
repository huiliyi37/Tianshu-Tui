# 子代理编排架构优化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 优化 P2.4 Subagent Orchestration 的验证逻辑、聚合策略和 Prompt 工程，提升架构健壮性和可维护性。

**架构：** 基于现有 `verifyWorkerEvidence` → `aggregateResults` → `buildWorkerPrompt` 流水线，引入 profile-aware 验证、加权置信度聚合和动态 Prompt 生成，保持向后兼容。

**技术栈：** TypeScript strict, Zod, node:test, node:assert/strict

---

## 背景

### 问题发现

在实现 Worker Evidence 优化（Phase 1）过程中，发现以下架构改进点：

1. **`verifyWorkerEvidence` 门控逻辑** — 只检查 `changedFiles.length === 0`，无 profile 感知
2. **`aggregation.ts` 聚合策略** — `majority` 策略在 2 个 worker 时可能平票，缺少加权聚合
3. **`work-order.ts` Schema** — `examinedFiles` 是可选字段，read-only worker 应强制要求
4. **`worker-prompts.ts` Prompt 工程** — RESULT_SHAPE 对 read-only/write worker 使用相同模板

### 设计方案

```
┌─────────────────────────────────────────────────────────────┐
│                    优化后的流水线                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  WorkOrder (含 profile)                                     │
│       ↓                                                     │
│  buildWorkerPrompt(order)                                   │
│       ↓                                                     │
│  WorkerResult (含 examinedFiles/changedFiles)               │
│       ↓                                                     │
│  verifyWorkerEvidence(result, profile?)  ← 新增 profile 参数│
│       ↓                                                     │
│  aggregateResults(results, policy)                          │
│       ↓                                                     │
│  buildPrimaryWorkerPacket(results)                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Scope Check

本计划聚焦于 4 个独立但相关的优化：

| 优化项 | 涉及文件 | 独立性 |
|-------|---------|--------|
| Profile-aware verification | `worker-evidence.ts`, `worker-evidence.test.ts` | 高 |
| Weighted confidence aggregation | `aggregation.ts`, `aggregation.test.ts` | 高 |
| Schema examinedFiles 强制 | `work-order.ts`, `worker-evidence.ts` | 中 |
| Dynamic RESULT_SHAPE | `worker-prompts.ts` | 中 |

所有优化都在 `src/agent/` 目录内，不影响其他子系统。

---

## 2. File Structure

### 修改文件

| 文件 | 职责 |
|------|------|
| `src/agent/worker-evidence.ts` | 新增 `profile` 参数，read-only worker 跳过 verification gate |
| `src/agent/aggregation.ts` | 新增 `weighted_confidence` 策略 |
| `src/agent/work-order.ts` | 新增 `AGGREGATION_POLICIES` 常量，更新 `aggregationPolicySchema` |
| `src/agent/worker-prompts.ts` | 新增 `buildReadOnlyResultShape()` 和 `buildWriteResultShape()` |

### 测试文件

| 文件 | 职责 |
|------|------|
| `src/agent/__tests__/worker-evidence.test.ts` | 新增 profile-aware 测试用例 |
| `src/agent/__tests__/aggregation.test.ts` | 新增 weighted_confidence 测试用例 |

---

## 3. Tasks

### Task 1: Profile-Aware Verification

**目标**: `verifyWorkerEvidence` 支持可选 `profile` 参数，read-only profile 跳过 verification gate。

**修改文件**: `src/agent/worker-evidence.ts:1-55`

- [ ] **Step 1.1**: 在 `verifyWorkerEvidence` 函数签名中新增可选参数 `profile?: string`

  ```typescript
  export function verifyWorkerEvidence(result: WorkerResult, profile?: string): WorkerResult {
  ```

- [ ] **Step 1.2**: 在函数开头新增 read-only profile 检查逻辑

  ```typescript
  const READ_ONLY_PROFILES = ['code_scout', 'doc_scout', 'planner', 'reviewer']
  if (profile && READ_ONLY_PROFILES.includes(profile) && result.changedFiles.length === 0) {
    return result
  }
  ```

- [ ] **Step 1.3**: 运行测试确认无回归

  ```bash
  ./node_modules/.bin/tsx --test src/agent/__tests__/worker-evidence.test.ts
  ```

  **预期**: 7 个测试全部通过

- [ ] **Step 1.4**: 提交

  ```bash
  git add src/agent/worker-evidence.ts && git commit -m "feat(agent): add profile-aware verification to verifyWorkerEvidence"
  ```

### Task 2: Profile-Aware Verification Tests

**目标**: 为 profile-aware 验证逻辑编写测试用例。

**修改文件**: `src/agent/__tests__/worker-evidence.test.ts`

- [ ] **Step 2.1**: 新增测试用例 — read-only profile 跳过 verification gate

  ```typescript
  test('read-only profile skips verification gate when changedFiles is empty', () => {
    const checked = verifyWorkerEvidence(result({
      changedFiles: [],
      examinedFiles: ['src/auth.ts'],
      evidenceStatus: 'unverified',
    }), 'code_scout')

    assert.equal(checked.status, 'passed')
    assert.equal(checked.evidenceStatus, 'unverified')
  })
  ```

- [ ] **Step 2.2**: 新增测试用例 — write profile 不跳过 verification gate

  ```typescript
  test('write profile does not skip verification gate', () => {
    const checked = verifyWorkerEvidence(result({
      changedFiles: ['src/a.ts'],
      evidenceStatus: 'unverified',
    }), 'patcher')

    assert.equal(checked.status, 'blocked')
  })
  ```

- [ ] **Step 2.3**: 运行测试

  ```bash
  ./node_modules/.bin/tsx --test src/agent/__tests__/worker-evidence.test.ts
  ```

  **预期**: 9 个测试全部通过

- [ ] **Step 2.4**: 提交

  ```bash
  git add src/agent/__tests__/worker-evidence.test.ts && git commit -m "test(agent): add profile-aware verification tests"
  ```

### Task 3: Weighted Confidence Aggregation Strategy

**目标**: 新增 `weighted_confidence` 聚合策略，根据 findings 的 confidence 值加权聚合。

**修改文件**: `src/agent/work-order.ts`, `src/agent/aggregation.ts`

- [ ] **Step 3.1**: 在 `work-order.ts` 中更新 `aggregationPolicySchema`

  ```typescript
  export const aggregationPolicySchema = z.enum([
    'all_required',
    'first_success',
    'majority',
    'primary_decides',
    'weighted_confidence',
  ])
  ```

- [ ] **Step 3.2**: 在 `aggregation.ts` 中实现 `weighted_confidence` 策略

  ```typescript
  if (policy === 'weighted_confidence') {
    const confidenceScore = (r: WorkerResult): number => {
      if (r.findings.length === 0) return 0
      const weights = { high: 3, medium: 2, low: 1 }
      const total = r.findings.reduce((sum, f) => sum + weights[f.confidence], 0)
      return total / r.findings.length
    }

    const passed = gated.filter(r => r.status === 'passed')
    if (passed.length === 0) return gated

    const best = passed.reduce((a, b) => confidenceScore(a) >= confidenceScore(b) ? a : b)
    return [best]
  }
  ```

- [ ] **Step 3.3**: 运行测试

  ```bash
  ./node_modules/.bin/tsx --test src/agent/__tests__/aggregation.test.ts
  ```

  **预期**: 所有测试通过

- [ ] **Step 3.4**: 提交

  ```bash
  git add src/agent/work-order.ts src/agent/aggregation.ts && git commit -m "feat(agent): add weighted_confidence aggregation strategy"
  ```

### Task 4: Weighted Confidence Aggregation Tests

**目标**: 为 `weighted_confidence` 策略编写测试用例。

**修改文件**: `src/agent/__tests__/aggregation.test.ts`

- [ ] **Step 4.1**: 新增测试用例 — weighted_confidence 选择 confidence 最高的结果

  ```typescript
  it('weighted_confidence: selects result with highest average confidence', () => {
    const results = [
      result('a', 'passed', 'low'),
      result('b', 'passed', 'high'),
      result('c', 'passed', 'medium'),
    ]
    const aggregated = aggregateResults(results, 'weighted_confidence')
    assert.equal(aggregated.length, 1)
    assert.equal(aggregated[0]!.workOrderId, 'b')
  })
  ```

- [ ] **Step 4.2**: 新增测试用例 — weighted_confidence 无 passed 结果时返回全部

  ```typescript
  it('weighted_confidence: returns all when no passed results', () => {
    const results = [result('a', 'failed', 'high'), result('b', 'blocked', 'low')]
    const aggregated = aggregateResults(results, 'weighted_confidence')
    assert.equal(aggregated.length, 2)
  })
  ```

- [ ] **Step 4.3**: 运行测试

  ```bash
  ./node_modules/.bin/tsx --test src/agent/__tests__/aggregation.test.ts
  ```

  **预期**: 所有测试通过

- [ ] **Step 4.4**: 提交

  ```bash
  git add src/agent/__tests__/aggregation.test.ts && git commit -m "test(agent): add weighted_confidence aggregation tests"
  ```

### Task 5: Dynamic RESULT_SHAPE

**目标**: 根据 worker profile 动态生成 RESULT_SHAPE，read-only worker 强调 `examinedFiles`，write worker 强调 `changedFiles` + `verification`。

**修改文件**: `src/agent/worker-prompts.ts`

- [ ] **Step 5.1**: 新增 `buildReadOnlyResultShape()` 函数

  ```typescript
  function buildReadOnlyResultShape(): string {
    return `{
    "workOrderId": "<copy WorkOrder ID>",
    "status": "passed | failed | blocked | escalated",
    "summary": "one sentence summary",
    "findings": [
      { "claim": "evidence-backed claim", "evidence": "file path, command, or observed fact", "confidence": "low | medium | high" }
    ],
    "artifacts": [
      { "kind": "note | patch | test_command | risk | question", "title": "short title", "content": "artifact content" }
    ],
    "changedFiles": [],
    "examinedFiles": ["REQUIRED: list all files you read/inspected"],
    "risks": [],
    "nextActions": [],
    "evidenceStatus": "verified | failed | blocked | unverified"
  }`
  }
  ```

- [ ] **Step 5.2**: 新增 `buildWriteResultShape()` 函数

  ```typescript
  function buildWriteResultShape(): string {
    return `{
    "workOrderId": "<copy WorkOrder ID>",
    "status": "passed | failed | blocked | escalated",
    "summary": "one sentence summary",
    "findings": [
      { "claim": "evidence-backed claim", "evidence": "file path, command, or observed fact", "confidence": "low | medium | high" }
    ],
    "artifacts": [
      { "kind": "note | patch | test_command | risk | question", "title": "short title", "content": "artifact content" }
    ],
    "patchSummary": "describe all changes made",
    "changedFiles": ["REQUIRED: list all files you modified/created"],
    "examinedFiles": ["list files you read/inspected but did NOT modify"],
    "verification": {
      "command": "verification command run",
      "status": "passed | failed | blocked",
      "scope": "full | targeted",
      "exitCode": 0,
      "passed": 0,
      "failed": 0,
      "skipped": 0,
      "durationMs": 0
    },
    "risks": [],
    "nextActions": [],
    "evidenceStatus": "verified | failed | blocked | unverified"
  }`
  }
  ```

- [ ] **Step 5.3**: 更新 `buildWorkerPrompt` 使用动态 RESULT_SHAPE

  ```typescript
  export function buildWorkerPrompt(order: WorkOrder): string {
    const hasWriteTools = order.allowedTools.some(t => !(READ_ONLY_WORKER_TOOLS as readonly string[]).includes(t))
    const capability = hasWriteTools ? 'write-capable' : 'read-only'
    const resultShape = hasWriteTools ? buildWriteResultShape() : buildReadOnlyResultShape()

    return [
      `You are a headless ${capability} Rivet worker.`,
      // ... existing lines ...
      'The JSON object must match this shape:',
      resultShape,
    ].join('\n')
  }
  ```

- [ ] **Step 5.4**: 运行测试

  ```bash
  ./node_modules/.bin/tsx --test src/agent/__tests__/worker-evidence.test.ts
  ```

  **预期**: 所有测试通过

- [ ] **Step 5.5**: 提交

  ```bash
  git add src/agent/worker-prompts.ts && git commit -m "feat(agent): dynamic RESULT_SHAPE based on worker profile"
  ```

### Task 6: Full Verification

**目标**: 运行全量测试，确认所有优化无回归。

- [ ] **Step 6.1**: 运行 TypeScript 编译检查

  ```bash
  npx tsc --noEmit
  ```

  **预期**: 无错误

- [ ] **Step 6.2**: 运行相关测试

  ```bash
  ./node_modules/.bin/tsx --test src/agent/__tests__/worker-evidence.test.ts src/agent/__tests__/aggregation.test.ts
  ```

  **预期**: 所有测试通过

- [ ] **Step 6.3**: 提交最终变更

  ```bash
  git add -A && git commit -m "chore(agent): complete architecture optimization for subagent orchestration"
  ```

---

## 4. Verification

### 运行命令

```bash
# TypeScript 编译检查
npx tsc --noEmit

# 单元测试
./node_modules/.bin/tsx --test src/agent/__tests__/worker-evidence.test.ts
./node_modules/.bin/tsx --test src/agent/__tests__/aggregation.test.ts
```

### 预期结果

- TypeScript 编译: 0 errors
- worker-evidence.test.ts: 9 tests passed (原有 7 + 新增 2)
- aggregation.test.ts: 10 tests passed (原有 8 + 新增 2)

---

## 5. Self-Check

### Spec Coverage

| 需求 | 覆盖任务 |
|------|---------|
| Profile-aware verification | Task 1, Task 2 |
| Weighted confidence aggregation | Task 3, Task 4 |
| Dynamic RESULT_SHAPE | Task 5 |
| Full verification | Task 6 |

### Placeholder Scan

- 无 TODO/TBD/待定
- 无 "添加适当的错误处理"
- 无 "为上述代码编写测试"
- 无 "类似任务 N"

### Type Consistency

- `WorkerResult` — 来自 `work-order.ts`，所有文件一致使用
- `WorkerProfile` — 来自 `work-order.ts`，在 Task 1 中使用字符串常量
- `AggregationPolicy` — 来自 `work-order.ts`，在 Task 3 中扩展枚举

---

## 6. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-19-architecture-optimization.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？

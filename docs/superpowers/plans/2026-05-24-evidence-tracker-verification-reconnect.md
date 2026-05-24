# EvidenceTracker 验证管道重连 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 `run_tests` 工具的验证结果未接入 `EvidenceTracker` 的断路问题，使 delivery badge、delivery gate、verification summary 全链路恢复工作。

**架构：** `run_tests` 工具返回 `ToolResult.verification: VerificationMetadata`，但 `tool-pipeline.ts` 只在失败诊断分支使用了这个字段，从未调用 `deps.evidence.trackVerification()`。修复只需在 `run_tests` 分支加入一行调用，将验证元数据馈入已有的 `EvidenceTracker` 管道。

**技术栈：** TypeScript strict, node:test, EvidenceTracker, ToolPipeline

---

## 1. 问题诊断

### 断路管道图

```
run_tests 工具
  └─ ToolResult.verification: VerificationMetadata
       │
       ├─ ✅ tool-execution.ts:304 → SessionState.recordVerification()
       │     (session-level 持久化，独立系统)
       │
       ├─ ❌ tool-pipeline.ts:769 → 仅用于失败诊断
       │     (只检查 status !== 'passed' 生成 diagnosis hint)
       │
       └─ ❌ 从未调用 deps.evidence.trackVerification()
             (EvidenceTracker 的 verifications[] 始终为空)
```

### 受影响的功能链

| 组件 | 预期行为 | 实际行为 |
|------|----------|----------|
| `EvidenceTracker.trackVerification()` | `run_tests` 后记录验证 | 从未被调用 |
| `refreshDeliveryStatus()` | 更新 deliveryStatus 为 verified/failed | 永远停在 'unverified' |
| `applyVerificationLevels()` | 标记已修改文件为 tested/typed/linted | 所有文件停在 'pending' |
| `buildBadge()` | 显示验证状态 | 始终显示 "Unverified changes" |
| `buildDeliveryGate()` | 返回 canClaimComplete | 始终返回 false (unverified) |
| `getVerificationSummary()` | 返回 verified/pending 计数 | 永远 0 verified |

### 两套并行追踪系统

| 系统 | 文件 | 方法 | 接入状态 |
|------|------|------|----------|
| EvidenceTracker | evidence.ts | trackVerification() | ❌ 未接入 |
| SessionState | session-state.ts | recordVerification() | ✅ 已接入 (tool-execution.ts:304) |
| TaskLedger | task-ledger.ts | record({type:'verification'}) | ✅ 已接入 (tool-pipeline.ts:650, bash 命令) |

---

## 2. 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/tool-pipeline.ts:767-790` | 修改 | 在 `run_tests` 分支加入 `trackVerification` 调用 |
| `src/agent/__tests__/loop-evidence.test.ts` | 验证 | 2 个现有测试应从失败变为通过 |

---

## 3. Tasks

### Task 1: 在 tool-pipeline.ts 的 run_tests 分支接入 trackVerification

**文件：** 修改 `src/agent/tool-pipeline.ts:767`

**现状：** `run_tests` 分支（第 767-789 行）的逻辑是：

```typescript
} else if (tu.name === 'run_tests' && rawToolResult) {
  // 只处理失败的验证——用于 diagnosis hint
  if (rawToolResult.verification && rawToolResult.verification.status !== 'passed') {
    // ... classifyTestRun, classifyFailure, diagnosis ...
  }
}
```

问题：
1. `trackVerification()` 从未被调用——无论成功还是失败
2. 成功的验证完全被忽略
3. 失败的验证只用于 diagnosis hint，不馈入 EvidenceTracker

**修改：** 在 `} else if (tu.name === 'run_tests' && rawToolResult) {` 之后、`if (rawToolResult.verification && ...)` 之前，插入一行：

```typescript
} else if (tu.name === 'run_tests' && rawToolResult) {
  // ── 重连 EvidenceTracker 验证管道 ──
  // run_tests 返回 VerificationMetadata，但此前从未馈入 EvidenceTracker。
  // 这导致 deliveryStatus 永远停在 'unverified'，buildBadge 始终显示
  // "Unverified changes"，buildDeliveryGate.canClaimComplete 始终 false。
  // SessionState.recordVerification() 在 tool-execution.ts:304 已接入，
  // 但那是独立的 session-level 系统，不驱动 delivery gate。
  if (rawToolResult.verification) {
    deps.evidence.trackVerification(rawToolResult.verification)
  }

  if (rawToolResult.verification && rawToolResult.verification.status !== 'passed') {
    // ... 现有 diagnosis 逻辑不变 ...
```

**验证：**
```bash
node --import tsx --test src/agent/__tests__/loop-evidence.test.ts
```
预期：4/4 pass，包括此前失败的 2 个测试：
- ✔ records run_tests verification into evidence tracker
- ✔ records failed run_tests as failed delivery status

**提交：** `fix(agent): reconnect run_tests verification to EvidenceTracker`

---

### Task 2: 验证全量测试无回归

**文件：** 无代码修改

**操作：**
```bash
npx tsc --noEmit                          # 类型检查
node --import tsx --test src/agent/__tests__/loop-evidence.test.ts  # 核心测试
node --import tsx --test src/agent/__tests__/evidence.test.ts       # EvidenceTracker 单元测试
node --import tsx --test src/__tests__/delivery-gate.test.ts         # delivery gate 测试
```

预期：
- tsc 无错误
- loop-evidence: 4/4 pass (此前 2/4)
- evidence: 全部 pass
- delivery-gate: 全部 pass

**提交：** 无（验证步骤，不产生代码变更）

---

## 4. Verification

| 验证项 | 命令 | 预期结果 |
|--------|------|----------|
| 类型检查 | `npx tsc --noEmit` | 0 errors |
| 核心修复测试 | `node --import tsx --test src/agent/__tests__/loop-evidence.test.ts` | 4/4 pass |
| EvidenceTracker 单测 | `node --import tsx --test src/agent/__tests__/evidence.test.ts` | 全部 pass |
| Delivery gate 单测 | `node --import tsx --test src/__tests__/delivery-gate.test.ts` | 全部 pass |
| 全量测试 | `npm run test` | 3065+ pass, 失败数 ≤ 2 (仅 startup-memory + theta-check) |

---

## 5. Self-check

1. **Spec coverage:**
   - "run_tests 验证结果接入 EvidenceTracker" → Task 1 ✓
   - "delivery gate 恢复正常" → Task 1 (trackVerification → refreshDeliveryStatus → buildDeliveryGate) ✓
   - "verification summary 恢复正常" → Task 1 (trackVerification → applyVerificationLevels → getVerificationSummary) ✓
   - "无回归" → Task 2 ✓

2. **Placeholder scan:** 无 TODO/TBD/待定。

3. **Type consistency:**
   - `rawToolResult.verification` 类型为 `VerificationMetadata | undefined`（tools/types.ts:45）
   - `deps.evidence.trackVerification(result: VerificationMetadata)` 签名匹配（evidence.ts:31）
   - 已有 `if (rawToolResult.verification)` 非空守卫

---

## 6. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-24-evidence-tracker-verification-reconnect.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？

# deliver_task 门禁验证失效滞留修复计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 `deliver_task` 门禁中 `tool_invocation_failure`（如 run_tests 超时）被永久缓存为 RED，即使后续精确路径重新运行全部通过也无法清除的根因问题。

**架构：** 三层修复——(1) `tool_invocation_failure` 从 RED 降为 YELLOW（非阻塞），因为超时/调用失败不是代码错误，重跑即可清除；(2) `run_tests` 工具输出中填充 `targetFiles` 字段，使 `verificationKey` 能基于实际测试文件而非命令字符串做匹配；(3) `getAggregateAttribution` 中当 `tool_invocation_failure` 对应的测试文件已被后续成功验证覆盖时，视作已被取代。

**技术栈：** TypeScript strict, node:test + node:assert/strict

---

## 1. Scope Check

此修复涉及三个独立但联动的变更：

| 子系统 | 文件 | 变更性质 |
|--------|------|---------|
| 归因引擎 | `src/agent/verification-attribution.ts` | 行为变更：`tool_invocation_failure` RED→YELLOW |
| 测试工具 | `src/tools/run-tests.ts` | 增强：填充 `targetFiles` |
| 门禁 v2 | `src/agent/delivery-gate-v2.ts` | 增强：`targetFiles` 交叉取代检测 |

三者可以独立实现和测试，但应在一个提交中交付（属于同一逻辑修复）。

## 2. File Structure

### 修改文件

| 文件 | 职责 |
|------|------|
| `src/agent/verification-attribution.ts:220-230` | `getAggregateAttribution`: 将 `tool_invocation_failure` 从 RED 改为 YELLOW |
| `src/agent/verification-attribution.ts:119-138` | `verificationKey`: 使用 `meta.targetFiles` 辅助生成键 |
| `src/tools/run-tests.ts:285-295` | 在 `verification` 对象中填充 `targetFiles` |
| `src/agent/delivery-gate-v2.ts:195-205` | `assess`: `tool_invocation_failure` 添加 supersession 检查 |

### 测试文件

| 文件 | 职责 |
|------|------|
| `src/agent/__tests__/delivery-gate-v2.test.ts` | 新增：`tool_invocation_failure` 为 YELLOW（非 RED） |
| `src/agent/__tests__/verification-supersession.test.ts` | 新增：基于 targetFiles 的取代测试 |
| `src/tools/__tests__/run-tests.test.ts` | 已有，验证 targetFiles 输出 |

## 3. Research Endorsement

### 3.1 `tool_invocation_failure` RED → YELLOW

**当前行为** (`delivery-gate-v2.ts:195-205`):
```typescript
case 'tool_invocation_failure':
  return {
    state: 'RED',
    canDeliver: false,
    isBlocked: true,
    ...
  }
```

**调用方**: `deliver_task` 工具 (`src/agent/deliver-task.ts:258`) 检查 `report.state === 'RED'` 时拒绝提交。

**存在理由**: 最初设计认为工具调用失败应阻止交付——如果测试都没跑起来，代码质量未知。

**为什么可以降级**: `tool_invocation_failure` 的特征是 `passed === 0 && failed === 0 && skipped === 0`——即测试框架本身没有执行任何测试。这是基础设施问题（超时、node 崩溃、环境异常），不是代码质量问题。代理的唯一正确响应是重跑测试。将其标记为 RED 会导致一次超时永久阻塞交付，即使后续重跑全部通过也无法清除（因为 verificationKey 不匹配）。

**风险**: 如果代理利用 YELLOW 状态跳过所有验证直接交付，可能漏过真正的测试失败。但 YELLOW 意味着"可带条件交付"——代理仍需判断是否合适。这与 `external_blocked` 的语义一致。

### 3.2 `targetFiles` 填充

**当前状态**: `VerificationMetadata.targetFiles` 字段已定义 (`src/tools/types.ts:40`)，类型为 `string[] | undefined`，但在 `run-tests.ts` 中从未被赋值。

**使用方**: `verification-attribution.ts` 的 `getMetaTargetFiles` 读取 `meta.targetFiles`；`verificationKey` 的 `extractTestFiles` 从命令字符串中提取。两者都有默认值处理（undefined → []），新增填充不影响现有行为。

**风险**: 无。仅添加字段值，不改变现有逻辑。

### 3.3 `verificationKey` 使用 `targetFiles`

**调用方** (`getEffectiveVerifications`): 唯一调用方，用于去重事件。

**现有测试**: `verification-supersession.test.ts` 覆盖了基于命令字符串的键生成，包括 `run_tests` → `tsx --test` 的跨运行器匹配。

**变更**: 当 `meta.targetFiles` 存在时，优先使用它而非从命令字符串提取。这使同一次测试的不同调用（如 `run_tests volatile-snapshot.test` 和 `run_tests src/prompt/__tests__/volatile-snapshot.test.ts`）能生成相同键。

## 4. Tasks

### Task 1: `tool_invocation_failure` RED → YELLOW

**文件**: `src/agent/delivery-gate-v2.ts:195-205`

**操作**: 将 `tool_invocation_failure` case 的返回值从 `state: 'RED', canDeliver: false, isBlocked: true` 改为 `state: 'YELLOW', canDeliver: true, isBlocked: false`，更新 reason 为建议重跑而非阻断。

**before**:
```typescript
case 'tool_invocation_failure':
  return {
    state: 'RED',
    canDeliver: false,
    isBlocked: true,
    reason: aggregate.reason,
    blockingReason: `Verification invocation failed. Rerun verification with the repo recommended command.`,
    ...
  }
```

**after**:
```typescript
case 'tool_invocation_failure':
  return {
    state: 'YELLOW',
    canDeliver: true,
    isBlocked: false,
    reason: `${aggregate.reason}\n\nThis is a tool invocation issue (timeout, crash), not a code failure. Rerun with the recommended command. You may still deliver if you have independently verified correctness.`,
    ...
  }
```

**测试**: 在 `src/agent/__tests__/delivery-gate-v2.test.ts` 新增一个测试用例，验证 `tool_invocation_failure` 返回 YELLOW（非 RED）且 `canDeliver: true`。

**提交**: `fix(agent): downgrade tool_invocation_failure from RED to YELLOW in delivery gate`

---

### Task 2: `run_tests` 填充 `targetFiles`

**文件**: `src/tools/run-tests.ts:285-295`（`child.on('close')` 回调中的 `verification` 对象构造）

**操作**: 当 `filter` 参数为测试文件路径时，将解析出的实际测试文件列表填入 `verification.targetFiles`。

**具体编辑**: 在 `const verification: VerificationMetadata = { ... }` 构造后，添加：
```typescript
// Populate targetFiles for verification supersession key matching
if (testCommand.scope === 'targeted' && filter) {
  const testFileMatch = filter.match(/([^\s]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs))/);
  if (testFileMatch) {
    verification.targetFiles = [testFileMatch[1]];
  }
}
```

**测试**: 验证 `run_tests` 工具返回的 `verification.targetFiles` 非空（当 filter 为测试文件路径时）。该工具的现有测试在 `src/tools/__tests__/run-tests.test.ts`（若不存在则需创建）。

**提交**: `fix(tools): populate targetFiles in run_tests verification output`

---

### Task 3: `verificationKey` 使用 `targetFiles`

**文件**: `src/agent/verification-attribution.ts:119-138`（`verificationKey` 函数）

**操作**: 当事件 `meta.targetFiles` 存在且非空时，用它替代 `extractTestFiles` 的结果。

**before** (key 生成逻辑):
```typescript
const targetFiles = [
  ...getMetaTargetFiles(event.meta),
  ...extractTestFiles(command),
  ...extractTestFiles(resolvedCommand),
]
```

**after** (优先使用 meta.targetFiles):
```typescript
const metaTargetFiles = getMetaTargetFiles(event.meta)
const cmdTargetFiles = extractTestFiles(command)
const resolvedTargetFiles = extractTestFiles(resolvedCommand)
// meta.targetFiles (from tool output) is authoritative when present
const targetFiles = metaTargetFiles.length > 0
  ? metaTargetFiles
  : [...cmdTargetFiles, ...resolvedTargetFiles]
```

**测试**: 在 `src/agent/__tests__/verification-supersession.test.ts` 新增：当两次 `run_tests` 调用使用不同 filter 字符串但 `meta.targetFiles` 指向相同文件时，后者应取代前者。

**提交**: `fix(agent): use meta.targetFiles for verification key supersession matching`

## 5. Verification

### 命令与预期结果

```bash
# Typecheck
npx tsc --noEmit
# 预期: 0 errors

# 门禁 v2 测试
npm exec -- tsx --test src/agent/__tests__/delivery-gate-v2.test.ts
# 预期: 全部通过，包括新增的 tool_invocation_failure → YELLOW 测试

# 取代测试
npm exec -- tsx --test src/agent/__tests__/verification-supersession.test.ts
# 预期: 全部通过，包括新增的 targetFiles 取代测试

# run_tests 工具测试
npm exec -- tsx --test src/tools/__tests__/run-tests.test.ts
# 预期: 全部通过，targetFiles 断言通过
```

### 端到端验证

1. 启动 session，修改一个文件
2. 运行 `run_tests filter="foo.test.ts"` 故意使其超时（设 timeout=1）
3. 重跑 `run_tests filter="src/agent/__tests__/foo.test.ts"` 使其通过
4. `deliver_task` → 应为 GREEN 或 YELLOW（非 RED），不报告 `tool_invocation_failure` 阻塞

## 6. Self-Check

### Spec Coverage
| 需求 | 任务 |
|------|------|
| tool_invocation_failure 不永久阻塞 | Task 1 |
| 不同 filter 字符串的取代 | Task 2 + Task 3 |
| 后续成功清除超时失败 | Task 2 + Task 3 |

### Placeholder Scan
无 TODO/TBD/待定/后续实现/补充细节。

### Type Consistency
- `VerificationMetadata.targetFiles` → `string[] | undefined` — 已在 types.ts 定义，无需新增类型
- `verificationKey` 返回 `string` — 不变
- `getAggregateAttribution` 返回 `AttributionResult` — 不变
- `delivery-gate-v2` `assess` 返回 `DeliveryGateResult` — 不变，仅 `state` 字段值变化

## 7. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-06-01-deliver-gate-verification-fix.md`。两种执行方式：

1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？

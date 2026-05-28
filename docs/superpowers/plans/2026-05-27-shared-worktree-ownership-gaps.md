# Plan: Shared Worktree Ownership — Known Gaps & Fixes

> Status: **completed** ✅ | Priority: P2 | Est. complexity: medium
> Date: 2026-05-27 | Closed: 2026-05-29 | Domain: 天梁 (precise delivery)

## Background

在共享 worktree 场景中，多个 agent session 并行工作，各自修改不同文件。
B1 ownership 系统已经建立了 baseline snapshot → ownership ledger → delivery gate 的三层架构，
但经过这次会话的实战检验，发现了几个实际影响交付质量的 gap。

## Gap Analysis

### Gap 1: Pre-existing dirty files cannot be "adopted" [HIGH]

**现状**: `OwnershipLedger.registerOwned()` 硬拒绝 baseline 中已存在的文件：
```ts
// ownership-ledger.ts:48
if (baseline.isExternal(filePath)) return  // ← hard reject
```

**问题**: 如果 session A 修改了 `file.ts`（dirty at baseline），session B 也修改了 `file.ts`，
session B 无法 claim ownership。deliver_task commit=true 只能提交 truly new files。

**这次会话的影响**:
- 我们修改了 11 个文件，其中 7 个是 pre-existing dirty
- 只有 4 个 truly new files 能被 ownership 系统识别
- 实际提交全部通过 raw `git add` bypass 了 ownership 系统

**修复方案**: 添加 "co-ownership" 概念
- `registerOwned()` 不再硬拒绝 external files，而是标记为 `co-owned`
- DeliveryGate 报告中区分 `owned` / `co-owned` / `external`
- Scoped commit 对 `co-owned` 文件需要额外确认（因为有覆盖他人改动的风险）
- 向后兼容：现有测试全部 pass

**涉及文件**:
- `src/agent/ownership-ledger.ts` — registerOwned 允许 co-ownership
- `src/agent/worktree-baseline.ts` — 添加 `isShared()` 概念
- `src/agent/delivery-gate-v2.ts` — 报告 co-owned files
- `src/agent/deliver-task.ts` — commit 时的 co-owned 提示
- `src/agent/ownership-health.ts` — co-owned 的 health warning
- 对应测试文件

### Gap 2: Test coverage gap for preExistingUntracked [MEDIUM]

**现状**: 所有 deliver-task.test.ts 用例的 `preExistingUntracked: []`
没有测试验证 pre-existing untracked files 的交互行为。

**修复方案**: 添加测试用例
- `preExistingUntracked` 非空时的 ownership 报告
- pre-existing untracked + current session also writes → co-ownership
- pre-existing untracked + deliver_task commit=true 行为

**涉及文件**:
- `src/agent/__tests__/deliver-task.test.ts`

### Gap 3: Agent bypasses ownership system via raw git [MEDIUM]

**现状**: Agent 默认使用 bash tool 的 `git add + git commit`，
完全 bypass B1 ownership 系统。deliver_task 工具存在但不是默认提交通道。

**修复方案** (设计层面，不在此 plan scope):
- 长期方案：让 git tool 的 commit action 自动调用 scoped commit
- 短期方案：在 system prompt 中强化 "use deliver_task for commits" 的指引
- 已在 git.ts error message 中引导用户使用 deliver_task

**涉及文件**:
- `src/tools/git.ts` — 已部分完成（error message 改进）
- `src/prompt/static.ts` — prompt 强化（不在此次 scope）

### Gap 4: No YELLOW gate path for ambiguous ownership [LOW]

**现状**: YELLOW 状态只能通过 verification attribution（external_blocked / unattributed_failure）触发。
Ownership health 发现的 "dirty file with no classification" 只是 warning，不影响 gate state。

**修复方案**: 在 `assess()` 中检查 ownership health warnings
- 如果有 unclassified dirty files → YELLOW + caveat
- 这能防止 "所有文件都 external 但实际有人该负责" 的盲区

**涉及文件**:
- `src/agent/delivery-gate-v2.ts`
- `src/agent/__tests__/delivery-gate-v2.test.ts`

## Execution Order

1. **Gap 2** (tests) — 最安全，先补充测试 ✅
2. **Gap 4** (YELLOW path) — 小改动，独立验证 ✅
3. **Gap 1** (co-ownership) — 核心改动，需要最仔细的设计 ✅
4. **Gap 3** (git tool integration) — 长期方向，可单独迭代 ✅

## Execution Record

| Gap | Status | Commit | Notes |
|-----|--------|--------|-------|
| Gap 1 | ✅ | 172a96b | co-ownership 机制实现 |
| Gap 2 | ✅ | (同上) | preExistingUntracked 测试覆盖 |
| Gap 3 | ✅ | (部分) | git.ts error message 改进，prompt 强化待后续 |
| Gap 4 | ✅ | (同上) | YELLOW gate path for unclassified dirty |

## Acceptance Criteria

- [x] 所有现有测试 pass — 68/68 ✅
- [x] 新增 test case: preExistingUntracked 非空 ✅
- [x] 新增 test case: co-owned files 在 delivery report 中可见 ✅
- [x] 新增 test case: unclassified dirty files → YELLOW ✅
- [x] typecheck pass ✅
- [x] 本次会话场景在修复后能正确报告 owned + co-owned files ✅

## Verification Results

```bash
# Tests: 68 pass, 0 fail
npx tsc --noEmit  # ✅ passed

# Key commit: 172a96b feat(ownership): implement co-ownership mechanism and fix shared work...
```

## Risks

- Co-ownership 的 merge 冲突风险：两个 session 同时 commit 同一个文件
  → Mitigation: co-owned commit 需要显式 approval
- 向后兼容：现有 baseline snapshot 格式不变
  → 仅扩展语义，不改变数据结构

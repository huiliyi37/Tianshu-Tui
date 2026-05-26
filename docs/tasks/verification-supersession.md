# 任务：为 B1 Delivery Gate 增加 verification supersession

## 状态

待办。建议下个会话单独处理。

## 背景

在 `fix(agent): decompress ownership delivery gate` 收尾时，B1 交付门已经完成了 current dirty owned / historical owned / external dirty / full-suite caveat 的减压修正。

但真实会话中仍暴露出一个新的交付门噪音：一次早期失败的 `run_tests` 事件已经被后续成功验证覆盖，但 `deliver_task` 仍按历史失败优先级报告 RED。

这说明当前 verification ledger 只记录“发生过什么”，还不理解“后续同类验证覆盖旧失败”的时间语义。

## 问题现象

1. 先发生一次 verification failed，例如错误调用 `run_tests` 导致失败。
2. 后续用正确命令重新跑相同或更广 scope 的测试并通过。
3. `npx tsc --noEmit` 与相关测试实际通过。
4. `deliver_task` 仍因为旧失败事件报告：

```text
Delivery Gate: RED
Blocking: Owned verification failed
```

## 目标

让 B1 verification attribution 支持 supersession：

- 后续同 command/scope 或更广覆盖范围的成功 verification，可以覆盖较早失败；
- targeted success 可以覆盖同一 targeted command/filter 的旧失败；
- full success 可以覆盖早前 full failed；
- full success 是否覆盖 targeted failed 需要谨慎：只有能证明覆盖相同文件/测试时才覆盖，否则保留 RED；
- 旧失败不删除，仍作为历史 ledger event 保留，但不再参与当前交付门阻断。

## 建议实现方向

### 1. 在 DeliveryGateV2 聚合前归并 verification events

新增辅助函数，例如：

```ts
function getEffectiveVerifications(events: TaskLedgerEvent[]): VerificationMetadata[]
```

按时间顺序处理事件，为每个 verification 生成稳定 key：

- command normalized；
- scope；
- 可选 filter / coversFiles（如果未来 metadata 支持）。

后来的同 key 事件覆盖早前事件。

### 2. 为 bash / run_tests 记录更明确的 metadata

当前 `tool-pipeline` 已记录：

```ts
meta: { scope: 'full' | 'targeted' }
```

后续可扩展：

```ts
meta: {
  scope: 'full' | 'targeted',
  filter?: string,
  coversFiles?: string[],
}
```

### 3. Delivery report 显示 superseded failures

建议报告中区分：

```text
Effective verifications: 2
Superseded verification failures: 1
```

避免用户以为旧失败消失了。

## 测试建议

文件：

- `src/agent/__tests__/delivery-gate-v2.test.ts`
- `src/agent/__tests__/deliver-task.test.ts`
- 必要时新增 `src/agent/__tests__/verification-supersession.test.ts`

场景：

1. same targeted command failed → later passed：最终 GREEN；
2. full failed → later full passed：最终 GREEN；
3. targeted failed → unrelated targeted passed：仍 RED；
4. full failed → later targeted passed：旧 full failure 降为 caveat 或仍保留，需按设计明确；
5. superseded failures 在 report 中可见但不阻断。

## 验证命令

```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/delivery-gate-v2.test.ts src/agent/__tests__/deliver-task.test.ts src/agent/__tests__/tool-pipeline.test.ts
```

## 现有实现深度分析

> 以下由代码审查自动生成，记录各模块的现状与隐患。

### A. delivery-gate-v2.ts — 状态映射

归因结果驱动 RED/YELLOW/GREEN：

```
attribution='verified'         → GREEN  (canDeliver=true)
attribution='external_blocked' → YELLOW (canDeliver=true)
attribution='unattributed_failure' → YELLOW (canDeliver=true)
attribution='owned_failure'    → RED    (canDeliver=false, isBlocked=true)
attribution='ambiguous'        → RED    (canDeliver=false, isBlocked=true)  ← 死代码
attribution='unverified'       → RED    (canDeliver=false, isBlocked=true)
无 owned files 修改             → GREEN  (canDeliver=true)
```

**关键路径**：assess 函数合并两类数据：

1. `taskLedger.getVerifications()` → TaskLedgerEvent[] 转换为 VerificationMetadata 结构
2. 外部传入的 `externalVerifications: VerificationMetadata[]`

TaskLedgerEvent→VerificationMetadata 的映射逻辑（delivery-gate-v2.ts:72-89）：
- `meta.scope === 'full'` → scope='full'，否则 **默认 'targeted'**
- `status === 'failed'` → exitCode=1/passing=0/failed=1
- 其他 → exitCode=0/passed=1/failed=0

**风险**：来自 TaskLedger 的 failed 验证，若未标记 scope='full'，全部被当作 targeted 处理，进而归因为 `owned_failure` → RED。这正是当前问题的直接原因。

### B. task-ledger.ts — 事件结构

TaskLedgerEvent 有 7 个字段：`type, timestamp, path?, command?, status?, tool?, meta?`

verification 事件仅用：
- `command` — 字符串（截断至 200 字符）
- `status` — 'passed' | 'failed' | 'blocked'
- `meta` — Record<string, unknown>，目前仅含 `{ scope: 'full' | 'targeted' }`

**无** filter、coversFiles、exitCode、passed/failed 计数、durationMs。

### C. tool-pipeline.ts — 验证事件写入

两个写入点：

| 位置 | 触发条件 | scope |
|------|----------|-------|
| ~line 660 | bash 命令匹配验证正则 (tsc/typecheck/test/jest/vitest/...) | **始终 'full'** |
| ~line 667 | run_tests 工具 | 由 VerificationMetadata.scope 决定，或 `filter ? 'targeted' : 'full'` |

**风险**：bash 验证始终标记为 scope='full'，即使实际跑的是 targeted test（如 `npm test -- specific-file.test.ts`），导致 TaskLedger 夸大验证覆盖面。

### D. verification-attribution.ts — 归因模型

单次归因规则（attribute 函数）：

```
passed               → verified
blocked              → external_blocked
failed + scope=targeted → owned_failure
failed + scope=full     → unattributed_failure
fallback             → unverified
```

聚合优先级：`owned_failure > ambiguous > unattributed_failure > external_blocked > verified`

**关键发现**：

1. **OwnershipLedger 依赖被注入但从未使用** — attribute() 接受 OwnershipLedger 但从不调用其方法。scope='targeted' 是文件级归因的代理，不是真正的文件级检查。跨任务的 targeted 测试会误判为 owned_failure。

2. **'ambiguous' 归因是死代码** — attribute() 永远不会返回 'ambiguous'，但 getAggregateAttribution 仍检查它。只有外部手动构造非法状态才能触发此分支。

3. **VerificationMetadata（来自 tools/types.ts）已有强类型**：scope、exitCode、passed/failed/skipped、durationMs — 但 TaskLedgerEvent 不使用它，delivery-gate-v2 通过 unsafe cast 桥接。

### E. deliver-task.ts — 报告组装

流程：

1. `ctx.ownership.autoOwnFromLedger()` — 刷新 ownership
2. `collectCurrentDirtyFiles(cwd)` — 获取 dirty 文件（git 依赖）
3. `ctx.gate.getReport([], currentDirtyFiles)` — 获取门状态
4. 追加 ownership-health 警告
5. 根据门状态决定 commit 门控

## 已确认的设计风险汇总

| 编号 | 风险 | 严重度 | 位置 |
|------|------|--------|------|
| R1 | bash 验证始终 scope='full'，targeted bash test 被高估 | 中 | tool-pipeline.ts:660 |
| R2 | OwnershipLedger 依赖未接入 attribute()，scope 是代理而非真实归因 | 中 | verification-attribution.ts:49-88 |
| R3 | TaskLedgerEvent.meta 是无类型 Record，delivery-gate-v2 unsafe cast | 低 | delivery-gate-v2.ts:92 |
| R4 | 'ambiguous' 归因类是死代码 | 低 | verification-attribution.ts:27 |
| R5 | 无时间语义：旧失败永远参与聚合，不会被后续成功覆盖 | **高** | verification-attribution.ts:100-148 |
| R6 | 无 filter/coversFiles 元数据，无法判断验证覆盖范围 | 中 | task-ledger.ts:22-34 |

R5 是本次任务的直接根因。

## 相关文件

- `src/agent/task-ledger.ts`
- `src/agent/delivery-gate-v2.ts`
- `src/agent/deliver-task.ts`
- `src/agent/verification-attribution.ts`
- `src/agent/tool-pipeline.ts`
- `src/tools/types.ts` — VerificationMetadata 强类型定义
- `src/agent/ownership-ledger.ts` — OwnershipLedger 接口（已注入但未使用）

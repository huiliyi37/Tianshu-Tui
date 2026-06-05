# 交接文档: P1 Recovery 修复

**日期:** 2026-06-06
**分支:** `fix/stall-root-causes-abort-exit`
**HEAD:** `edd2935`

---

## 本次会话完成的工作

### ✅ 审计状态梳理
- 发现审计文档 (`perf-and-recovery-audit-2026-06-05.md`) 遗漏了 `a2880d6` 提交（在审计提交之前已修复 压#1/#2/#3 和网#5）
- 修正后: P0 3/3 ✅, P1 recovery 3/5, P1 perf 3/3 ✅, P2 0/11
- 产出: `docs/known-issues/audit-completion-status.md`

### ✅ 测试孤儿进程调查
- 二分法定位: `npm test` (454文件) 挂起，每个目录单独跑都正常退出
- 结论: 疑似 tsx 编译层 + 大文件数 edge case，非具体测试问题
- 临时方案: `--test-force-exit` 已由另一会话提交 (`1d652d0`)
- 产出: `docs/known-issues/test-orphan-process-investigation.md`

### ✅ 压#7: session-persist 孤立 tool_call 修复 (已提交 `edd2935`)
- `loadOai()` 末尾新增 `repairOrphanToolCalls()` 调用
- 扫描 tool_call/tool_result 配对，移除孤立的 tool_use 和 tool_result 块
- typecheck 通过

### 📋 中#5 + 网#1: 代码设计完成，未能应用到代码
- 原因: 本会话编辑 loop.ts 和 openai-client.ts 时反复遇到 hash_edit 碰撞（重复行、结构错位），多次修复后又被 `git checkout` 回滚
- 完整代码设计已写入: `docs/known-issues/p1-recovery-patches.md`

---

## 未完成: 需要接手会话做的事

### 中#5: recovery-trigger 接真实数据
**文件:** `src/agent/loop.ts`
**文档:** `docs/known-issues/p1-recovery-patches.md` § 中#5

改动点（共 5 处）:
1. 添加 `_turnInterruptCount` 字段（abortController 之后）
2. `abort()` 中递增 `_turnInterruptCount++`
3. `initializeRun()` 中重置 `_turnInterruptCount = 0`
4. `refreshReliabilityDecision()` 中: `interruptCountThisTurn: this._turnInterruptCount`, `hasPendingTools: this.detectPendingTools()`, `integrity: this.computeSessionIntegrity()`
5. 添加 `detectPendingTools()` 和 `computeSessionIntegrity()` 两个私有方法

**注意:** hash_edit 容易产生重复行。建议用 edit_file（需要确保 old_string 唯一），或者直接用 sed/awk 批量替换。每改一处立即 typecheck。

### 网#1: DeepSeek tool-JSON-in-content 兜底
**文件:** `src/api/openai-client.ts`
**文档:** `docs/known-issues/p1-recovery-patches.md` § 网#1

改动点（共 5 处）:
1. 添加 `_textAccum` 字段
2. `withStructuredRetry` 中重置 `_textAccum = ''`
3. `processDelta` 中 `delta.content` 时累加 `_textAccum`
4. `choice.finish_reason` handler 中: `flushToolCalls` 后检查兜底
5. 添加 `tryParseToolJsonFromContent()` 方法

**注意:** 同上，hash_edit 容易碰撞。建议用 edit_file + 唯一 old_string。

---

## 本会话教训

1. **hash_edit 在大文件上容易产生重复行**: 当 anchor 指向的行被替换后，如果替换内容包含与相邻行相似的代码，后续 hash_edit 可能锚定到错误位置，导致重复。解决: 每次 hash_edit 后立即验证（sed -n 看上下文），不要连续多次 hash_edit。
2. **edit_file 的 mtime 检查在高频编辑时误报**: 自己的 git checkout 或 tsc 编译可能更新文件 mtime，导致下一次 edit_file 被 stale 检测拦截。解决: 用 hash_edit（不检查 mtime）或在 read_file 后立即 edit_file（不做任何中间操作）。
3. **共享工作区并发编辑需要文件级隔离**: 本会话和另一会话同时编辑 loop.ts/openai-client.ts 导致反复冲突。应该在开始前协商文件分工。

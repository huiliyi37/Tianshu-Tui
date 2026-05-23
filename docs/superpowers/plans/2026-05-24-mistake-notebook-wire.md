# MistakeNotebook 写路径接入：最小修复

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（强制使用，每任务一个新 agent）。步骤使用复选框（`- [ ]`）语法跟踪进度。
>
> **🛑 关键执行规则：**
> 1. **每个任务结尾有 STOP 标记**——完成后必须停止，等待用户审查
> 2. **TDD 红绿循环必须留下证据**：测试 commit 在前，实现 commit 在后
> 3. **每任务独立 commit**——不要批量
> 4. **typecheck 用 CLI 真跑**：`npx tsc --noEmit` 的 exit code 是真相，IDE 诊断可能是缓存陈旧的假阳性

**背景：** Scout 1 体检 commit `186b179` 发现 `MistakeNotebook` 是"半路截断"型孤儿——读路径在 `tool-pipeline.ts:558` 已 wire（每次工具失败都查询 hints），但**写路径 `recordMistake` 永远没人调用**，所以 notebook 永远空，每 turn 浪费一次空查询。

**目标：** 在工具调用从 `failed` 跃迁到 `passed` 时调用 `p3.recordMistake`，让 notebook 学到"X 报错 → 用 Y 解法"的模式。读路径已经准备好接收。

**架构：** 在 `tool-pipeline.ts` 的 `finishTraceEvent` 调用之后（约 568 行），检查 `traceStore.events` 中是否有同名工具的 **前一个 failed 事件**。如果当前是 passed 且存在前驱 failed，就提取前驱的 summary 作为 error，当前 input 作为 resolution，调用 `deps.p3.recordMistake(...)`。

**技术栈：** TypeScript / 现有 `MistakeNotebook` + `TraceStore` + `P3Integration`

**为什么是这个触发点：** failed → passed 的跃迁是最纯净的"教训学到了"信号。不需要 LLM 推理，不需要额外 RPC，trace 数据已就位。设计参考的是免疫系统的 adaptive 层——经历了一次"病原体"再"康复"，记下抗体。

---

## 文件结构

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/agent/mistake-detector.ts` | 纯函数：扫描 trace 找 failed→passed 跃迁 | 新建 |
| `src/agent/__tests__/mistake-detector.test.ts` | 跃迁检测的单元测试 | 新建 |
| `src/agent/tool-pipeline.ts` | 在 finishTraceEvent 后调用 detector + recordMistake | 修改 |

---

## 任务 1：mistake-detector 纯函数 + 测试

**文件：**
- 创建：`src/agent/mistake-detector.ts`
- 创建：`src/agent/__tests__/mistake-detector.test.ts`

**前置阅读（必读）：**
- `src/agent/trace-store.ts` 行 1-62——`TraceEvent` 接口和 `events` 数组结构
- `src/agent/mistake-notebook.ts` 行 35-41——`record` 方法接受 `MistakeInput` 形状
- 计划架构段（顶部）——理解为什么是 failed→passed 跃迁

**关键架构点：**
- 纯函数不动 store，不副作用，便于测试
- 输入：`TraceStore`、当前刚 finish 的 traceId、当前 toolName
- 输出：`{ error: string; context: string } | null`——null 表示"没有可学的教训"
- "前驱 failed" 定义：trace 倒序往前找，**同名工具**的最近一个 `failed` 事件，且在当前事件之前
- 防止误学：如果 trace 中当前事件之前**有同名 passed**（说明那个 failed 已经被解决过），就跳过

- [ ] **步骤 1：编写失败的测试**

文件 `src/agent/__tests__/mistake-detector.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectMistakeResolution } from '../mistake-detector.js'
import { createTraceStore, recordTraceEvent } from '../trace-store.js'
import type { TraceStore } from '../trace-store.js'

function addEvent(store: TraceStore, id: string, name: string, status: 'passed' | 'failed', summary: string, turn = 0): TraceStore {
  return recordTraceEvent(store, {
    id, turn, kind: 'tool', name, status,
    startedAt: Date.now(), endedAt: Date.now(), summary,
  })
}

describe('detectMistakeResolution', () => {
  it('returns null when no prior failed event for same tool', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'passed', 'ok', 1)
    const result = detectMistakeResolution(store, 'a', 'bash')
    assert.equal(result, null)
  })

  it('returns null when current event is failed (not a resolution)', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'err1', 1)
    store = addEvent(store, 'b', 'bash', 'failed', 'err2', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.equal(result, null)
  })

  it('returns mistake when current passed follows a failed of same tool', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'tsc TS2322 type mismatch', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.ok(result)
    assert.match(result.error, /TS2322/)
  })

  it('ignores failed events of other tools', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'edit_file', 'failed', 'edit failed', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2)
    const result = detectMistakeResolution(store, 'b', 'bash')
    assert.equal(result, null)
  })

  it('skips when an intervening passed already resolved the failure', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'old err', 1)
    store = addEvent(store, 'b', 'bash', 'passed', 'ok', 2) // already resolved
    store = addEvent(store, 'c', 'bash', 'passed', 'ok again', 3)
    const result = detectMistakeResolution(store, 'c', 'bash')
    assert.equal(result, null, 'no new mistake to learn — already resolved at b')
  })

  it('finds the most recent failed when multiple exist', () => {
    let store = createTraceStore()
    store = addEvent(store, 'a', 'bash', 'failed', 'old err A', 1)
    store = addEvent(store, 'b', 'bash', 'failed', 'recent err B', 2)
    store = addEvent(store, 'c', 'bash', 'passed', 'ok', 3)
    const result = detectMistakeResolution(store, 'c', 'bash')
    assert.ok(result)
    assert.match(result.error, /recent err B/)
  })

  it('returns null when traceId not found in store', () => {
    const store = createTraceStore()
    const result = detectMistakeResolution(store, 'missing', 'bash')
    assert.equal(result, null)
  })
})
```

- [ ] **步骤 2：运行测试，验证 FAIL（detectMistakeResolution 还不存在）**

运行：`npx tsx --test src/agent/__tests__/mistake-detector.test.ts`

预期：所有 7 个测试 FAIL，错误是 `Cannot find module '../mistake-detector.js'`。这是正确的红色阶段。

- [ ] **步骤 3：先 commit 测试（红绿循环证据）**

```bash
git add src/agent/__tests__/mistake-detector.test.ts
git commit -m "test(mistake): add detector tests for failed→passed transitions"
```

- [ ] **步骤 4：实现 mistake-detector.ts**

文件 `src/agent/mistake-detector.ts`：

```typescript
/**
 * Detect "lesson learned" moments: when a tool just transitioned from failed to passed.
 *
 * Used to wire MistakeNotebook's write path: read path is already in tool-pipeline,
 * but recordMistake was never called. This pure function scans the trace store
 * to find the most recent failed event of the same tool, ensuring we only learn
 * a mistake once (skip if already resolved by an intervening passed).
 */

import type { TraceStore } from './trace-store.js'

export interface MistakeResolution {
  /** The error summary from the prior failed event */
  error: string
  /** Context: the tool name that failed and was just resolved */
  context: string
}

/**
 * If the event identified by currentTraceId is a passed tool event AND there
 * is an earlier failed event for the same tool that has not yet been resolved
 * (no passed event between them), return the resolution. Otherwise return null.
 */
export function detectMistakeResolution(
  store: TraceStore,
  currentTraceId: string,
  currentToolName: string,
): MistakeResolution | null {
  const events = store.events
  // Find current event index
  const currentIdx = events.findIndex(e => e.id === currentTraceId)
  if (currentIdx < 0) return null

  const current = events[currentIdx]!
  if (current.status !== 'passed') return null

  // Walk backward to find most recent same-tool event
  for (let i = currentIdx - 1; i >= 0; i--) {
    const prior = events[i]!
    if (prior.name !== currentToolName) continue
    // Found a same-tool event. If it passed, the earlier failure (if any)
    // was already resolved — no new lesson here.
    if (prior.status === 'passed') return null
    if (prior.status === 'failed') {
      return {
        error: prior.summary ?? '(no summary)',
        context: currentToolName,
      }
    }
    // Other statuses (running, blocked) — keep walking
  }

  return null
}
```

- [ ] **步骤 5：运行测试，验证全部通过**

运行：`npx tsx --test src/agent/__tests__/mistake-detector.test.ts`

预期：7/7 PASS

- [ ] **步骤 6：跑 typecheck 确认无副作用**

运行：`npx tsc --noEmit`

预期：exit 0

如果失败，看错误信息——可能是 `import type` 路径错误或 `TraceEvent` 字段名不匹配。

- [ ] **步骤 7：Commit 实现**

```bash
git add src/agent/mistake-detector.ts
git commit -m "feat(mistake): add detector for failed→passed transitions"
```

- [ ] 🛑 **STOP** —— 任务 1 完成。报告以下信息给用户审查：
  - 两个 commit SHA
  - `npx tsx --test src/agent/__tests__/mistake-detector.test.ts` 的测试通过数
  - `npx tsc --noEmit; echo "exit: $?"` 的 exit code
  
  **不要继续任务 2。**

---

## 任务 2：在 tool-pipeline.ts 接入写路径

**文件：**
- 修改：`src/agent/tool-pipeline.ts`（在 finishTraceEvent 之后调用 detector + recordMistake）

**前置阅读（必读）：**
- `src/agent/tool-pipeline.ts` 行 555-575——理解 finishTraceEvent 上下文与现有 hints 注入逻辑（行 556-560）
- `src/agent/p3-integration.ts` 行 73-81——`recordMistake` 的精确签名

**关键架构点：**
- 写路径必须在 `finishTraceEvent(...)` **之后**，因为我们要在更新后的 `traceStore` 上检测
- 用 `traceId`（已经存在的局部变量）+ `tu.name` 调 detector
- 触发条件：`!harnessResult.isError && deps.p3 && detection !== null`
- `resolution` 字段填什么：用当前工具的 input 摘要（避免存大量 raw content）

- [ ] **步骤 1：用 Read 工具读 `src/agent/tool-pipeline.ts` 行 555-580 确认精确缩进**

不要跳过这一步。看清当前 `finishTraceEvent` 的缩进层级（应该在 try 块或某 if 块里），新代码必须匹配。

- [ ] **步骤 2：在 tool-pipeline.ts 顶部追加 import**

用 Read 工具看顶部 import 区（约行 1-30），找到合适位置插入：

```typescript
import { detectMistakeResolution } from './mistake-detector.js'
```

按字母序或邻近模块原则放置。

- [ ] **步骤 3：在 finishTraceEvent 之后插入 recordMistake 调用**

用 Edit 工具在 `tool-pipeline.ts` 中找到（约行 564-571）：

```typescript
    // Trace recording
    traceStore = finishTraceEvent(traceStore, traceId, {
      status: harnessResult.isError ? 'failed' : 'passed',
      endedAt: Date.now(),
      summary: harnessResult.content.slice(0, 100),
    })
    deps.recordPrediction?.(!harnessResult.isError)
    const fp = fingerprintToolCall(tu.name, tu.input, harnessResult.isError ? 'error' : 'success')
    traceStore = recordToolFingerprint(traceStore, fp)
```

在 `recordToolFingerprint` 之后（在 `callbacks.onToolResult` 之前）插入：

```typescript

    // P3-A: write path — when a tool resolves a prior failure of itself,
    // record the mistake into MistakeNotebook so getMistakeHints can find
    // it next time. Read path is already wired above (line ~558).
    if (!harnessResult.isError && deps.p3) {
      const resolution = detectMistakeResolution(traceStore, traceId, tu.name)
      if (resolution) {
        try {
          const inputDigest = JSON.stringify(tu.input).slice(0, 200)
          deps.p3.recordMistake(
            resolution.error,
            resolution.context,
            inputDigest,
            [tu.name],
          )
        } catch { /* non-critical: notebook learning is best-effort */ }
      }
    }
```

注意缩进——必须与上下文同级（看上下文，应该是 4 空格）。

- [ ] **步骤 4：跑 typecheck**

运行：`npx tsc --noEmit; echo "exit: $?"`

预期：exit 0

如果失败：
- 看是否是 import 路径错误（`./mistake-detector.js` 必须以 `.js` 结尾）
- 看是否是 `tu.input` 类型与 `JSON.stringify` 不兼容（`tu.input` 是 `Record<string, unknown>`，应该 OK）

- [ ] **步骤 5：跑全量测试**

运行：`npm test`

预期：通过率与任务 1 之前一致（pre-existing `startup-memory.test.ts` 失败可忽略）。

- [ ] **步骤 6：人工验证集成**

```bash
grep -n "detectMistakeResolution\|recordMistake" src/agent/tool-pipeline.ts
```

预期：3 个匹配（1 个 import + 1 个 detector 调用 + 1 个 recordMistake 调用）。

- [ ] **步骤 7：Commit**

```bash
git add src/agent/tool-pipeline.ts
git commit -m "$(cat <<'EOF'
feat(mistake): wire MistakeNotebook write path on tool resolution

When a tool just transitioned from failed to passed (same tool name),
call p3.recordMistake to learn the resolution. Previously the read
path (getMistakeHints in tool-pipeline.ts:558) was wired but the
notebook was never written — every query returned empty.

Detector logic in mistake-detector.ts: pure function scanning trace
events backward, returning the most recent unresolved failed event
of the same tool. Wrapped in try/catch — learning is best-effort.

Closes orphan code identified in commit 186b179 audit.
EOF
)"
```

- [ ] 🛑 **STOP** —— 任务 2 完成。报告：
  - Commit SHA
  - `grep` 输出（必须 3 个匹配）
  - typecheck exit code
  - 测试通过数

  这是计划的最后一个任务。完成后报告 cross-task 自检（见下）。

---

## 跨任务自检（任务 2 完成后必读）

执行 agent 完成后必须报告：

```bash
# 1. 三个 commit 应独立存在（顺序：测试 → 实现 → wire）
git log --oneline -3
# 预期看到三行：
#   [SHA] feat(mistake): wire MistakeNotebook write path on tool resolution
#   [SHA] feat(mistake): add detector for failed→passed transitions
#   [SHA] test(mistake): add detector tests for failed→passed transitions

# 2. 写路径有 3 个匹配（import + detector + recordMistake）
grep -n "detectMistakeResolution\|recordMistake" src/agent/tool-pipeline.ts | wc -l
# 预期：3

# 3. 全量 typecheck + test
npx tsc --noEmit && echo "TYPECHECK PASS"
npm test 2>&1 | tail -3
```

---

## 范围之外（明确不做）

- **不动 `mistake-notebook.ts` 的实现**——`record` 方法已经能去重（同 id 直接 return），不需要再加防抖
- **不动 `getMistakeHints` 调用点**——读路径已 wire 在 tool-pipeline.ts:558，不变
- **不持久化 notebook 到磁盘**——这是 immune 计划任务 8 的范围，本次只解决进程内孤儿
- **不动 trace store 的 cap（默认 50）**——detector 在 50 个事件内查找前驱足够；超过 50 个事件的 failed 算"忘掉了"是合理的

未来工作（合并到 immune 计划任务 8）：
- 将 notebook 跨 session 持久化到 SQLite
- 把 immune adaptive 层的 repair memory 同步到 notebook（双向反馈）

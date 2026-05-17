# Failure Classifier Expansion + Activity Status Integration 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 扩展 `classifyFailure()` 增加 5 种新失败类型，补充修复提示模板，集成 `onPhaseChange` 通知 TUI 阻塞状态。

**架构：** 在 `failure-classifier.ts` 中按优先级插入 5 个新正则分支（permission_denied, context_window_exceeded, api_error, syntax_error, format_error）。在 `repair-hint.ts` 的 `HINT_TEMPLATES` 中添加对应修复建议。在 `tool-pipeline.ts` 的 repair hint + antibody 段落后增加 `onPhaseChange('blocked')` 触发。在 `loop.ts` 的 `AgentCallbacks` 接口中添加可选 `onPhaseChange` 回调。

**技术栈：** TypeScript, node:test, 现有 classifyFailure / RepairHintTracker / AgentCallbacks 基础设施。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/failure-classifier.ts` | 修改 | 添加 5 个 FailureClass 联合类型成员 + 5 个 regex 分支 + 更新 isTransient() |
| `src/agent/repair-hint.ts` | 修改 | HINT_TEMPLATES 添加 5 条新模板 |
| `src/agent/loop.ts:72-82` | 修改 | AgentCallbacks 接口添加 `onPhaseChange?` |
| `src/agent/tool-pipeline.ts:328-345` | 修改 | repair hint 段落后添加 onPhaseChange 触发逻辑 |
| `src/agent/__tests__/failure-classifier.test.ts` | 修改 | 添加 18+ 个新分类测试 |
| `src/agent/__tests__/repair-hint.test.ts` | 创建 | 修复提示模板测试 |

---

## 任务 1：扩展 classifyFailure() 新增 5 种失败类型

**文件：**
- 修改：`src/agent/failure-classifier.ts`
- 修改：`src/agent/__tests__/failure-classifier.test.ts`

- [ ] **步骤 1：编写新失败类型的测试**

追加到 `src/agent/__tests__/failure-classifier.test.ts`：

```typescript
// === permission_denied ===
it('classifies EACCES permission errors', () => {
  const result = classifyFailure("EACCES: permission denied, open '/etc/shadow'")
  assert.equal(result.class, 'permission_denied')
  assert.equal(result.retryable, false)
})

it('classifies Permission denied string', () => {
  const result = classifyFailure('Error: Permission denied')
  assert.equal(result.class, 'permission_denied')
})

it('classifies Operation not permitted', () => {
  const result = classifyFailure('EPERM: operation not permitted')
  assert.equal(result.class, 'permission_denied')
})

// === context_window_exceeded ===
it('classifies context length exceeded', () => {
  const result = classifyFailure("This model's maximum context length is 200000 tokens")
  assert.equal(result.class, 'context_window_exceeded')
  assert.equal(result.retryable, false)
})

it('classifies token limit errors', () => {
  const result = classifyFailure('Maximum context length exceeded')
  assert.equal(result.class, 'context_window_exceeded')
})

it('classifies too many tokens', () => {
  const result = classifyFailure('Too many tokens in input')
  assert.equal(result.class, 'context_window_exceeded')
})

// === api_error ===
it('classifies 429 rate limit', () => {
  const result = classifyFailure('429 Too Many Requests')
  assert.equal(result.class, 'api_error')
  assert.equal(result.retryable, true)
})

it('classifies 500 server error', () => {
  const result = classifyFailure('500 Internal Server Error')
  assert.equal(result.class, 'api_error')
})

it('classifies 502 bad gateway', () => {
  const result = classifyFailure('502 Bad Gateway')
  assert.equal(result.class, 'api_error')
})

it('classifies rate limit text', () => {
  const result = classifyFailure('Error: rate limit exceeded')
  assert.equal(result.class, 'api_error')
})

// === syntax_error ===
it('classifies SyntaxError', () => {
  const result = classifyFailure('SyntaxError: Unexpected token')
  assert.equal(result.class, 'syntax_error')
  assert.equal(result.retryable, false)
})

it('classifies ParseError', () => {
  const result = classifyFailure('ParseError: Unexpected end of input')
  assert.equal(result.class, 'syntax_error')
})

it('classifies compilation error', () => {
  const result = classifyFailure('compilation error in module foo')
  assert.equal(result.class, 'syntax_error')
})

it('classifies reference error (is not defined)', () => {
  const result = classifyFailure('ReferenceError: myVar is not defined')
  assert.equal(result.class, 'syntax_error')
})

// === format_error ===
it('classifies JSON parse errors', () => {
  const result = classifyFailure('JSON.parse: unexpected character at line 1 column 5')
  assert.equal(result.class, 'format_error')
  assert.equal(result.retryable, true)
})

it('classifies malformed output', () => {
  const result = classifyFailure('Error: malformed response from API')
  assert.equal(result.class, 'format_error')
})

it('classifies unterminated string in JSON', () => {
  const result = classifyFailure('Unterminated string in JSON at position 42')
  assert.equal(result.class, 'format_error')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "permission_denied|context_window|api_error|syntax_error|format_error" 2>&1 | tail -15`
预期：全部 FAIL（新类型未定义，fallback 到 unknown）

- [ ] **步骤 3：添加 5 个新 FailureClass 成员**

在 `src/agent/failure-classifier.ts` 的 `FailureClass` 联合类型中添加：

```typescript
export type FailureClass =
  | 'type_error'
  | 'assertion'
  | 'missing_dep'
  | 'timeout'
  | 'snapshot'
  | 'module_resolution'
  | 'env_missing'
  | 'flaky'
  | 'unknown'
  // NEW
  | 'permission_denied'
  | 'context_window_exceeded'
  | 'api_error'
  | 'syntax_error'
  | 'format_error'
```

- [ ] **步骤 4：在 classifyFailure() 中插入新 regex 分支**

在 `classifyFailure()` 函数中，按以下顺序插入（注意：在现有 `missing_dep` 之后、`timeout` 之前插入前两个，`timeout` 之后插入 `api_error`，`snapshot` 之后、`env_missing` 之前插入 `syntax_error`，`assertion` 之后、`flaky` 之前插入 `format_error`）：

```typescript
export function classifyFailure(errorText: string): ClassifiedFailure {
  // Priority order: most specific patterns first

  // 1. TypeScript type errors (existing — unchanged)
  if (/error TS\d{4}:/.test(errorText) || /Type '.*' is not assignable/.test(errorText) || /Property '.*' does not exist/.test(errorText)) {
    return { class: 'type_error', suggestion: 'Fix type annotation or interface. Do not change business logic.', confidence: 0.9, retryable: false }
  }

  // 2. Module resolution (existing — unchanged)
  if (/Cannot find module/.test(errorText) || /Module not found/.test(errorText)) {
    return { class: 'module_resolution', suggestion: 'Check import path, file existence, and package.json exports.', confidence: 0.9, retryable: false }
  }

  // 3. Permission denied (NEW)
  if (/EACCES/.test(errorText) || /Permission denied/.test(errorText) || /Operation not permitted/.test(errorText)) {
    return { class: 'permission_denied', suggestion: 'Check file permissions or sandbox policy.', confidence: 0.9, retryable: false }
  }

  // 4. Missing dependency (existing — unchanged)
  if (/command not found|sh: .*: command not found|Cannot find package/.test(errorText)) {
    return { class: 'missing_dep', suggestion: 'Report missing dependency. Do not silently change the test command.', confidence: 0.8, retryable: false }
  }

  // 5. Context window exceeded (NEW)
  if (/context length exceeded|maximum context length|token limit|too many tokens/i.test(errorText)) {
    return { class: 'context_window_exceeded', suggestion: 'Use /compact to reduce context, or start a new session.', confidence: 0.9, retryable: false }
  }

  // 6. Timeout (existing — unchanged)
  if (/timeout|timed out|Exceeded timeout/.test(errorText)) {
    return { class: 'timeout', suggestion: 'Check for infinite loops, unawaited async, or slow operations. Consider increasing timeout.', confidence: 0.8, retryable: true }
  }

  // 6b. Network/transient errors (existing — unchanged)
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(errorText)) {
    return { class: 'timeout', suggestion: 'Transient network error. Retry may succeed.', confidence: 0.85, retryable: true }
  }

  // 7. API error — HTTP status codes (NEW, after timeout to avoid double-match on network errors)
  if (/429|500|502|503|rate limit|Too Many Requests|Bad Gateway|Internal Server Error|Service Unavailable/i.test(errorText)) {
    return { class: 'api_error', suggestion: 'Transient API error. Retry after cooldown.', confidence: 0.85, retryable: true }
  }

  // 8. Syntax/compilation errors (NEW)
  if (/SyntaxError|ParseError|unexpected token|Unexpected end of input|compilation error|Cannot find name|is not defined/.test(errorText)) {
    return { class: 'syntax_error', suggestion: 'Fix the syntax or reference error in the code.', confidence: 0.8, retryable: false }
  }

  // 9. Snapshot (existing — unchanged)
  if (/snapshot/i.test(errorText) && (/diff/.test(errorText) || /mismatch/.test(errorText))) {
    return { class: 'snapshot', suggestion: 'Review snapshot diff. If change is intentional, update snapshots.', confidence: 0.85, retryable: false }
  }

  // 10. Environment missing (existing — unchanged)
  if (/environment variable|ENV|env:/i.test(errorText) || /API key|secret|credential/i.test(errorText)) {
    return { class: 'env_missing', suggestion: 'Mark as blocked. Required environment or credentials are missing.', confidence: 0.8, retryable: false }
  }

  // 11. Assertion failure (existing — unchanged)
  if (/assert|expect|AssertionError|Expected|expected.*but got/.test(errorText) || /not ok \d+/.test(errorText)) {
    return { class: 'assertion', suggestion: 'Compare expected vs actual. Determine if test expectation is wrong or implementation is buggy before changing code.', confidence: 0.7, retryable: false }
  }

  // 12. Format error (NEW, near bottom — broadest format catch)
  if (/JSON parse|malformed|Unterminated string|Unexpected end of JSON|Invalid character in JSON/i.test(errorText)) {
    return { class: 'format_error', suggestion: 'Model output was malformed. Retry with clearer format instructions.', confidence: 0.75, retryable: true }
  }

  // 13. Flaky (existing — unchanged)
  if (/flaky|intermittent|sometimes|occasionally/.test(errorText)) {
    return { class: 'flaky', suggestion: 'Mark as potentially flaky. Run multiple times to confirm before treating as code bug.', confidence: 0.5, retryable: true }
  }

  return { class: 'unknown', suggestion: 'Read the full error output carefully. Identify the exact failure before attempting a fix.', confidence: 0.3, retryable: false }
}
```

- [ ] **步��� 5：更新 isTransient()**

将 `api_error` 加入 transient 集合：

```typescript
const TRANSIENT_CLASSES: ReadonlySet<FailureClass> = new Set(['timeout', 'flaky', 'api_error'])
```

- [ ] **步骤 6：运行测试验证通过**

运行：`npm test -- --test-name-pattern "classifyFailure|classifyTestRun|isTransient" 2>&1 | tail -15`
预期：全部 PASS（包括旧测试和新增测试）

- [ ] **步骤 7：运行全量测试确认无回归**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors, 1050+ pass, 0 fail

- [ ] **步骤 8：Commit**

```bash
git add src/agent/failure-classifier.ts src/agent/__tests__/failure-classifier.test.ts
git commit -m "feat(error): add 5 new failure types — permission_denied, context_window_exceeded, api_error, syntax_error, format_error"
```

---

## 任务 2：添加修复提示模板

**文件：**
- 修改：`src/agent/repair-hint.ts`
- 创建：`src/agent/__tests__/repair-hint.test.ts`

- [ ] **步骤 1：编写修复提示测试**

创建 `src/agent/__tests__/repair-hint.test.ts`：

```typescript
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { RepairHintTracker } from '../repair-hint.js'

describe('RepairHintTracker', () => {
  let tracker: RepairHintTracker

  beforeEach(() => {
    tracker = new RepairHintTracker()
  })

  it('returns null when no failures recorded', () => {
    assert.equal(tracker.getHint(), null)
  })

  it('returns null after 1 failure (below threshold)', () => {
    tracker.recordFailure('bash', 'timeout')
    assert.equal(tracker.getHint(), null)
  })

  it('returns hint after 2 consecutive same-type failures', () => {
    tracker.recordFailure('bash', 'timeout')
    tracker.recordFailure('bash', 'timeout')
    const hint = tracker.getHint()
    assert.ok(hint !== null)
    assert.ok(hint.includes('repair-hint'))
    assert.ok(hint.includes('shorter commands'))
  })

  it('returns null after 4+ failures (exhaustion limit)', () => {
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure('bash', 'timeout')
    }
    assert.equal(tracker.getHint(), null)
  })

  it('clears failures on success', () => {
    tracker.recordFailure('bash', 'timeout')
    tracker.recordFailure('bash', 'timeout')
    tracker.recordSuccess('bash')
    assert.equal(tracker.getHint(), null)
  })

  // NEW: test new failure type hints
  it('returns permission_denied hint', () => {
    tracker.recordFailure('bash', 'permission_denied')
    tracker.recordFailure('bash', 'permission_denied')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('Check file permissions'))
  })

  it('returns context_window_exceeded hint', () => {
    tracker.recordFailure('bash', 'context_window_exceeded')
    tracker.recordFailure('bash', 'context_window_exceeded')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('/compact'))
  })

  it('returns api_error hint', () => {
    tracker.recordFailure('web_fetch', 'api_error')
    tracker.recordFailure('web_fetch', 'api_error')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('rate limit cooldown'))
  })

  it('returns syntax_error hint', () => {
    tracker.recordFailure('bash', 'syntax_error')
    tracker.recordFailure('bash', 'syntax_error')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('syntax error'))
  })

  it('returns format_error hint', () => {
    tracker.recordFailure('bash', 'format_error')
    tracker.recordFailure('bash', 'format_error')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('malformed'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "RepairHintTracker" 2>&1 | tail -15`
预期：FAIL — `Cannot find module '../repair-hint.js'` 或部分 hint 匹配失败

- [ ] **步骤 3：添加新修复提示模板**

在 `src/agent/repair-hint.ts` 的 `HINT_TEMPLATES` 中追加：

```typescript
const HINT_TEMPLATES: Record<string, string> = {
  // Existing (unchanged)
  type_error: 'Ensure all parameters match the expected types exactly.',
  assertion: 'Verify the target content exists before attempting modification.',
  timeout: 'Use shorter commands or break into smaller operations.',
  missing_dep: 'Check that required imports and dependencies are available.',
  // NEW
  permission_denied: 'Check file permissions or run with appropriate access.',
  context_window_exceeded: 'Use /compact to reduce context before continuing.',
  api_error: 'Wait a moment for rate limit cooldown, then retry.',
  syntax_error: 'Fix the syntax error — check for missing brackets, semicolons, or typos.',
  format_error: 'The output was malformed. Retry with clearer format instructions.',
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-name-pattern "RepairHintTracker" 2>&1 | tail -10`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/repair-hint.ts src/agent/__tests__/repair-hint.test.ts
git commit -m "feat(error): add repair hint templates for 5 new failure types"
```

---

## 任务 3：AgentCallbacks 添加 onPhaseChange + tool-pipeline 集成

**文件：**
- 修改：`src/agent/loop.ts:72-82`
- 修改：`src/agent/tool-pipeline.ts:328-345`

- [ ] **步骤 1：在 AgentCallbacks 接口中添加 onPhaseChange**

在 `src/agent/loop.ts` 的 `AgentCallbacks` 接口中添加可选回调（在 `onCheckpoint?` 之后）：

```typescript
export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number) => void
  onError: (error: Error) => void
  onAbort: () => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
  onPhaseChange?: (phase: string, detail?: { tool?: string; reason?: string; suggestion?: string }) => void
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：0 errors

- [ ] **步骤 3：在 tool-pipeline.ts 中添加 BLOCKED_CLASSES 和 onPhaseChange 触发**

在 `src/agent/tool-pipeline.ts` 顶部（imports 之后）添加：

```typescript
/** Failure classes that trigger onPhaseChange('blocked') — user-visible state. */
const BLOCKED_CLASSES: ReadonlySet<string> = new Set([
  'context_window_exceeded',
  'api_error',
  'permission_denied',
])
```

在 `src/agent/tool-pipeline.ts` 的 repair hint + antibody 段落（约 line 345）之后、Prewarm invalidation 之前插入：

```typescript
    // Activity status: notify TUI when tool is blocked by critical failure
    if (harnessResult.isError && callbacks.onPhaseChange) {
      const failureClass = classifyFailure(harnessResult.content)
      if (BLOCKED_CLASSES.has(failureClass.class)) {
        callbacks.onPhaseChange('blocked', {
          tool: tu.name,
          reason: failureClass.class,
          suggestion: failureClass.suggestion,
        })
      }
    }
```

注意：这段代码在 `else` 分支（harnessResult.isError 为 true）中已经有了 `classifyFailure` 调用（line 333），但那里是为了 repair hint。此处独立调用是为了 `onPhaseChange`——两次 `classifyFailure` 调用输入相同、结果一致，不会产生副作用。

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：0 errors

- [ ] **步骤 5：运行全量测试**

运行：`npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 fail

- [ ] **步骤 6：Commit**

```bash
git add src/agent/loop.ts src/agent/tool-pipeline.ts
git commit -m "feat(error): add onPhaseChange callback for blocked-state TUI feedback"
```

---

## 任务 4：全量验证

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit 2>&1`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 fail, 1060+ pass

- [ ] **步骤 3：验证新测试覆盖**

运行：`npm test -- --test-name-pattern "permission_denied|context_window|api_error|syntax_error|format_error|RepairHintTracker" 2>&1 | grep -E "^(✓|✗|ℹ)"`
预期：25+ tests 全部 PASS

---

## 自检

1. **规格覆盖度：**
   - Part 1 (5 new types) → 任务 1 ✓
   - Part 2 (repair hints) → 任务 2 ✓
   - Part 3 (onPhaseChange integration) → 任务 3 ✓
   - Part 4 (behavioral changes) → 任务 1 步骤 5 (isTransient) ✓
   - Part 5 (test plan) → 任务 1-2 的测试步骤 ✓
   - All covered.

2. **占位符扫描：** 无 TODO/TBD。所有步骤有完整代码块。

3. **类型一致性：**
   - `FailureClass` 联合类型在任务 1 步骤 3 定义，步骤 4 使用 ✓
   - `BLOCKED_CLASSES` 在任务 3 步骤 3 定义，步骤 3 使用 ✓
   - `onPhaseChange` 在任务 3 步骤 1 定义（AgentCallbacks），步骤 3 使用（tool-pipeline） ✓
   - `HINT_TEMPLATES` 在任务 2 步骤 3 更新，任务 2 步骤 1 测试验证 ✓

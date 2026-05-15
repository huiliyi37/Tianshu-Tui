# Attention Anchor Dispersal 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 在 volatile context 中注入三层"注意力分散"信息（git log + behavior mirror + decision anchors），让模型在复杂任务中被动获得全局视角，减少注意力坍缩到最小补丁的倾向。

**架构：** 三层独立注入，各有独立触发条件。全部在 volatile block 中（不影响 frozen prefix cache）。模型无关设计，适用于 DeepSeek/Claude/GPT/开源模型。

**技术栈：** TypeScript, node:test, node:assert/strict

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/prompt/volatile-git.ts` | 加入 git log --oneline -5 |
| 创建 | `src/agent/behavior-mirror.ts` | 重复模式检测 + mirror 文本生成 |
| 创建 | `src/agent/decision-anchor.ts` | 从模型输出中提取决策点 |
| 创建 | `src/agent/__tests__/behavior-mirror.test.ts` | Mirror 检测测试 |
| 创建 | `src/agent/__tests__/decision-anchor.test.ts` | Decision 提取测试 |
| 修改 | `src/prompt/volatile.ts` | 新增 3 个 XML section 注入 |
| 修改 | `src/agent/loop.ts` | 调用 mirror 检测 + decision 提取 |

---

### 任务 1：Git Log 注入

**文件：**
- 修改：`src/prompt/volatile-git.ts`
- 修改：`src/prompt/volatile.ts`

- [x] **步骤 1：修改 volatile-git.ts 加入 git log**

在 `loadGitStatus()` 的 `Promise.all` 中加入第三个命令：

```typescript
async function loadGitStatus(cwd: string): Promise<string | undefined> {
  try {
    const [branchResult, statusResult, logResult] = await Promise.all([
      execFileP('git', ['branch', '--show-current'], { cwd, timeout: 5000 }),
      execFileP('git', ['status', '--short'], { cwd, timeout: 5000 }),
      execFileP('git', ['log', '--oneline', '-5'], { cwd, timeout: 5000 }).catch(() => ({ stdout: '' })),
    ])
    const base = formatGitStatus(branchResult.stdout.trim(), statusResult.stdout.trim())
    const log = logResult.stdout.trim()
    if (!base && !log) return undefined
    return log ? `${base ?? ''}\nRecent commits:\n${log}` : base
  } catch {
    return undefined
  }
}
```

- [x] **步骤 2：在 volatile.ts 中将 git log 部分拆为 `<recent-commits>` 独立块**

修改 `buildVolatileBlock` 中 git-status 的渲染逻辑：

```typescript
if (git) {
  const lines = git.split('\n')
  const commitIdx = lines.findIndex(l => l.startsWith('Recent commits:'))
  if (commitIdx >= 0) {
    const statusPart = lines.slice(0, commitIdx).join('\n').trim()
    const commitsPart = lines.slice(commitIdx + 1).join('\n').trim()
    if (statusPart) parts.push(`<git-status>\n${escapeXml(statusPart)}\n</git-status>`)
    if (commitsPart) parts.push(`<recent-commits>\n${escapeXml(commitsPart)}\n</recent-commits>`)
  } else {
    parts.push(`<git-status>\n${escapeXml(git)}\n</git-status>`)
  }
}
```

- [x] **步骤 3：运行现有 volatile 测试**

运行：`npm test -- --test-path-pattern volatile.test 2>&1 | tail -5`
预期：PASS（现有测试不依赖 git-status 的精确格式）

- [x] **步骤 4：运行 typecheck + 全量测试**

运行：`npm run typecheck && npm test 2>&1 | tail -5`
预期：clean + all pass

- [x] **步骤 5：Commit**

```bash
git add src/prompt/volatile-git.ts src/prompt/volatile.ts
git commit -m "feat(prompt): inject recent git commits into volatile context"
```

---

### 任务 2：Behavior Mirror 检测器

**文件：**
- 创建：`src/agent/behavior-mirror.ts`
- 测试：`src/agent/__tests__/behavior-mirror.test.ts`

- [x] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/behavior-mirror.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectMirror } from '../behavior-mirror.js'
import type { TrajectoryEntry } from '../trajectory.js'

describe('detectMirror', () => {
  it('detects repeated edits to same file', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 3, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    const mirror = detectMirror(entries)
    assert.ok(mirror)
    assert.ok(mirror.includes('auth.ts'))
    assert.ok(mirror.includes('3'))
  })

  it('detects repeated error class', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'bash', target: 'npm test', durationMs: 200, status: 'failed', errorClass: 'type_error', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'bash', target: 'npm test', durationMs: 200, status: 'failed', errorClass: 'type_error', inputSummary: '', resultSummary: '' },
    ]
    const mirror = detectMirror(entries)
    assert.ok(mirror)
    assert.ok(mirror.includes('type_error'))
  })

  it('detects unverified edits', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'edit_file', target: 'a.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 1, tool: 'edit_file', target: 'b.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'write_file', target: 'c.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    const mirror = detectMirror(entries)
    assert.ok(mirror)
    assert.ok(mirror.includes('3'))
    assert.ok(mirror.includes('验证') || mirror.includes('test'))
  })

  it('returns null when no pattern detected', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'a.ts', durationMs: 10, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 1, tool: 'edit_file', target: 'a.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'bash', target: 'npm test', durationMs: 100, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    assert.equal(detectMirror(entries), null)
  })

  it('returns null for fewer than 3 entries', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'edit_file', target: 'a.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    assert.equal(detectMirror(entries), null)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-path-pattern behavior-mirror.test 2>&1 | tail -5`
预期：FAIL，"Cannot find module"

- [x] **步骤 3：编写实现**

```typescript
// src/agent/behavior-mirror.ts
import type { TrajectoryEntry } from './trajectory.js'

export function detectMirror(entries: TrajectoryEntry[]): string | null {
  if (entries.length < 3) return null

  // Priority 1: repeated error class (2+ same errorClass)
  const errors = entries.filter(e => e.errorClass)
  const errorCounts = new Map<string, number>()
  for (const e of errors) errorCounts.set(e.errorClass!, (errorCounts.get(e.errorClass!) ?? 0) + 1)
  for (const [cls, count] of errorCounts) {
    if (count >= 2) return `Same error (${cls}) has occurred ${count} times. Is the current approach the right path? What is the root cause?`
  }

  // Priority 2: repeated edits to same file (3+ edits)
  const edits = entries.filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
  const fileCounts = new Map<string, number>()
  for (const e of edits) fileCounts.set(e.target, (fileCounts.get(e.target) ?? 0) + 1)
  for (const [file, count] of fileCounts) {
    if (count >= 3) {
      const name = file.split('/').pop() ?? file
      return `You have edited ${name} ${count} times. What is the root cause? Would a higher-level fix be more effective?`
    }
  }

  // Priority 3: unverified edits (3+ consecutive edit/write without test/bash)
  const recent = entries.slice(-5)
  const writeOps = recent.filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
  const verifyOps = recent.filter(e => e.tool === 'bash' || e.tool === 'run_tests')
  if (writeOps.length >= 3 && verifyOps.length === 0) {
    return `You have modified ${writeOps.length} files without running tests or verification. Consider validating your changes before continuing.`
  }

  return null
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-path-pattern behavior-mirror.test 2>&1 | tail -5`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/behavior-mirror.ts src/agent/__tests__/behavior-mirror.test.ts
git commit -m "feat(agent): add behavior mirror — detect repetition patterns in trajectory"
```

---

### 任务 3：Decision Anchor 提取器

**文件：**
- 创建：`src/agent/decision-anchor.ts`
- 测试：`src/agent/__tests__/decision-anchor.test.ts`

- [x] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/decision-anchor.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractDecisions } from '../decision-anchor.js'

describe('extractDecisions', () => {
  it('extracts "I will" decisions', () => {
    const text = "I'll use the middleware pattern for authentication instead of decorators."
    const decisions = extractDecisions(text)
    assert.equal(decisions.length, 1)
    assert.ok(decisions[0]!.includes('middleware pattern'))
  })

  it('extracts "方案是" decisions', () => {
    const text = "方案是把 monolith 拆分为 context/ 模块结构。"
    const decisions = extractDecisions(text)
    assert.equal(decisions.length, 1)
    assert.ok(decisions[0]!.includes('monolith'))
  })

  it('extracts "approach:" decisions', () => {
    const text = "approach: split the agent loop into turn-harness + orchestrator"
    const decisions = extractDecisions(text)
    assert.equal(decisions.length, 1)
  })

  it('returns empty for no decisions', () => {
    const text = "Let me read the file first to understand the current implementation."
    assert.equal(extractDecisions(text).length, 0)
  })

  it('limits to 3 decisions max', () => {
    const text = "I'll do A. I'll do B. I'll do C. I'll do D. I'll do E."
    assert.equal(extractDecisions(text).length, 3)
  })

  it('ignores short matches', () => {
    const text = "I'll fix it."
    assert.equal(extractDecisions(text).length, 0)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-path-pattern decision-anchor.test 2>&1 | tail -5`
预期：FAIL

- [x] **步骤 3：编写实现**

```typescript
// src/agent/decision-anchor.ts
const DECISION_RE = /(?:I'll|I will|approach:|plan:|strategy:|方案是|我决定|决定采用|选择用)\s*(.{15,100}?)(?:\.|。|$)/gi

export function extractDecisions(text: string): string[] {
  const decisions: string[] = []
  for (const match of text.matchAll(DECISION_RE)) {
    const decision = match[1]!.trim()
    if (decision.length >= 15) {
      decisions.push(decision)
      if (decisions.length >= 3) break
    }
  }
  return decisions
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-path-pattern decision-anchor.test 2>&1 | tail -5`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/decision-anchor.ts src/agent/__tests__/decision-anchor.test.ts
git commit -m "feat(agent): add decision anchor extractor from model output"
```

---

### 任务 4：Volatile Context 注入 mirror + decisions

**文件：**
- 修改：`src/prompt/volatile.ts`（新增 `<behavior-mirror>` 和 `<decisions>` sections）

- [x] **步骤 1：扩展 VolatileContext 接口**

在 `src/prompt/volatile.ts` 的 `VolatileContext` 接口中追加：

```typescript
behaviorMirror?: string | null
decisions?: string[]
```

- [x] **步骤 2：在 buildVolatileBlock 中注入 mirror 和 decisions**

在 `taskProgress` 注入之后、`sessionMemoryBlock` 之前插入：

```typescript
if (ctx.behaviorMirror) {
  parts.push(`<behavior-mirror>\n${escapeXml(ctx.behaviorMirror)}\n</behavior-mirror>`)
}

if (ctx.decisions && ctx.decisions.length > 0) {
  const entries = ctx.decisions.map(d => `  <decision>${escapeXml(d)}</decision>`).join('\n')
  parts.push(`<decisions recent="${ctx.decisions.length}">\n${entries}\n</decisions>`)
}
```

- [x] **步骤 3：运行 typecheck + 全量测试**

运行：`npm run typecheck && npm test 2>&1 | tail -5`
预期：clean + all pass

- [x] **步骤 4：Commit**

```bash
git add src/prompt/volatile.ts
git commit -m "feat(prompt): add behavior-mirror and decisions sections to volatile context"
```

---

### 任务 5：Agent Loop 集成

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/prompt/engine.ts`

- [x] **步骤 1：在 loop.ts 中导入并调用 mirror + decision 提取**

顶部追加 import：

```typescript
import { detectMirror } from './behavior-mirror.js'
import { extractDecisions } from './decision-anchor.js'
```

在 AgentLoop 类中追加属性：

```typescript
private decisions: string[] = []
```

- [x] **步骤 2：在 streaming text 回调中提取 decisions**

在 `run()` 方法中，turn 完成后（`break` 之前，即模型没有 tool_use 时）：

```typescript
// Extract decisions from model output
const newDecisions = extractDecisions(this.streamedText)
for (const d of newDecisions) {
  if (!this.decisions.includes(d)) this.decisions.push(d)
}
if (this.decisions.length > 3) this.decisions = this.decisions.slice(-3)
```

- [x] **步骤 3：在 tool 执行完成后检测 mirror**

在 `this.session.addToolResults(toolResults)` 之后，`extractTaskState` 调用附近：

```typescript
// Behavior mirror detection (only after turn 3)
const mirror = this.session.getTurnCount() > 3
  ? detectMirror(this.trajectory.getEntries())
  : null
```

- [x] **步骤 4：将 mirror + decisions 传给 PromptEngine**

在 `PromptEngine` 类中追加：

```typescript
private behaviorMirror?: string | null
private decisions?: string[]

setBehaviorMirror(mirror: string | null): void { this.behaviorMirror = mirror }
setDecisions(decisions: string[]): void { this.decisions = decisions }
```

修改 `buildRequest` 中 freshBlock 构建：

```typescript
const freshBlock = buildVolatileBlock({
  ...this.config.volatileCtx,
  toolHistory,
  taskProgress: this.taskProgress,
  behaviorMirror: this.behaviorMirror,
  decisions: this.decisions,
})
```

在 loop.ts 中调用：

```typescript
this.config.promptEngine.setBehaviorMirror(mirror)
this.config.promptEngine.setDecisions(this.decisions)
```

- [x] **步骤 5：在 run() 开头 reset decisions**

```typescript
// 在 this.trajectory.reset() 之后
this.decisions = []
```

- [x] **步骤 6：运行 typecheck + 全量测试**

运行：`npm run typecheck && npm test 2>&1 | tail -5`
预期：clean + all pass

- [x] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/prompt/engine.ts
git commit -m "feat(agent): wire behavior mirror + decision anchors into agent loop"
```

---

## 自检

### 1. 规格覆盖度

| 设计规格要求 | 对应任务 |
|-------------|---------|
| Layer 1: git log 注入 | 任务 1 |
| Layer 2: behavior mirror 检测 + 注入 | 任务 2 + 任务 4 |
| Layer 3: decision anchor 提取 + 注入 | 任务 3 + 任务 4 |
| Agent loop 集成 | 任务 5 |
| 模型无关设计 | 全部（问句式 mirror、纯事实 git log、结构化 XML decisions） |

### 2. 占位符扫描

无 TODO、待定。

### 3. 类型一致性

- `detectMirror()` 返回 `string | null`，volatile.ts 接受 `string | null` → 一致
- `extractDecisions()` 返回 `string[]`，volatile.ts 接受 `string[]` → 一致
- `VolatileContext.behaviorMirror` 类型 `string | null | undefined` → 兼容

### 4. 依赖顺序

```
任务 1 (git log) — 独立
任务 2 (behavior mirror) — 独立
任务 3 (decision anchor) — 独立
任务 4 (volatile 注入) — 依赖 2, 3 的类型
任务 5 (loop 集成) — 依赖 1, 2, 3, 4
```

任务 1、2、3 可并行。任务 4 依赖 2+3 的接口。任务 5 最后执行。

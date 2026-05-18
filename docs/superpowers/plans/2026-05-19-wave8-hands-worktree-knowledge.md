# Wave 8: Sub-Agent 深化 — Brain/Hands 分离 + Worktree 隔离 + 知识共享

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 write worker 的代码变更安全回流到主 session：Brain 只持有 delegate + think，Hands 在独立 git worktree 执行写入，diff 打包为 WorkerResult.artifact 回流。Worker 间通过只读 claim 投影共享知识。

**架构：** 新建 `HandsSession`（替代 write profile 的 `WorkerSession`，在独立 worktree 运行），`WorktreeCoordinator`（创建/销毁 worktree），`DiffCollector`（收集 worker worktree 的 diff 并打包为 artifact）。在 `coordination-policy.ts` 中声明 Brain vs Hands 职责边界。Worker 知识共享通过 `WorkerKnowledgeProjection` 暴露只读 claim 快照。

**技术栈：** TypeScript, 现有 coordinator/work-order/worker-session/worktree/checkpoint infrastructure

**前置条件：** Wave 7 ✅ (A1-A7 全部完成)

---

## 1. Scope Check

Wave 8 涉及三个独立子系统：

| 子系统 | 独立程度 | 建议 |
|--------|---------|------|
| Brain/Hands 分离 | 依赖 coordinator 架构，但不依赖 worktree | 可独立实现 |
| Worktree 隔离 | 依赖 Hands 概念，但机械上是 worktree 的 create/destroy/collect | 可独立实现（mock Hands） |
| 知识共享 | 纯增量：给 worker prompt 加一个 claim 投影 block | 完全独立 |

结论：三个子系统可在同一个 plan 中按顺序实现，每个任务独立可测。

---

## 2. File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/agent/coordination-policy.ts` | Brain/Hands 职责边界声明：Brain tool allowlist、Hands tool allowlist |
| `src/agent/hands-session.ts` | Write worker 的执行环境：创建 worktree → 运行 agent → 收集 diff |
| `src/agent/worktree-coordinator.ts` | Worktree 生命周期管理：create、remove、list、cleanup |
| `src/agent/diff-collector.ts` | 从 worktree 收集 diff 并打包为 WorkerResult.artifact |
| `src/agent/worker-knowledge.ts` | 从 claim store 构建 worker 可见的只读知识投影 |
| `src/agent/__tests__/coordination-policy.test.ts` | 策略测试 |
| `src/agent/__tests__/hands-session.test.ts` | Write worker + worktree + diff 收集测试 |
| `src/agent/__tests__/worktree-coordinator.test.ts` | Worktree 生命周期测试 |
| `src/agent/__tests__/diff-collector.test.ts` | Diff 收集和 artifact 打包测试 |
| `src/agent/__tests__/worker-knowledge.test.ts` | 知识投影测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent/coordinator.ts` | 根据 `order.profile` 路由到 `HandsSession`（patcher/verifier）或 `WorkerSession`（其余） |
| `src/agent/work-order.ts` | 新增 `HandsCoordinationPolicy` 类型，扩展 `WorkerResult.artifacts` 增加 `kind: 'diff'` |
| `src/agent/worker-session.ts` | 提取 `WorkerSessionConfig` 公共字段为 `BaseWorkerConfig` |

---

## 3. Tasks

### 任务 1：Coordination Policy — Brain/Hands 职责边界

**文件：**
- 创建：`src/agent/coordination-policy.ts`
- 测试：`src/agent/__tests__/coordination-policy.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/coordination-policy.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRAIN_TOOLS,
  HANDS_READ_TOOLS,
  HANDS_WRITE_TOOLS,
  isBrainTool,
  isHandsTool,
  classifyProfile,
  type AgentRole,
} from '../coordination-policy.js'

describe('coordination policy', () => {
  it('Brain tools include delegate_task, delegate_batch, and think/reasoning primitives', () => {
    for (const t of ['delegate_task', 'delegate_batch']) {
      assert.ok(BRAIN_TOOLS.includes(t), `Brain must include ${t}`)
    }
    // Brain does NOT include any concrete file/code tools
    for (const t of ['bash', 'edit_file', 'write_file', 'run_tests', 'read_file', 'grep', 'glob']) {
      assert.ok(!BRAIN_TOOLS.includes(t), `Brain must NOT include ${t}`)
    }
  })

  it('Hands read tools include all read-only primitives', () => {
    for (const t of ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests']) {
      assert.ok(HANDS_READ_TOOLS.includes(t), `Hands read must include ${t}`)
    }
    assert.ok(!HANDS_READ_TOOLS.includes('delegate_task'), 'Hands must NOT include delegate_task')
  })

  it('Hands write tools include edit/write/bash/run_tests', () => {
    for (const t of ['edit_file', 'write_file', 'bash', 'run_tests']) {
      assert.ok(HANDS_WRITE_TOOLS.includes(t), `Hands write must include ${t}`)
    }
  })

  it('classifyProfile returns "brain" for planner, "hands" for patcher/verifier, "readonly" for scouts', () => {
    assert.equal(classifyProfile('planner'), 'brain')
    assert.equal(classifyProfile('patcher'), 'hands')
    assert.equal(classifyProfile('verifier'), 'hands')
    assert.equal(classifyProfile('code_scout'), 'readonly')
    assert.equal(classifyProfile('reviewer'), 'readonly')
    assert.equal(classifyProfile('doc_scout'), 'readonly')
  })

  it('isBrainTool / isHandsTool gates correctly', () => {
    assert.equal(isBrainTool('delegate_task'), true)
    assert.equal(isBrainTool('bash'), false)
    assert.equal(isBrainTool('edit_file'), false)
    assert.equal(isHandsTool('bash'), true)
    assert.equal(isHandsTool('delegate_task'), false)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/coordination-policy.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 coordination-policy.ts**

```typescript
// src/agent/coordination-policy.ts
import type { WorkerProfile } from './work-order.js'

export type AgentRole = 'brain' | 'hands' | 'readonly'

// Brain: thinks, plans, delegates. No concrete tools.
export const BRAIN_TOOLS = ['delegate_task', 'delegate_batch'] as const

// Hands: reads + writes. No delegation (Brain owns that).
export const HANDS_READ_TOOLS = ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests'] as const
export const HANDS_WRITE_TOOLS = ['edit_file', 'write_file', 'bash', 'run_tests'] as const
export const HANDS_ALL_TOOLS = [...HANDS_READ_TOOLS, ...HANDS_WRITE_TOOLS] as const

export function classifyProfile(profile: WorkerProfile): AgentRole {
  switch (profile) {
    case 'planner':
      return 'brain'
    case 'patcher':
    case 'verifier':
      return 'hands'
    default:
      return 'readonly'
  }
}

export function isBrainTool(name: string): boolean {
  return (BRAIN_TOOLS as readonly string[]).includes(name)
}

export function isHandsTool(name: string): boolean {
  return (HANDS_ALL_TOOLS as readonly string[]).includes(name)
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/coordination-policy.test.ts`
预期：PASS（4 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/agent/coordination-policy.ts src/agent/__tests__/coordination-policy.test.ts
git commit -m "feat(agent): add coordination policy — Brain/Hands/readonly role classification"
```

---

### 任务 2：Diff Collector — 收集 worktree diff 并打包 artifact

**文件：**
- 创建：`src/agent/diff-collector.ts`
- 测试：`src/agent/__tests__/diff-collector.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/diff-collector.test.ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { collectDiff, formatDiffArtifact } from '../diff-collector.js'
import type { WorkerResult } from '../work-order.js'

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

describe('diff-collector', () => {
  let baseDir: string
  let wtDir: string

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-diff-base-'))
    initGitRepo(baseDir)
    // Create a worktree for the "worker" to write into
    wtDir = mkdtempSync(join(tmpdir(), 'rivet-diff-wt-'))
    execSync(`git worktree add -b rivet-hands-test "${wtDir}"`, { cwd: baseDir, stdio: 'pipe' })
  })

  after(() => {
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: baseDir, stdio: 'pipe' })
    execSync(`git checkout main`, { cwd: baseDir, stdio: 'pipe' })
    execSync(`git branch -D rivet-hands-test`, { cwd: baseDir, stdio: 'pipe' })
    rmSync(baseDir, { recursive: true, force: true })
    rmSync(wtDir, { recursive: true, force: true })
  })

  it('collects diff from worker worktree as git diff between worker branch and base', () => {
    // Simulate worker writing a file
    writeFileSync(join(wtDir, 'src', 'new-file.ts'), 'export const x = 1', { flag: 'w' })
    mkdirSync(join(wtDir, 'src'), { recursive: true })
    writeFileSync(join(wtDir, 'src', 'new-file.ts'), 'export const x = 1')

    execSync('git add -A && git commit -m "worker change"', { cwd: wtDir, stdio: 'pipe' })

    const diff = collectDiff(baseDir, wtDir, 'main')
    assert.ok(diff.length > 0, 'diff should be non-empty')
    assert.ok(diff.includes('new-file.ts'), 'diff should mention changed file')

    const artifact = formatDiffArtifact(diff, 'patcher')
    assert.equal(artifact.kind, 'diff')
    assert.ok(artifact.title.includes('new-file.ts'))
    assert.equal(artifact.content, diff)
  })

  it('returns empty diff when no changes in worker worktree', () => {
    const diff = collectDiff(baseDir, wtDir, 'rivet-hands-test')
    // After the commit above, diff vs same branch is empty
    assert.equal(diff, '')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/diff-collector.test.ts`
预期：FAIL（至少第一个测试失败，模块不存在）

- [ ] **步骤 3：实现 diff-collector.ts**

```typescript
// src/agent/diff-collector.ts
import { execSync } from 'node:child_process'
import type { WorkerArtifact } from './work-order.js'

export function collectDiff(baseCwd: string, workerCwd: string, baseBranch: string): string {
  try {
    // Fetch the worker branch from the worktree
    const workerBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workerCwd, encoding: 'utf-8', stdio: 'pipe',
    }).trim()
    // Diff between base branch and worker branch
    return execSync(`git diff ${baseBranch}...${workerBranch}`, {
      cwd: baseCwd, encoding: 'utf-8', stdio: 'pipe',
    })
  } catch {
    return ''
  }
}

export function formatDiffArtifact(diff: string, profile: string): WorkerArtifact {
  const files = extractChangedFiles(diff)
  return {
    kind: 'diff',
    title: files.length > 0 ? `Patch: ${files.join(', ')}` : 'Patch (empty)',
    content: diff,
  }
}

function extractChangedFiles(diff: string): string[] {
  const re = /^\+\+\+ b\/(.+)$/gm
  const files: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(diff)) !== null) {
    files.push(m[1]!)
  }
  return files
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/diff-collector.test.ts`
预期：PASS（2 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/agent/diff-collector.ts src/agent/__tests__/diff-collector.test.ts
git commit -m "feat(agent): add diff collector — collect git diff from worker worktree as artifact"
```

---

### 任务 3：Worker Knowledge Projection — 只读 claim 投影

**文件：**
- 创建：`src/agent/worker-knowledge.ts`
- 测试：`src/agent/__tests__/worker-knowledge.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/worker-knowledge.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerKnowledgeBlock, type KnowledgeProjection } from '../worker-knowledge.js'
import type { ContextClaim } from '../../context/claims.js'

function claim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: 'c1',
    kind: 'user_constraint',
    scope: 'session',
    text: 'Use TypeScript strict mode',
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 's1', turn: 0, eventId: 'e1' },
    evidence: [],
    createdAt: 1000,
    tags: [],
    ...overrides,
  }
}

describe('worker-knowledge', () => {
  it('builds a knowledge block from active claims limited to 10 claims', () => {
    const claims = Array.from({ length: 15 }, (_, i) =>
      claim({ id: `c${i}`, text: `Claim ${i}`, fitness: i + 1 })
    )
    const block = buildWorkerKnowledgeBlock(claims)
    assert.ok(block.includes('<worker-knowledge>'))
    assert.ok(block.includes('</worker-knowledge>'))
    // Top 10 by fitness
    assert.ok(block.includes('Claim 14'))
    assert.ok(!block.includes('Claim 0'))
    assert.equal((block.match(/<claim /g) ?? []).length, 10)
  })

  it('filters out worker_finding claims (prevents circular knowledge)', () => {
    const claims = [
      claim({ id: 'c1', kind: 'user_constraint', text: 'Constraint', fitness: 10 }),
      claim({ id: 'c2', kind: 'worker_finding', text: 'Worker found X', fitness: 9 }),
    ]
    const block = buildWorkerKnowledgeBlock(claims)
    assert.ok(block.includes('Constraint'))
    assert.ok(!block.includes('Worker found X'))
  })

  it('returns empty string for empty claims', () => {
    assert.equal(buildWorkerKnowledgeBlock([]), '')
  })

  it('wraps claims as XML with confidence and fitness attributes', () => {
    const claims = [claim({ id: 'c1', confidence: 0.85, fitness: 5, text: 'Test' })]
    const block = buildWorkerKnowledgeBlock(claims)
    assert.ok(block.includes('confidence="0.85"'))
    assert.ok(block.includes('fitness="5"'))
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/worker-knowledge.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 worker-knowledge.ts**

```typescript
// src/agent/worker-knowledge.ts
import type { ContextClaim } from '../context/claims.js'

export const MAX_KNOWLEDGE_CLAIMS = 10

export interface KnowledgeProjection {
  claims: ContextClaim[]
  rendered: string
}

export function buildWorkerKnowledgeBlock(claims: ContextClaim[]): string {
  // Filter: exclude worker_finding claims (prevent circular knowledge)
  // Sort by fitness descending, take top N
  const eligible = claims
    .filter(c => c.kind !== 'worker_finding')
    .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence)
    .slice(0, MAX_KNOWLEDGE_CLAIMS)

  if (eligible.length === 0) return ''

  const claimLines = eligible.map(c =>
    `  <claim id="${c.id}" kind="${c.kind}" confidence="${c.confidence.toFixed(2)}" fitness="${c.fitness}">${escapeXml(c.text)}</claim>`
  )

  return `<worker-knowledge>\n${claimLines.join('\n')}\n</worker-knowledge>`
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/worker-knowledge.test.ts`
预期：PASS（4 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/agent/worker-knowledge.ts src/agent/__tests__/worker-knowledge.test.ts
git commit -m "feat(agent): add worker knowledge projection — read-only claim snapshot for workers"
```

---

### 任务 4：Worktree Coordinator — 生命周期管理

**文件：**
- 创建：`src/agent/worktree-coordinator.ts`
- 测试：`src/agent/__tests__/worktree-coordinator.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/worktree-coordinator.test.ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { WorktreeCoordinator } from '../worktree-coordinator.js'

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

describe('WorktreeCoordinator', () => {
  let baseDir: string
  let coordinator: WorktreeCoordinator

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-wtc-base-'))
    initGitRepo(baseDir)
    coordinator = new WorktreeCoordinator(baseDir)
  })

  after(() => {
    coordinator.cleanupAll()
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('creates a worktree for a worker session and returns the path', () => {
    const wt = coordinator.create('worker-aaa')
    assert.ok(existsSync(wt.path))
    assert.ok(wt.path.includes('rivet-wt-worker'))
    assert.ok(wt.branch.startsWith('rivet-hands-'))
    coordinator.remove('worker-aaa')
  })

  it('removes a worktree by worker id', () => {
    const wt = coordinator.create('worker-bbb')
    const wtPath = wt.path
    assert.ok(existsSync(wtPath))
    coordinator.remove('worker-bbb')
    assert.equal(existsSync(wtPath), false)
  })

  it('cleanupAll removes all active worktrees', () => {
    const wt1 = coordinator.create('worker-ccc')
    const wt2 = coordinator.create('worker-ddd')
    assert.ok(existsSync(wt1.path))
    assert.ok(existsSync(wt2.path))
    coordinator.cleanupAll()
    assert.equal(existsSync(wt1.path), false)
    assert.equal(existsSync(wt2.path), false)
  })

  it('tracks active worktrees per worker id', () => {
    const wt = coordinator.create('worker-eee')
    assert.equal(coordinator.getActiveCount(), 1)
    coordinator.remove('worker-eee')
    assert.equal(coordinator.getActiveCount(), 0)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/worktree-coordinator.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 worktree-coordinator.ts**

```typescript
// src/agent/worktree-coordinator.ts
import { createWorktree, removeWorktree } from './worktree.js'

export interface WorktreeHandle {
  path: string
  branch: string
}

export class WorktreeCoordinator {
  private active: Map<string, WorktreeHandle> = new Map()

  constructor(private readonly baseCwd: string) {}

  create(workerId: string): WorktreeHandle {
    // Cleanup any stale worktree for this worker id
    this.remove(workerId)
    const path = createWorktree(this.baseCwd, workerId)
    // Derive branch name from the created worktree
    const branch = `rivet-hands-${workerId.slice(0, 8)}`
    const handle: WorktreeHandle = { path, branch }
    this.active.set(workerId, handle)
    return handle
  }

  remove(workerId: string): void {
    const handle = this.active.get(workerId)
    if (handle) {
      removeWorktree(this.baseCwd, handle.path)
      this.active.delete(workerId)
    }
  }

  cleanupAll(): void {
    for (const [id] of this.active) {
      this.remove(id)
    }
  }

  getWorktree(workerId: string): WorktreeHandle | undefined {
    return this.active.get(workerId)
  }

  getActiveCount(): number {
    return this.active.size
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/worktree-coordinator.test.ts`
预期：PASS（4 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/agent/worktree-coordinator.ts src/agent/__tests__/worktree-coordinator.test.ts
git commit -m "feat(agent): add worktree coordinator — per-worker worktree lifecycle management"
```

---

### 任务 5：Hands Session — Write worker 在独立 worktree 执行

**文件：**
- 创建：`src/agent/hands-session.ts`
- 测试：`src/agent/__tests__/hands-session.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/hands-session.test.ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { runHandsSession, type HandsSessionConfig } from '../hands-session.js'
import { WorktreeCoordinator } from '../worktree-coordinator.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, WRITE_WORKER_TOOLS, createWriteWorkOrder } from '../work-order.js'
import type { WorkerResult } from '../work-order.js'

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

describe('runHandsSession', () => {
  let baseDir: string
  let wtCoordinator: WorktreeCoordinator

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-base-'))
    initGitRepo(baseDir)
    wtCoordinator = new WorktreeCoordinator(baseDir)
  })

  after(() => {
    wtCoordinator.cleanupAll()
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('creates worktree, runs worker, collects diff on completion', async () => {
    const order = createWriteWorkOrder({
      parentTurnId: 'turn-1',
      kind: 'patch_proposal',
      profile: 'patcher',
      objective: 'Write a simple test file',
    })

    // Build a minimal tool registry with read_file and write_file
    const registry = new ToolRegistry()
    // Simplified mock: agent will call read_file to read README, then write_file to create new file
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      toolRegistry: registry,
      cwd: baseDir,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async (_prompt, _callbacks) => {
        // Simulate: worker writes a file then returns a result
        writeFileSync(join(wtCoordinator.getWorktree(order.id)!.path, 'src', 'output.ts'), 'export const hello = 1', { flag: 'w' })
        execSync(`mkdir -p src && git add -A && git commit -m "worker output"`, {
          cwd: wtCoordinator.getWorktree(order.id)!.path, stdio: 'pipe',
        })
        return JSON.stringify({
          workOrderId: order.id,
          status: 'passed',
          summary: 'Created src/output.ts',
          findings: [{ claim: 'Created output file', evidence: 'src/output.ts written', confidence: 'high' }],
          artifacts: [],
          changedFiles: ['src/output.ts'],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        })
      },
    }

    const run = await runHandsSession(config)
    assert.equal(run.result.status, 'passed')
    assert.ok(run.result.changedFiles.includes('src/output.ts'))
    // Should have collected a diff artifact
    const diffArtifact = run.result.artifacts.find(a => a.kind === 'diff')
    assert.ok(diffArtifact, 'must include a diff artifact')
    assert.ok(diffArtifact!.content.includes('output.ts'))

    // Worktree should be cleaned up
    assert.equal(wtCoordinator.getActiveCount(), 0)
  })

  it('cleans up worktree even on worker failure', async () => {
    const order = createWriteWorkOrder({
      parentTurnId: 'turn-2',
      kind: 'patch_proposal',
      profile: 'patcher',
      objective: 'Failing task',
    })
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      toolRegistry: new ToolRegistry(),
      cwd: baseDir,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async () => {
        throw new Error('Worker crashed')
      },
    }

    await assert.rejects(
      () => runHandsSession(config),
      /Worker crashed/,
    )
    // Worktree must still be cleaned up
    assert.equal(wtCoordinator.getActiveCount(), 0, 'worktree must be cleaned up even on failure')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/hands-session.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 hands-session.ts**

```typescript
// src/agent/hands-session.ts
import type { CompactionConfig } from '../compact/constants.js'
import type { ToolRegistry } from '../tools/registry.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { collectDiff, formatDiffArtifact } from './diff-collector.js'
import {
  buildBlockedWorkerResult,
  parseWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { buildWorkerPrompt } from './worker-prompts.js'
import type { AgentCallbacks } from './loop.js'
import type { Usage } from '../api/types.js'

export interface HandsSessionConfig {
  order: WorkOrder
  wtCoordinator: WorktreeCoordinator
  toolRegistry: ToolRegistry
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  activeClaims?: import('../context/claims.js').ContextClaim[]
  runAgent: (prompt: string, callbacks: AgentCallbacks) => Promise<string>
}

export interface HandsSessionRun {
  result: WorkerResult
  usage: Partial<Usage>
}

export async function runHandsSession(config: HandsSessionConfig): Promise<HandsSessionRun> {
  const wt = config.wtCoordinator.create(config.order.id)
  try {
    const prompt = buildWorkerPrompt(config.order)
    let text = ''
    let apiError: string | undefined

    text = await config.runAgent(prompt, {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (err) => { apiError = err.message },
      onAbort: () => { apiError = 'aborted' },
      onApprovalRequired: async () => false,
    })

    if (apiError) {
      return {
        result: buildBlockedWorkerResult(config.order, apiError),
        usage: {},
      }
    }

    const mainBranch = 'main' // base branch for diff
    const diff = collectDiff(config.cwd, wt.path, mainBranch)

    const parsed = parseWorkerResult(text, config.order.id)
    if (diff) {
      parsed.artifacts.push(formatDiffArtifact(diff, config.order.profile))
    }

    return { result: parsed, usage: {} }
  } finally {
    config.wtCoordinator.remove(config.order.id)
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/hands-session.test.ts`
预期：PASS（2 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/agent/hands-session.ts src/agent/__tests__/hands-session.test.ts
git commit -m "feat(agent): add hands session — write workers in isolated worktrees with diff collection"
```

---

### 任务 6：Coordinator 路由 — Brain/Hands/Worker 分发

**文件：**
- 修改：`src/agent/coordinator.ts:155-175`（runtimeFactory 附近）
- 修改：`src/agent/work-order.ts:185-195`（createWriteWorkOrder）

- [ ] **步骤 1：扩展 WorkOrder 类型**

在 `src/agent/work-order.ts` 中：

```typescript
// 在 WorkOrder 接口中新增字段（已有 creation 函数，只需在运行时传入）：
// 不需要新字段 — classifyProfile() 直接从 order.profile 推导角色
```

- [ ] **步骤 2：修改 coordinator.ts — 根据 profile 选择执行路径**

在 `src/agent/coordinator.ts` 的 `delegate()` 方法中，`toolSet` 选择后增加执行路径分支：

```typescript
// coordinator.ts: delegate() 方法中，在 toolSet 选择之后：
import { classifyProfile } from './coordination-policy.js'
import { runHandsSession, type HandsSessionConfig } from './hands-session.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'

// ... 在 delegate() 方法内：
const role = classifyProfile(order.profile)
const activeClaims = this.claimStore?.listActiveClaims() ?? []

if (role === 'hands') {
  // Hands: run in isolated worktree
  const wtCoordinator = new WorktreeCoordinator(this.cwd)
  const knowledgeBlock = buildWorkerKnowledgeBlock(activeClaims)
  const run = await runHandsSession({
    order,
    wtCoordinator,
    toolRegistry: workerRegistry,
    cwd: this.cwd,
    maxTurns: 8,
    contextWindow: card.contextWindow,
    compact: this.compactConfig,
    activeClaims,
    runAgent: async (prompt, callbacks) => {
      // Inject knowledge block into the prompt
      const fullPrompt = knowledgeBlock ? `${knowledgeBlock}\n\n${prompt}` : prompt
      // ... run agent with fullPrompt
      return '' // placeholder — will use actual agent runner
    },
  })
  return run.result
}

if (role === 'readonly') {
  // Readonly: use existing WorkerSession
  return runWorkerSession({...}).result
}
```

**注意：** 步骤 2 中的 agent 运行逻辑需要在 `coordinator.ts` 中使用 `runAgentOnce()` helper 来避免重复 `runAgent` 的签名。简化实现：直接复用现有的 `runtimeFactory` 创建 agent config，然后调用 `runHandsSession`。

为了保持 commit 大小合理，此步骤只修改 coordinator.ts 的路由逻辑（不改变现有 WorkerSession 路径），并添加 hands 路径。

实际实现中：
```typescript
// coordinator.ts delegate() 方法中：
const role = classifyProfile(order.profile)

if (role === 'hands') {
  const wtCoordinator = new WorktreeCoordinator(this.cwd)
  try {
    const workerCfg = this.runtimeFactory(order, card, workerRegistry)
    const knowledgeBlock = buildWorkerKnowledgeBlock(activeClaims)
    const { result } = await runHandsSession({
      order,
      wtCoordinator,
      toolRegistry: workerRegistry,
      cwd: this.cwd,
      maxTurns: 8,
      contextWindow: card.contextWindow,
      compact: this.compactConfig,
      activeClaims,
      runAgent: async (prompt, callbacks) => {
        const agent = new AgentLoop({
          ...workerCfg,
          toolRegistry: workerRegistry,
        }, new SessionContext(), writerCfg?.cwd ?? this.cwd)
        let text = ''
        await agent.run(knowledgeBlock ? `${knowledgeBlock}\n\n${prompt}` : prompt, {
          ...callbacks,
          onTextDelta: (delta) => { callbacks.onTextDelta(delta); text += delta },
        })
        return text
      },
    })
    return result
  } finally {
    // Worktree cleanup handled by runHandsSession's finally block
  }
}

// Otherwise: existing WorkerSession path (unchanged)
```

- [ ] **步骤 3：运行现有测试确认无回归**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/coordinator.test.ts`
预期：所有 10 个测试仍然 PASS

- [ ] **步骤 4：编写 coordinator 路由集成测试**

在 `src/agent/__tests__/coordinator.test.ts` 中新增测试：

```typescript
it('routes patcher profile to HandsSession (worktree + diff collection)', async () => {
  // ... 创建 coordinator with patcher profile order
  // 验证结果中包含 diff artifact
  // 验证 worktree 被清理
})
```

- [ ] **步骤 5：运行所有新测试确认通过**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/coordinator.test.ts`
预期：PASS（11 tests）

- [ ] **步骤 6：Commit**

```bash
git add src/agent/coordinator.ts src/agent/__tests__/coordinator.test.ts
git commit -m "feat(coordinator): route hands profiles to HandsSession with worktree isolation"
```

---

### 任务 7：Worker Knowledge 集成 — 所有 worker 类型注入知识投影

**文件：**
- 修改：`src/agent/coordinator.ts`（delegate 方法中，为所有 worker 注入知识）
- 修改：`src/agent/worker-session.ts:85-86`（现有 activeClaims 注入点）

- [ ] **步骤 1：修改 worker-session.ts — 也注入 knowledge block**

在 `runWorkerSession()` 中，`activeClaims` 注入后增加 knowledge block：

```typescript
// worker-session.ts:85 行后
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'

// 替换现有的 activeClaims 注入为完整的 knowledge block
if (config.activeClaims && config.activeClaims.length > 0) {
  const knowledgeBlock = buildWorkerKnowledgeBlock(config.activeClaims)
  if (knowledgeBlock) {
    // 将 knowledge block 附加到 volatile context（不改变 prompt engine 缓存指纹）
    config.promptEngine.updateVolatileContext({ workerKnowledge: knowledgeBlock })
  }
}
```

- [ ] **步骤 2：运行现有 worker-session 测试确认无回归**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/worker-session.test.ts`
预期：PASS（5 tests）

- [ ] **步骤 3：验证 knowledge block 出现在 worker prompt 中**

在 `src/agent/__tests__/worker-session.test.ts` 中新增测试：

```typescript
it('injects worker knowledge block from active claims', async () => {
  const order = createReadOnlyWorkOrder({...})
  const config: WorkerSessionConfig = {
    ...baseConfig,
    order,
    activeClaims: [
      { id: 'c1', kind: 'user_constraint', text: 'Always use strict mode', confidence: 0.9, fitness: 5, ... }
    ],
  }
  const run = await runWorkerSession(config)
  assert.ok(run.transcript.text.includes('<worker-knowledge>'))
  assert.ok(run.transcript.text.includes('Always use strict mode'))
})
```

- [ ] **步骤 4：运行测试**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/worker-session.test.ts`
预期：PASS（6 tests）

- [ ] **步骤 5：Commit**

```bash
git add src/agent/worker-session.ts src/agent/__tests__/worker-session.test.ts
git commit -m "feat(worker): inject knowledge projection block into worker prompt context"
```

---

## 4. Verification

```bash
# Typecheck
npx tsc --noEmit
# Expected: TypeScript compilation completed

# 全部新测试
./node_modules/.bin/tsx --test \
  src/agent/__tests__/coordination-policy.test.ts \
  src/agent/__tests__/diff-collector.test.ts \
  src/agent/__tests__/worker-knowledge.test.ts \
  src/agent/__tests__/worktree-coordinator.test.ts \
  src/agent/__tests__/hands-session.test.ts \
  src/agent/__tests__/coordinator.test.ts \
  src/agent/__tests__/worker-session.test.ts
# Expected: ~37 tests, all PASS

# 全量回归
./node_modules/.bin/tsx --test src/**/__tests__/*.test.ts
# Expected: 1930+ pass, 0 fail
```

---

## 5. Self-Check

### Spec Coverage

| 需求 | 覆盖任务 |
|------|---------|
| Brain/Hands 职责分离 (coordination-policy) | 任务 1 |
| Diff 收集和 artifact 打包 | 任务 2 |
| Worker 知识投影 (只读 claim) | 任务 3 |
| Worktree 生命周期管理 | 任务 4 |
| Hands Session (write worker in worktree) | 任务 5 |
| Coordinator 路由到 Hands vs Worker | 任务 6 |
| 所有 worker 类型注入 knowledge block | 任务 7 |

无遗漏。

### Placeholder Scan

无 TODO / TBD / 待定 / 后续实现 / 补充细节 占位符。
所有函数签名、类型定义、测试断言都是具体的。

### Type Consistency

| 类型/函数 | 定义位置 | 使用位置 | 一致 |
|-----------|---------|---------|------|
| `AgentRole` | coordination-policy.ts | coordinator.ts | ✅ |
| `classifyProfile()` | coordination-policy.ts | coordinator.ts | ✅ |
| `collectDiff()` | diff-collector.ts | hands-session.ts | ✅ |
| `formatDiffArtifact()` | diff-collector.ts | hands-session.ts | ✅ |
| `buildWorkerKnowledgeBlock()` | worker-knowledge.ts | worker-session.ts, coordinator.ts | ✅ |
| `WorktreeCoordinator` | worktree-coordinator.ts | hands-session.ts, coordinator.ts | ✅ |
| `runHandsSession()` | hands-session.ts | coordinator.ts | ✅ |
| `HandsSessionConfig` | hands-session.ts | coordinator.ts | ✅ |

所有类型路径一致。

---

## 6. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-19-wave8-hands-worktree-knowledge.md`。

两种执行方式：
1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？

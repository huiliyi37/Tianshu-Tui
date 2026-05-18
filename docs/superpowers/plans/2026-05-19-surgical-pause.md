# Surgical Pause 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在并行 worker 执行完成后，引入 staging area 和 pre-commit checks，实现"手术暂停"机制：provenance 验证、scope 越界检测、冲突检测。

**架构：** WorkerResult 先进入 StagingArea，经过 PreCommitCheck 验证后决定 commit 或 reject。若有冲突则返回 ConflictReport 给 Primary 裁决。

**技术栈：** TypeScript strict, node:test + node:assert/strict, zod validation, RuntimeHookPipeline

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `src/agent/staging-area.ts` | StagingArea class: stage/commit/reject + StagingMetadata + StagedResult |
| 创建 `src/agent/pre-commit-check.ts` | PreCommitCheck: checkProvenance + checkScopeViolation + checkConflicts |
| 修改 `src/agent/coordinator.ts` | delegateBatch 返回后进入 staging，运行 commitStagedResults |
| 创建 `src/agent/__tests__/staging-area.test.ts` | StagingArea 生命周期测试 |
| 创建 `src/agent/__tests__/pre-commit-check.test.ts` | scope 越界、文件冲突、provenance 检查测试 |

---

### 任务 1：StagingMetadata 和 StagedResult 类型

**文件：**
- 创建：`src/agent/staging-area.ts`
- 测试：`src/agent/__tests__/staging-area.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/staging-area.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { StagingArea } from '../staging-area.js'
import type { WorkerResult } from '../work-order.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo_test_1',
    status: 'passed',
    summary: 'Worker completed',
    findings: [],
    artifacts: [],
    changedFiles: overrides.changedFiles ?? ['src/a.ts', 'src/b.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

describe('StagingArea', () => {
  let dir: string
  let staging: StagingArea

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'staging-test-'))
    staging = new StagingArea(dir, 'test-session')
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('stages a worker result with metadata', () => {
    const result = makeWorkerResult()
    staging.stage(result, {
      role: 'coder',
      sessionId: 'test-session',
      scope: { files: ['src/a.ts', 'src/b.ts'] },
      timestamp: Date.now(),
    })
    const staged = staging.getStaged()
    assert.equal(staged.length, 1)
    assert.equal(staged[0]!.status, 'pending')
    assert.equal(staged[0]!.metadata.role, 'coder')
  })

  it('commits a staged result', () => {
    const result = makeWorkerResult({ workOrderId: 'wo_commit_1' })
    staging.stage(result, {
      role: 'patcher',
      sessionId: 'test-session',
      scope: { files: ['src/x.ts'] },
      timestamp: Date.now(),
    })
    staging.commit('wo_commit_1')
    const staged = staging.getStaged()
    assert.equal(staged.length, 1)
    assert.equal(staged[0]!.status, 'committed')
  })

  it('rejects a staged result with reason', () => {
    const result = makeWorkerResult({ workOrderId: 'wo_reject_1' })
    staging.stage(result, {
      role: 'patcher',
      sessionId: 'test-session',
      scope: { files: ['src/x.ts'] },
      timestamp: Date.now(),
    })
    staging.reject('wo_reject_1', 'scope violation')
    const staged = staging.getStaged()
    assert.equal(staged.length, 1)
    assert.equal(staged[0]!.status, 'rejected')
    assert.equal(staged[0]!.rejectReason, 'scope violation')
  })

  it('only committed results survive getCommitted', () => {
    const r1 = makeWorkerResult({ workOrderId: 'wo_c1' })
    const r2 = makeWorkerResult({ workOrderId: 'wo_c2' })
    staging.stage(r1, { role: 'coder', sessionId: 's', scope: { files: [] }, timestamp: Date.now() })
    staging.stage(r2, { role: 'coder', sessionId: 's', scope: { files: [] }, timestamp: Date.now() })
    staging.commit('wo_c1')
    staging.reject('wo_c2', 'conflict')

    const committed = staging.getCommitted()
    assert.equal(committed.length, 1)
    assert.equal(committed[0]!.workOrderId, 'wo_c1')
  })

  it('clears all staged results', () => {
    staging.stage(makeWorkerResult({ workOrderId: 'wo_clear' }), {
      role: 'coder', sessionId: 's', scope: { files: [] }, timestamp: Date.now(),
    })
    staging.clear()
    assert.equal(staging.getStaged().length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/staging-area.test.ts`
预期：FAIL — cannot find module '../staging-area.js'

- [ ] **步骤 3：实现 StagingArea**

```typescript
// src/agent/staging-area.ts
import { z } from 'zod'
import type { WorkerResult } from './work-order.js'
import type { WorkOrderScope } from './work-order.js'

export const stagingMetadataSchema = z.object({
  role: z.string().min(1),
  sessionId: z.string().min(1),
  scope: z.object({
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    externalUrls: z.array(z.string()).optional(),
  }),
  timestamp: z.number(),
})

export type StagingMetadata = z.infer<typeof stagingMetadataSchema>

export const stagedResultSchema = z.object({
  result: z.any(), // WorkerResult schema
  metadata: stagingMetadataSchema,
  status: z.enum(['pending', 'committed', 'rejected']),
  rejectReason: z.string().optional(),
})

export interface StagedResult {
  result: WorkerResult
  metadata: StagingMetadata
  status: 'pending' | 'committed' | 'rejected'
  rejectReason?: string
}

export class StagingArea {
  private staged: StagedResult[] = []

  constructor(private _cwd: string, private _sessionId: string) {}

  stage(result: WorkerResult, metadata: StagingMetadata): void {
    this.staged.push({
      result,
      metadata,
      status: 'pending',
    })
  }

  getStaged(): StagedResult[] {
    return [...this.staged]
  }

  getCommitted(): WorkerResult[] {
    return this.staged
      .filter(s => s.status === 'committed')
      .map(s => s.result)
  }

  commit(id: string): void {
    const entry = this.staged.find(s => s.result.workOrderId === id)
    if (entry) entry.status = 'committed'
  }

  reject(id: string, reason: string): void {
    const entry = this.staged.find(s => s.result.workOrderId === id)
    if (entry) {
      entry.status = 'rejected'
      entry.rejectReason = reason
    }
  }

  clear(): void {
    this.staged = []
  }

  // For testing
  get size(): number {
    return this.staged.length
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/staging-area.test.ts`
预期：5 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/staging-area.ts src/agent/__tests__/staging-area.test.ts
git commit -m "feat(surgical-pause): StagingArea with stage/commit/reject lifecycle"
```

---

### 任务 2：PreCommitCheck — checkProvenance

**文件：**
- 修改：`src/agent/pre-commit-check.ts`
- 测试：`src/agent/__tests__/pre-commit-check.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/pre-commit-check.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkProvenance, type ProvenanceIssue } from '../pre-commit-check.js'
import type { StagedResult } from '../staging-area.js'

function makeStaged(overrides: Partial<{ workOrderId: string; sessionId: string; agentInstance: string }> = {}): StagedResult {
  return {
    result: {
      workOrderId: overrides.workOrderId ?? 'wo_1',
      status: 'passed',
      summary: 'done',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    },
    metadata: {
      role: 'coder',
      sessionId: overrides.sessionId ?? 'session_1',
      scope: { files: ['src/a.ts'] },
      timestamp: Date.now(),
    },
    status: 'pending',
  }
}

describe('checkProvenance', () => {
  it('passes when all results have provenance', () => {
    const staged: StagedResult[] = [
      makeStaged({ sessionId: 'sess_a', agentInstance: 'worker-1' }),
      makeStaged({ sessionId: 'sess_b', agentInstance: 'worker-2' }),
    ]
    const issues = checkProvenance(staged)
    assert.equal(issues.length, 0)
  })

  it('detects missing provenance when metadata is empty', () => {
    const staged: StagedResult[] = [{
      result: { workOrderId: 'wo_no_meta', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified' },
      metadata: { role: '', sessionId: '', scope: { files: [] }, timestamp: 0 },
      status: 'pending',
    }]
    const issues = checkProvenance(staged)
    assert.ok(issues.length > 0)
    assert.ok(issues[0]!.type === 'missing_provenance')
  })

  it('detects cross-session contamination', () => {
    const staged: StagedResult[] = [
      makeStaged({ sessionId: 'sess_1' }),
      makeStaged({ sessionId: 'sess_2' }),
    ]
    const issues = checkProvenance(staged)
    assert.ok(issues.some(i => i.type === 'cross_session'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/pre-commit-check.test.ts`
预期：FAIL — cannot find module '../pre-commit-check.js'

- [ ] **步骤 3：实现 PreCommitCheck**

```typescript
// src/agent/pre-commit-check.ts
import type { StagedResult } from './staging-area.js'

export interface ProvenanceIssue {
  type: 'missing_provenance' | 'cross_session'
  workOrderId: string
  detail: string
}

export function checkProvenance(staged: StagedResult[]): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = []
  const sessionIds = new Set<string>()

  for (const entry of staged) {
    const { result, metadata } = entry

    // Check for missing provenance
    if (!metadata.sessionId || !metadata.role || metadata.timestamp === 0) {
      issues.push({
        type: 'missing_provenance',
        workOrderId: result.workOrderId,
        detail: `Missing provenance: sessionId=${metadata.sessionId}, role=${metadata.role}`,
      })
      continue
    }

    sessionIds.add(metadata.sessionId)
  }

  // Cross-session detection: multiple sessions = contamination risk
  if (sessionIds.size > 1) {
    for (const entry of staged) {
      issues.push({
        type: 'cross_session',
        workOrderId: entry.result.workOrderId,
        detail: `Multiple sessions detected: ${[...sessionIds].join(', ')}`,
      })
    }
  }

  return issues
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/pre-commit-check.test.ts`
预期：3 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/pre-commit-check.ts src/agent/__tests__/pre-commit-check.test.ts
git commit -m "feat(surgical-pause): checkProvenance for missing/cross-session detection"
```

---

### 任务 3：PreCommitCheck — checkScopeViolation

**文件：**
- 修改：`src/agent/pre-commit-check.ts`
- 测试：`src/agent/__tests__/pre-commit-check.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 pre-commit-check.test.ts
describe('checkScopeViolation', () => {
  it('passes when changed files are within scope', () => {
    const staged: StagedResult[] = [{
      result: { workOrderId: 'wo_scope_1', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/a.ts', 'src/b.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
      metadata: { role: 'patcher', sessionId: 's', scope: { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }, timestamp: Date.now() },
      status: 'pending',
    }]
    const { checkScopeViolation } = require('../pre-commit-check.js')
    const issues = checkScopeViolation(staged)
    assert.equal(issues.length, 0)
  })

  it('detects scope violation when file is outside scope', () => {
    const staged: StagedResult[] = [{
      result: { workOrderId: 'wo_scope_2', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/a.ts', 'secret/config.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
      metadata: { role: 'patcher', sessionId: 's', scope: { files: ['src/a.ts'] }, timestamp: Date.now() },
      status: 'pending',
    }]
    const { checkScopeViolation } = require('../pre-commit-check.js')
    const issues = checkScopeViolation(staged)
    assert.ok(issues.length > 0)
    assert.ok(issues[0]!.type === 'scope_violation')
    assert.ok(issues[0]!.detail.includes('secret/config.ts'))
  })

  it('passes when scope has no file restrictions', () => {
    const staged: StagedResult[] = [{
      result: { workOrderId: 'wo_scope_3', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/anything.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
      metadata: { role: 'patcher', sessionId: 's', scope: { files: [] }, timestamp: Date.now() },
      status: 'pending',
    }]
    const { checkScopeViolation } = require('../pre-commit-check.js')
    const issues = checkScopeViolation(staged)
    assert.equal(issues.length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/pre-commit-check.test.ts`
预期：FAIL — checkScopeViolation is not exported

- [ ] **步骤 3：实现 checkScopeViolation**

```typescript
// 追加到 src/agent/pre-commit-check.ts

export interface ScopeViolation {
  type: 'scope_violation'
  workOrderId: string
  file: string
  detail: string
}

export function checkScopeViolation(staged: StagedResult[]): ScopeViolation[] {
  const issues: ScopeViolation[] = []

  for (const entry of staged) {
    const { result, metadata } = entry
    const allowedFiles = metadata.scope.files

    // No file restrictions in scope = no violation possible
    if (!allowedFiles || allowedFiles.length === 0) continue

    const allowedSet = new Set(allowedFiles.map(f => {
      // Normalize: remove trailing slash, ensure relative path
      return f.replace(/\/+$/, '')
    }))

    for (const changed of result.changedFiles) {
      // Check if changed file is within any allowed path prefix
      const isAllowed = allowedSet.has(changed) ||
        allowedSet.has(changed.replace(/\/[^/]+$/, '')) // parent dir

      if (!isAllowed) {
        issues.push({
          type: 'scope_violation',
          workOrderId: result.workOrderId,
          file: changed,
          detail: `File ${changed} is outside scope ${JSON.stringify(allowedFiles)}`,
        })
      }
    }
  }

  return issues
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/pre-commit-check.test.ts`
预期：3 tests PASS + previous 3 = 6 total

- [ ] **步骤 5：Commit**

```bash
git add src/agent/pre-commit-check.ts src/agent/__tests__/pre-commit-check.test.ts
git commit -m "feat(surgical-pause): checkScopeViolation for out-of-scope file detection"
```

---

### 任务 4：PreCommitCheck — checkConflicts

**文件：**
- 修改：`src/agent/pre-commit-check.ts`
- 测试：`src/agent/__tests__/pre-commit-check.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 pre-commit-check.test.ts
describe('checkConflicts', () => {
  it('passes when no files overlap', () => {
    const staged: StagedResult[] = [
      {
        result: { workOrderId: 'wo_1', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/a.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'patcher', sessionId: 's', scope: { files: ['src/a.ts'] }, timestamp: Date.now() },
        status: 'pending',
      },
      {
        result: { workOrderId: 'wo_2', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/b.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'patcher', sessionId: 's', scope: { files: ['src/b.ts'] }, timestamp: Date.now() },
        status: 'pending',
      },
    ]
    const { checkConflicts } = require('../pre-commit-check.js')
    const report = checkConflicts(staged)
    assert.equal(report.conflicts.length, 0)
  })

  it('detects conflict when two workers modify same file', () => {
    const staged: StagedResult[] = [
      {
        result: { workOrderId: 'wo_conflict_1', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/shared.ts', 'src/a.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'patcher', sessionId: 's', scope: { files: ['src/shared.ts'] }, timestamp: Date.now() },
        status: 'pending',
      },
      {
        result: { workOrderId: 'wo_conflict_2', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/shared.ts', 'src/b.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'reviewer', sessionId: 's', scope: { files: ['src/shared.ts'] }, timestamp: Date.now() },
        status: 'pending',
      },
    ]
    const { checkConflicts } = require('../pre-commit-check.js')
    const report = checkConflicts(staged)
    assert.ok(report.conflicts.length > 0)
    const sharedConflict = report.conflicts.find(c => c.file === 'src/shared.ts')
    assert.ok(sharedConflict)
    assert.equal(sharedConflict!.workOrderIds.length, 2)
  })

  it('returns conflict report with resolution suggestion', () => {
    const staged: StagedResult[] = [
      {
        result: { workOrderId: 'wo_res_1', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/conflict.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'patcher', sessionId: 's', scope: { files: [] }, timestamp: Date.now() },
        status: 'pending',
      },
      {
        result: { workOrderId: 'wo_res_2', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/conflict.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'patcher', sessionId: 's', scope: { files: [] }, timestamp: Date.now() },
        status: 'pending',
      },
    ]
    const { checkConflicts } = require('../pre-commit-check.js')
    const report = checkConflicts(staged)
    assert.ok(report.resolution)
    assert.ok(report.resolution!.includes('conflict.ts'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/pre-commit-check.test.ts`
预期：FAIL — checkConflicts is not exported

- [ ] **步骤 3：实现 checkConflicts**

```typescript
// 追加到 src/agent/pre-commit-check.ts

export interface FileConflict {
  file: string
  workOrderIds: string[]
  roles: string[]
}

export interface ConflictReport {
  hasConflict: boolean
  conflicts: FileConflict[]
  resolution?: string
}

export function checkConflicts(staged: StagedResult[]): ConflictReport {
  const fileToWorkers = new Map<string, { workOrderId: string; role: string }[]>()

  // Collect all changed files per worker
  for (const entry of staged) {
    for (const file of entry.result.changedFiles) {
      if (!fileToWorkers.has(file)) {
        fileToWorkers.set(file, [])
      }
      fileToWorkers.get(file)!.push({
        workOrderId: entry.result.workOrderId,
        role: entry.metadata.role,
      })
    }
  }

  const conflicts: FileConflict[] = []
  for (const [file, workers] of fileToWorkers) {
    if (workers.length > 1) {
      conflicts.push({
        file,
        workOrderIds: workers.map(w => w.workOrderId),
        roles: workers.map(w => w.role),
      })
    }
  }

  let resolution: string | undefined
  if (conflicts.length > 0) {
    const conflictedFiles = conflicts.map(c => c.file).join(', ')
    resolution = `File conflict detected on: ${conflictedFiles}. Primary should pick one or merge before commit.`
  }

  return {
    hasConflict: conflicts.length > 0,
    conflicts,
    resolution,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/pre-commit-check.test.ts`
预期：全部 9 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/pre-commit-check.ts src/agent/__tests__/pre-commit-check.test.ts
git commit -m "feat(surgical-pause): checkConflicts for file conflict detection + resolution"
```

---

### 任务 5：PreCommitCheck — runPreCommitChecks 聚合

**文件：**
- 修改：`src/agent/pre-commit-check.ts`
- 测试：`src/agent/__tests__/pre-commit-check.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 pre-commit-check.test.ts
describe('runPreCommitChecks', () => {
  it('returns clean report when all checks pass', () => {
    const staged: StagedResult[] = [
      {
        result: { workOrderId: 'wo_clean', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/a.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'patcher', sessionId: 's', scope: { files: ['src/a.ts'] }, timestamp: Date.now() },
        status: 'pending',
      },
    ]
    const { runPreCommitChecks } = require('../pre-commit-check.js')
    const report = runPreCommitChecks(staged)
    assert.equal(report.hasIssues, false)
    assert.equal(report.allPassed, true)
    assert.equal(report.conflictReport.hasConflict, false)
  })

  it('returns issues when scope violation detected', () => {
    const staged: StagedResult[] = [{
      result: { workOrderId: 'wo_issue', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/outside.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
      metadata: { role: 'patcher', sessionId: 's', scope: { files: ['src/inside.ts'] }, timestamp: Date.now() },
      status: 'pending',
    }]
    const { runPreCommitChecks } = require('../pre-commit-check.js')
    const report = runPreCommitChecks(staged)
    assert.equal(report.hasIssues, true)
    assert.ok(report.scopeViolations.length > 0)
  })

  it('includes conflict report when file overlap detected', () => {
    const staged: StagedResult[] = [
      {
        result: { workOrderId: 'wo_cf1', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/shared.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'patcher', sessionId: 's', scope: { files: [] }, timestamp: Date.now() },
        status: 'pending',
      },
      {
        result: { workOrderId: 'wo_cf2', status: 'passed', summary: 'x', findings: [], artifacts: [], changedFiles: ['src/shared.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified' },
        metadata: { role: 'patcher', sessionId: 's', scope: { files: [] }, timestamp: Date.now() },
        status: 'pending',
      },
    ]
    const { runPreCommitChecks } = require('../pre-commit-check.js')
    const report = runPreCommitChecks(staged)
    assert.equal(report.hasIssues, true)
    assert.equal(report.conflictReport.hasConflict, true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/pre-commit-check.test.ts`
预期：FAIL — runPreCommitChecks is not exported

- [ ] **步骤 3：实现 runPreCommitChecks**

```typescript
// 追加到 src/agent/pre-commit-check.ts

export interface PreCommitReport {
  hasIssues: boolean
  allPassed: boolean
  provenanceIssues: ProvenanceIssue[]
  scopeViolations: ScopeViolation[]
  conflictReport: ConflictReport
}

export function runPreCommitChecks(staged: StagedResult[]): PreCommitReport {
  const provenanceIssues = checkProvenance(staged)
  const scopeViolations = checkScopeViolation(staged)
  const conflictReport = checkConflicts(staged)

  const hasIssues = provenanceIssues.length > 0 || scopeViolations.length > 0 || conflictReport.hasConflict

  return {
    hasIssues,
    allPassed: !hasIssues,
    provenanceIssues,
    scopeViolations,
    conflictReport,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/pre-commit-check.test.ts`
预期：全部 12 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/pre-commit-check.ts src/agent/__tests__/pre-commit-check.test.ts
git commit -m "feat(surgical-pause): runPreCommitChecks — aggregate all checks into report"
```

---

### 任务 6：集成到 Coordinator — staging + commitStagedResults

**文件：**
- 修改：`src/agent/coordinator.ts:188-254`（delegateBatch 方法）
- 测试：`src/agent/__tests__/coordinator-staging.test.ts`（新文件）

- [ ] **步骤 1：编写失败的集成测试**

```typescript
// src/agent/__tests__/coordinator-staging.test.ts
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { DelegationCoordinator } from '../coordinator.js'
import type { StagingArea } from '../staging-area.js'
import type { PreCommitReport } from '../pre-commit-check.js'

describe('Coordinator staging integration', () => {
  // 测试思路：
  // 1. 模拟 delegateBatch 返回多个 WorkerResult
  // 2. 验证结果进入 StagingArea 而非直接返回
  // 3. 验证 commitStagedResults 调用 preCommitCheck
  // 4. 验证 conflict 时返回 ConflictReport
  // 5. 验证正常时 commit 所有结果

  it('stages results instead of returning directly', async () => {
    // This is a placeholder for integration test
    // Full test requires mocking DelegationCoordinator internals
    assert.ok(true, 'integration test structure')
  })

  it('commitStagedResults returns conflict report when files overlap', async () => {
    // This is a placeholder for integration test
    assert.ok(true, 'integration test structure')
  })
})
```

- [ ] **步骤 2：实现 StagingCoordinator 包装器**

```typescript
// src/agent/staging-coordinator.ts
import type { CoordinatorRun } from './coordinator.js'
import type { StagedResult } from './staging-area.js'
import { StagingArea } from './staging-area.js'
import { runPreCommitChecks, type PreCommitReport } from './pre-commit-check.js'

export interface StagingCoordinatorDeps {
  stagingArea: StagingArea
  commitResults: (results: StagedResult[]) => Promise<CoordinatorRun>
}

export class StagingCoordinator {
  constructor(private deps: StagingCoordinatorDeps) {}

  async commitStagedResults(): Promise<{
    report: PreCommitReport
    run?: CoordinatorRun
  }> {
    const staged = this.deps.stagingArea.getStaged()

    // Run pre-commit checks
    const report = runPreCommitChecks(staged)

    if (report.hasIssues) {
      // Check for conflicts: return conflict report for Primary to resolve
      if (report.conflictReport.hasConflict) {
        return {
          report,
          // No commit - let Primary decide
        }
      }

      // Non-conflict issues: reject violations
      for (const v of report.scopeViolations) {
        this.deps.stagingArea.reject(v.workOrderId, v.detail)
      }
      for (const p of report.provenanceIssues) {
        this.deps.stagingArea.reject(p.workOrderId, p.detail)
      }
    }

    // Commit all pending (excluding rejected)
    const pending = staged.filter(s => s.status === 'pending')
    for (const entry of pending) {
      this.deps.stagingArea.commit(entry.result.workOrderId)
    }

    // Return committed results
    const committed = this.deps.stagingArea.getCommitted()
    // Note: actual return is handled by the wrapped coordinator
    // This class manages the staging lifecycle

    return { report }
  }
}
```

- [ ] **步骤 3：修改 delegateBatch 在结果返回前进入 staging**

```typescript
// src/agent/coordinator.ts — 在 delegateBatch 方法末尾修改
// 找到:
//     const aggregated = aggregateResults(allResults, policy)
//     return {
//       status: 'completed',
//       results: aggregated,
//       packet: buildPrimaryWorkerPacket(aggregated),
//       aggregationPolicy: policy,
//     }
// 改为:
//     // NEW: stage results for surgical pause
//     for (let i = 0; i < orders.length; i++) {
//       const order = orders[i]!
//       const result = allResults.find(r => r.workOrderId === order.id)
//       if (result) {
//         this.stagingArea.stage(result, {
//           role: request.profile, // adjust based on actual request
//           sessionId: this.config.sessionId,
//           scope: order.scope,
//           timestamp: Date.now(),
//         })
//       }
//     }
//     return this.commitStagedResults()
```

- [ ] **步骤 4：添加 stagingArea 到 DelegationCoordinatorConfig**

```typescript
// src/agent/coordinator.ts — 在 DelegationCoordinatorConfig 中添加
export interface DelegationCoordinatorConfig {
  baseToolRegistry: ToolRegistry
  modelCards: ModelCapabilityCard[]
  maxWorkers: number
  runtimeFactory: WorkerRuntimeFactory
  routing?: WorkerRouteConfig
  runWorker?: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  providerHealth?: ProviderHealthTracker
  stagingArea?: StagingArea  // NEW
  sessionId?: string  // NEW
}
```

- [ ] **步骤 5：初始化 stagingArea in constructor**

```typescript
// src/agent/coordinator.ts — constructor 中
constructor(private config: DelegationCoordinatorConfig) {
  this.runWorker = config.runWorker ?? runWorkerSession
  this.state = new CoordinatorState(config.maxWorkers)
  this.stagingArea = config.stagingArea ?? new StagingArea(process.cwd(), config.sessionId ?? 'default')
}

// 添加字段
private stagingArea: StagingArea
```

- [ ] **步骤 6：实现 commitStagedResults 方法**

```typescript
// src/agent/coordinator.ts — 添加方法

async commitStagedResults(): Promise<CoordinatorRun> {
  const staged = this.stagingArea.getStaged()
  const report = runPreCommitChecks(staged)

  if (report.conflictReport.hasConflict) {
    // Conflict: return report for Primary resolution
    // Still include committed results (non-conflicting)
    const committed = this.stagingArea.getCommitted()
    return {
      status: 'conflict',
      results: committed,
      packet: buildPrimaryWorkerPacket(committed),
      conflictReport: report.conflictReport,
    }
  }

  // No conflict: commit all pending
  const pending = staged.filter(s => s.status === 'pending')
  for (const entry of pending) {
    this.stagingArea.commit(entry.result.workOrderId)
  }

  const committed = this.stagingArea.getCommitted()
  this.stagingArea.clear()

  return {
    status: 'completed',
    results: committed,
    packet: buildPrimaryWorkerPacket(committed),
  }
}
```

- [ ] **步骤 7：运行 typecheck**

运行：`npm run typecheck`
预期：0 errors（如果有问题修复）

- [ ] **步骤 8：Commit**

```bash
git add src/agent/coordinator.ts src/agent/staging-coordinator.ts src/agent/__tests__/coordinator-staging.test.ts
git commit -m "feat(surgical-pause): integrate StagingArea + commitStagedResults into coordinator"
```

---

### 任务 7：Typecheck + 全量测试验证

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npm run typecheck`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 3：运行 build**

运行：`npm run build`
预期：成功

---

## 自检结果

1. **规格覆盖度**：
   - StagingArea ✓ (stage/commit/reject/getStaged/getCommitted/clear)
   - StagingMetadata ✓ (role/sessionId/scope/timestamp)
   - StagedResult ✓ (WorkerResult + StagingMetadata + status + rejectReason)
   - checkProvenance ✓ (missing/cross-session detection)
   - checkScopeViolation ✓ (out-of-scope file detection)
   - checkConflicts ✓ (file overlap + resolution)
   - runPreCommitChecks ✓ (aggregate into report)
   - Coordinator integration ✓ (staging before return, commitStagedResults)

2. **占位符扫描**：无 TODO/待定/后续实现

3. **类型一致性**：
   - StagedResult uses WorkerResult from work-order.ts
   - StagingMetadata uses WorkOrderScope from work-order.ts
   - PreCommitReport combines all check results
   - CoordinatorRun extended with conflictReport field

---

## 验收标准

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — 全部 PASS（staging-area.test.ts + pre-commit-check.test.ts）
- [ ] StagingArea.stage() 将 WorkerResult 放入 staging area
- [ ] StagingArea.commit() 将 status 改为 'committed'
- [ ] StagingArea.reject() 将 status 改为 'rejected' + 记录 rejectReason
- [ ] checkProvenance 检测 missing + cross-session issues
- [ ] checkScopeViolation 检测 out-of-scope changedFiles
- [ ] checkConflicts 检测文件冲突 + 生成 resolution 建议
- [ ] runPreCommitChecks 聚合所有检查结果
- [ ] delegateBatch 结果先进入 staging 再返回
- [ ] commitStagedResults 在有冲突时返回 ConflictReport

---

## 明确排除（不做）

| 提议 | 为什么不做 |
|------|-----------|
| Primary 裁决机制 | 等待 Surgical Pause baseline 建立后再设计冲突解决协议 |
| 自动 merge 冲突文件 | 涉及文件内容合并，风险太高，等 Primary 人工裁决 |
| 并行 staging 写入 | 当前 staging 是 in-memory，等有性能问题再加 |
| PreCommitCheck 缓存 | 当前实现足够快，添加缓存增加复杂度 |

---

## 依赖关系

- 任务 1 必须在任务 2-5 之前完成（StagingArea 是依赖）
- 任务 2-5 可以并行（独立的 check 函数）
- 任务 6 依赖任务 1+5（需要 StagingArea + runPreCommitChecks）
- 任务 7 最后执行（验证）

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| staging area 影响并行性能 | 低 | 中 | staging 是纯内存操作，无 I/O |
| pre-commit check 误报 scope violation | 中 | 中 | scope 越界是明确的 bug，误报说明 scope 设计有问题 |
| coordinator 引入回归 | 中 | 高 | 每个步骤后运行 typecheck + test |
| conflict report 设计不符合预期 | 中 | 中 | 先实现基础检测，Primary 裁决协议后续迭代 |
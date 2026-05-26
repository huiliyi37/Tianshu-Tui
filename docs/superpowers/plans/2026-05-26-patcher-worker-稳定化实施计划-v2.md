# Patcher Worker 稳定化实施计划 V2（修订版）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 patcher profile 的 delegate_task 能稳定产出可应用的 patch，解决当前 worktree 隔离下工人无法产出有效补丁的问题。

**基于：** V1 计划 + 天枢审阅补充（7.2–7.11），合并所有接线层修复。

**架构：** 七个任务，按依赖顺序执行：(0) scope materialization 预检；(1) diff 收集含 unstaged+untracked；(2) worker prompt 全链路传递 CWD；(3) artifact/packet 不截断 diff；(4) 证据门降级 + profile 传递修复；(5) apply_patch 工具闭环；(6) 端到端 smoke test。

**技术栈：** TypeScript strict, node:test, 现有 WorktreeCoordinator / DelegationCoordinator / HandsSession 基础设施。

**验证命令约定：** 全文使用 `tsx --test <file>` 而非 `npx tsx`（避免 npm 11 解析问题）。

## 实施完成记录（2026-05-26）

**状态：已完成。** 任务 0–6 已实现并提交：

- `f26f494 fix(worker): stabilize patcher worktree diff flow` — 覆盖任务 0–3。
- `f0f74f3 fix(worker): complete patcher evidence and apply patch flow` — 覆盖任务 4–6，并补齐端到端 smoke test。

**最终验证：**

- `npx tsc --noEmit` — PASS。
- `./node_modules/.bin/tsx --test src/agent/__tests__/worktree-scope.test.ts src/agent/__tests__/diff-collector.test.ts src/agent/__tests__/hands-session.test.ts src/agent/__tests__/worker-prompts.test.ts src/agent/__tests__/worker-evidence.test.ts src/agent/__tests__/aggregation-profile.test.ts src/agent/__tests__/patcher-e2e.test.ts src/tools/__tests__/apply-patch.test.ts src/__tests__/wave5-integration.test.ts` — 51 passed, 0 failed。

**已知外部事项：** 全量测试仍有既有外部失败 `src/config/__tests__/schema.test.ts`（`cheap` vs `mimo`），不属于本计划范围。

**实现偏差记录：** 任务 5 原计划写“注册到 `src/main.tsx`”，实际为避免覆盖 `main.tsx` 的外部 dirty 改动，将 `apply_patch` 注册到 `src/tools/default-registry.ts`。主会话通过 `createDefaultToolRegistry()` 获得工具，运行效果等价。

---

## 迭代记录

| 版本 | 日期 | 变更 |
|------|------|------|
| V1 | 2026-05-26 | 初版：5 个主失败点修复 |
| V2 | 2026-05-26 | 合并天枢审阅：+任务 0（scope materialization）、修正任务 2（全链路传递）、任务 1 补 untracked、任务 4 补 profile map、+任务 6（smoke test）、统一验证命令 |

---

## 根因分析（完整失败链）

```
主会话 delegate_task(profile: "patcher", scope: { files: [...] })
  → [失败点 0] scope.files 含未提交文件 → worktree 中不存在 → worker read_file 失败
  → coordinator 创建 worktree 在 /tmp/rivet-wt-xxx/
  → [失败点 1] worker prompt 没告知 CWD 已变 → 用主仓库绝对路径 → path-validate 拒绝
  → [失败点 1b] prompt 在 hands-session 构建但 coordinator.runAgent 忽略它
  →             runWorkerSession 内部重新调 buildWorkerPrompt(order) 不带 workerCwd
  → [失败点 2] diff-collector 只收集 committed changes → worker 没 commit → diff 为空
  → [失败点 2b] 即使 worker 编辑了新文件，git diff HEAD 不含 untracked → 遗漏
  → [失败点 3] MAX_ARTIFACT_CONTENT_CHARS=500 截断 diff → 主会话拿到不完整 patch
  → [失败点 3b] buildPrimaryWorkerPacket 的 8K 总限制可能进一步截断
  → [失败点 4] 证据门要求 verified → worker 跑测试失败 → status="blocked"
  → [失败点 4b] aggregateResults 没传 profiles Map → verifyWorkerEvidence 不知道是 patcher
  → [失败点 5] 主会话拿到 diff 后没有 apply_patch 工具 → 只能手动重做
```

---

## 前置阅读

| 文件 | 关键内容 |
|------|---------|
| `src/agent/hands-session.ts` | worktree 生命周期：create → runAgent → collectDiff → remove |
| `src/agent/diff-collector.ts` | `collectDiff()` 用 `git diff baseBranch...workerBranch`，只看 committed |
| `src/agent/worker-prompts.ts` | worker prompt 构建，无 CWD；`MAX_ARTIFACT_CONTENT_CHARS=500` |
| `src/agent/worker-session.ts:91-93` | `runWorkerSession` 内部重新调 `buildWorkerPrompt(config.order)` |
| `src/agent/worker-evidence.ts` | 证据门：changedFiles 非空时强制要求 verified |
| `src/agent/coordinator.ts:270-298` | hands 路径 runAgent 回调忽略 prompt 参数 |
| `src/agent/coordinator.ts:321,391` | `aggregateResults` 调用不传 profiles Map |
| `src/agent/worktree.ts` | `createWorktree()` 在 `/tmp/` 下创建，只含 HEAD 已跟踪文件 |
| `src/tools/path-validate.ts` | `validatePathSafe()` 基于 CWD 做路径围栏 |

---

## 文件结构总览

### 任务 0：Scope Materialization 预检

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/worktree-scope.ts` | 预检 scope.files 可见性，复制 untracked 到 worktree | 新建 |
| `src/agent/hands-session.ts` | worktree 创建后调用 materializeScope | 修改 |
| `src/agent/__tests__/worktree-scope.test.ts` | 测试 tracked/untracked/外部文件三种情况 | 新建 |

### 任务 1：修复 diff 收集（committed + staged + unstaged + untracked）

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/diff-collector.ts` | 先 `git add -A` 再 `git diff --cached HEAD` | 修改 |
| `src/agent/__tests__/diff-collector.test.ts` | 测试四种变更状态 | 新建 |

### 任务 2：Worker prompt 全链路传递 CWD

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/work-order.ts` | `WorkOrder` 增加 optional `workerCwd` 字段 | 修改 |
| `src/agent/worker-prompts.ts` | `buildWorkerPrompt` 从 `order.workerCwd` 读取并注入 | 修改 |
| `src/agent/hands-session.ts` | worktree 创建后设置 `order.workerCwd = wt.path` | 修改 |
| `src/agent/worker-session.ts` | 无需改动（已从 order 读取） | — |

### 任务 3：Artifact/Packet 不截断 diff

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/worker-prompts.ts` | diff kind 跳过截断；其他 artifact 限制提到 2000 | 修改 |

### 任务 4：证据门降级 + profile 传递

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/worker-evidence.ts` | patcher/verifier profile 时降级为 advisory risk | 修改 |
| `src/agent/coordinator.ts` | `aggregateResults` 调用时传入 profiles Map | 修改 |
| `src/agent/__tests__/worker-evidence.test.ts` | 测试 patcher 不被 blocked | 修改 |

### 任务 5：apply_patch 工具

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/tools/apply-patch.ts` | 新工具：接收 unified diff，`git apply` | 新建 |
| `src/tools/__tests__/apply-patch.test.ts` | 测试 apply/check/conflict | 新建 |
| `src/main.tsx` | 注册到主会话工具列表 | 修改 |

### 任务 6：端到端 Smoke Test

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/__tests__/patcher-e2e.test.ts` | 完整 patcher 闭环验证 | 新建 |

---

## 任务详情

### 任务 0：Scope Materialization 预检

**问题：** git worktree 只包含 HEAD 已跟踪文件。主会话里未提交的计划文档、临时 docs 不会出现在 `/tmp/rivet-wt-*`。worker `read_file` 找不到文件 → blocked。

**修复：** worktree 创建后、worker 执行前，检查 scope.files 并复制 untracked 文件到 worktree。

**文件：**
- 新建：`src/agent/worktree-scope.ts`
- 修改：`src/agent/hands-session.ts`
- 新建：`src/agent/__tests__/worktree-scope.test.ts`

- [x] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/worktree-scope.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { materializeScope, type ScopeMaterializeResult } from '../worktree-scope.js'

function git(cwd: string, args: string[]) {
  spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' })
}

describe('materializeScope', () => {
  let repoDir: string
  let wtDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'scope-repo-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'tracked.ts'), 'export const x = 1')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
    // Create worktree
    wtDir = mkdtempSync(join(tmpdir(), 'scope-wt-'))
    rmSync(wtDir, { recursive: true })
    spawnSync('git', ['worktree', 'add', '-b', 'test-wt', wtDir], { cwd: repoDir })
  })

  afterEach(() => {
    spawnSync('git', ['worktree', 'remove', '--force', wtDir], { cwd: repoDir })
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('tracked files already visible in worktree', () => {
    const result = materializeScope(repoDir, wtDir, ['tracked.ts'])
    assert.equal(result.missing.length, 0)
    assert.equal(result.materialized.length, 0)
  })

  it('copies untracked files to worktree', () => {
    writeFileSync(join(repoDir, 'plan.md'), '# Plan')
    const result = materializeScope(repoDir, wtDir, ['plan.md'])
    assert.equal(result.materialized.length, 1)
    assert.ok(existsSync(join(wtDir, 'plan.md')))
  })

  it('reports files outside repo as missing', () => {
    const result = materializeScope(repoDir, wtDir, ['/etc/passwd'])
    assert.equal(result.missing.length, 1)
    assert.equal(result.materialized.length, 0)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`tsx --test src/agent/__tests__/worktree-scope.test.ts`
预期：FAIL（模块不存在）

- [x] **步骤 3：实现 worktree-scope.ts**

```typescript
// src/agent/worktree-scope.ts
import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname, isAbsolute, relative } from 'node:path'

export interface ScopeMaterializeResult {
  materialized: string[]
  missing: string[]
}

export function materializeScope(
  baseCwd: string,
  workerCwd: string,
  scopeFiles: string[],
): ScopeMaterializeResult {
  const materialized: string[] = []
  const missing: string[] = []

  for (const file of scopeFiles) {
    // Reject absolute paths outside the repo
    if (isAbsolute(file)) {
      const rel = relative(baseCwd, file)
      if (rel.startsWith('..')) {
        missing.push(file)
        continue
      }
    }

    const relPath = isAbsolute(file) ? relative(baseCwd, file) : file
    const workerPath = join(workerCwd, relPath)
    const basePath = join(baseCwd, relPath)

    // Already visible in worktree (tracked file)
    if (existsSync(workerPath)) continue

    // Exists in base repo but not worktree (untracked)
    if (existsSync(basePath)) {
      mkdirSync(dirname(workerPath), { recursive: true })
      copyFileSync(basePath, workerPath)
      materialized.push(relPath)
    } else {
      missing.push(file)
    }
  }

  return { materialized, missing }
}
```

- [x] **步骤 4：集成到 hands-session.ts**

在 `src/agent/hands-session.ts` 的 worktree 创建后、runAgent 前：

```typescript
import { materializeScope } from './worktree-scope.js'

// After: const wt = config.wtCoordinator.create(config.order.id)
// Add:
const scopeFiles = config.order.scope.files ?? []
if (scopeFiles.length > 0) {
  materializeScope(config.cwd, wt.path, scopeFiles)
}
```

- [x] **步骤 5：运行测试验证通过**

运行：`tsx --test src/agent/__tests__/worktree-scope.test.ts`
预期：全部 PASS

- [x] **步骤 6：Commit**

```bash
git add src/agent/worktree-scope.ts src/agent/__tests__/worktree-scope.test.ts src/agent/hands-session.ts
git commit -m "feat(worker): add scope materialization to copy untracked files into worktree"
```

---

### 任务 1：修复 diff 收集（含 untracked）

**问题：** `collectDiff()` 用 `git diff baseBranch...workerBranch`，只看 committed。工人编辑后没 commit → diff 为空。新建文件（untracked）即使 `git diff HEAD` 也看不到。

**修复：** 在即将销毁的 worktree 中先 `git add -A`（安全的，worktree 马上要删），再 `git diff --cached HEAD` 收集所有变更。

**文件：**
- 修改：`src/agent/diff-collector.ts`
- 新建：`src/agent/__tests__/diff-collector.test.ts`

- [x] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/diff-collector.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { collectDiff } from '../diff-collector.js'

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('collectDiff', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'diff-test-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'file.txt'), 'original')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('collects unstaged modifications', () => {
    writeFileSync(join(repoDir, 'file.txt'), 'modified')
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.ok(diff.includes('modified'))
  })

  it('collects untracked new files', () => {
    writeFileSync(join(repoDir, 'brand-new.ts'), 'export const y = 2')
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.ok(diff.includes('brand-new.ts'))
  })

  it('collects staged changes', () => {
    writeFileSync(join(repoDir, 'staged.ts'), 'staged content')
    git(repoDir, ['add', 'staged.ts'])
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.ok(diff.includes('staged content'))
  })

  it('returns empty when no changes', () => {
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.equal(diff, '')
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`tsx --test src/agent/__tests__/diff-collector.test.ts`
预期：untracked 测试 FAIL

- [x] **步骤 3：替换 collectDiff 实现**

```typescript
// src/agent/diff-collector.ts — 替换 collectDiff 函数体
export function collectDiff(_baseCwd: string, workerCwd: string, _baseRef: string): string {
  // Stage everything (safe: worktree is about to be destroyed)
  git(workerCwd, ['add', '-A'])
  // Diff all staged changes against HEAD (covers committed + staged + previously-unstaged + untracked)
  const result = git(workerCwd, ['diff', '--cached', 'HEAD'])
  return result.ok ? result.stdout.trim() : ''
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`tsx --test src/agent/__tests__/diff-collector.test.ts`
预期：全部 PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/diff-collector.ts src/agent/__tests__/diff-collector.test.ts
git commit -m "fix(worker): collect all worktree changes including untracked via git add -A + diff --cached"
```

---

### 任务 2：Worker prompt 全链路传递 CWD

**问题（天枢 7.3 补充）：** `hands-session.ts` 构建 prompt 时注入了 `workerCwd`，但 `coordinator.ts` 的 `runAgent` 回调忽略了 prompt 参数，`runWorkerSession` 内部重新调用 `buildWorkerPrompt(config.order)` 不带 CWD。

**修复：** 在 `WorkOrder` 上增加 `workerCwd` 字段，`hands-session` 设置它，`buildWorkerPrompt` 从 order 中读取。整条链路统一从 order 获取 CWD。

**文件：**
- 修改：`src/agent/work-order.ts`
- 修改：`src/agent/worker-prompts.ts`
- 修改：`src/agent/hands-session.ts`

- [x] **步骤 1：WorkOrder 增加 workerCwd 字段**

在 `src/agent/work-order.ts` 的 `WorkOrder` interface 中添加：

```typescript
export interface WorkOrder {
  // ... existing fields ...
  /** Set by hands-session after worktree creation. Worker prompt reads this for CWD guidance. */
  workerCwd?: string
}
```

- [x] **步骤 2：修改 buildWorkerPrompt 读取 order.workerCwd**

在 `src/agent/worker-prompts.ts`：

```typescript
export function buildWorkerPrompt(order: WorkOrder, authoritySuffix?: string): string {
  const hasWriteTools = order.allowedTools.some(t => !(READ_ONLY_WORKER_TOOLS as readonly string[]).includes(t))
  // ... existing code ...

  // After constraints line, before "Do not call disallowed tools":
  if (order.workerCwd && hasWriteTools) {
    parts.push(
      '',
      '## Working Directory',
      `CWD: ${order.workerCwd}`,
      'You are in an isolated git worktree. Use RELATIVE paths for all file operations.',
      'Do NOT use absolute paths from the original repository.',
      'After completing edits, run: git add -A && git commit -m "patch: <description>"',
    )
  }

  // ... rest unchanged ...
}
```

- [x] **步骤 3：hands-session.ts 设置 order.workerCwd**

在 `src/agent/hands-session.ts`，worktree 创建后：

```typescript
const wt = config.wtCoordinator.create(config.order.id)
config.order.workerCwd = wt.path  // NEW: propagates to buildWorkerPrompt via order
```

- [x] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS（workerCwd 是 optional）

- [x] **步骤 5：Commit**

```bash
git add src/agent/work-order.ts src/agent/worker-prompts.ts src/agent/hands-session.ts
git commit -m "fix(worker): propagate workerCwd through WorkOrder for full-chain prompt injection"
```

---

### 任务 3：Artifact/Packet 不截断 diff

**问题：** `MAX_ARTIFACT_CONTENT_CHARS = 500` 截断所有 artifact。一个正常 patch 轻松超 500 字符。`buildPrimaryWorkerPacket` 的 8K 总限制可能进一步丢弃。

**修复：** diff kind 的 artifact 不截断。其他 artifact 限制提到 2000。packet 总限制对含 diff 的结果提到 32K。

**文件：** `src/agent/worker-prompts.ts`

- [x] **步骤 1：修改截断逻辑**

```typescript
// src/agent/worker-prompts.ts

const MAX_ARTIFACT_CONTENT_CHARS = 2_000  // was 500
const MAX_WORKER_PACKET_CHARS = 32_000     // was 8_000

function truncateArtifactContent(artifacts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return artifacts.map(a => {
    // Never truncate diff artifacts — they are patcher's primary output
    if (a.kind === 'diff') return a
    if (typeof a.content === 'string' && a.content.length > MAX_ARTIFACT_CONTENT_CHARS) {
      return { ...a, content: a.content.slice(0, MAX_ARTIFACT_CONTENT_CHARS) + '…' }
    }
    return a
  })
}
```

- [x] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [x] **步骤 3：Commit**

```bash
git add src/agent/worker-prompts.ts
git commit -m "fix(worker): don't truncate diff artifacts; raise packet limit to 32K"
```

---

### 任务 4：证据门降级 + profile 传递

**问题：**
1. `verifyWorkerEvidence` 对 patcher 也强制要求 `evidenceStatus: "verified"`，导致 worker 跑测试失败时被 blocked。patcher 的职责是产出 patch，验证应由主会话或 verifier 做。
2. `coordinator.ts` 调用 `aggregateResults` 时没传 `profiles` Map，导致证据门不知道 worker 是 patcher。

**修复：**
1. patcher/verifier profile 时，changedFiles 非空但未 verified → 附加 advisory risk，不 block。
2. coordinator 构建 profiles Map 并传入。

**文件：**
- 修改：`src/agent/worker-evidence.ts`
- 修改：`src/agent/coordinator.ts`
- 修改：`src/agent/__tests__/worker-evidence.test.ts`

- [x] **步骤 1：修改 verifyWorkerEvidence**

```typescript
// src/agent/worker-evidence.ts

const WRITE_PROFILES_ADVISORY = ['patcher', 'verifier']

export function verifyWorkerEvidence(result: WorkerResult, profile?: string): WorkerResult {
  if (result.changedFiles.length === 0) return result

  // Patcher/verifier: verification is advisory, not blocking
  if (profile && WRITE_PROFILES_ADVISORY.includes(profile)) {
    if (result.evidenceStatus !== 'verified') {
      return {
        ...result,
        risks: addRisk(result.risks, `advisory: ${result.changedFiles.length} file(s) changed without verified evidence`),
      }
    }
    return result
  }

  // Original blocking logic for other profiles
  const unverifiedRisk = `unverified: ${result.changedFiles.length} file(s) changed without verified evidence`
  if (result.evidenceStatus !== 'verified') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, unverifiedRisk),
    }
  }
  // ... rest unchanged ...
}
```

- [x] **步骤 2：修改 coordinator 传递 profiles Map**

在 `src/agent/coordinator.ts` 的 `delegateOrder` 返回处（单任务，line ~321）：

```typescript
const profileMap = new Map([[order.id, order.profile]])
const results = aggregateResults([run.result], 'primary_decides', profileMap)
```

在 `delegateBatch` 返回处（line ~391）：

```typescript
const profileMap = new Map(orders.map(o => [o.id, o.profile]))
const aggregated = aggregateResults(allResults, policy, profileMap)
```

- [x] **步骤 3：更新测试**

在 `src/agent/__tests__/worker-evidence.test.ts` 增加：

```typescript
it('patcher profile gets advisory risk instead of blocked', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/foo.ts'],
    evidenceStatus: 'unverified',
  }), 'patcher')
  assert.equal(checked.status, 'passed')  // not blocked
  assert.ok(checked.risks.some(r => r.includes('advisory')))
})
```

- [x] **步骤 4：运行测试**

运行：`tsx --test src/agent/__tests__/worker-evidence.test.ts`
预期：全部 PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/worker-evidence.ts src/agent/coordinator.ts src/agent/__tests__/worker-evidence.test.ts
git commit -m "fix(worker): patcher evidence is advisory not blocking; pass profiles to aggregateResults"
```

---

### 任务 5：apply_patch 工具

**问题：** 主会话拿到 worker 的 diff artifact 后，没有工具可以直接 apply。只能人工复制粘贴或让 LLM 重新编辑。

**修复：** 新增 `apply_patch` 工具，接收 unified diff 字符串，通过 `git apply` 应用到主仓库。支持 `--check` 模式预检。

**文件：**
- 新建：`src/tools/apply-patch.ts`
- 新建：`src/tools/__tests__/apply-patch.test.ts`
- 修改：`src/main.tsx`

- [x] **步骤 1：编写测试**

```typescript
// src/tools/__tests__/apply-patch.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { applyPatch } from '../apply-patch.js'

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('applyPatch', () => {
  let repoDir: string
  const validDiff = `diff --git a/file.txt b/file.txt
index 2e65efe..a2005b8 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-original
+patched
`

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'patch-test-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'file.txt'), 'original\n')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('applies valid patch', () => {
    const result = applyPatch(repoDir, { diff: validDiff })
    assert.ok(result.ok)
    assert.equal(readFileSync(join(repoDir, 'file.txt'), 'utf-8').trim(), 'patched')
  })

  it('check-only mode does not modify files', () => {
    const result = applyPatch(repoDir, { diff: validDiff, checkOnly: true })
    assert.ok(result.ok)
    assert.equal(readFileSync(join(repoDir, 'file.txt'), 'utf-8').trim(), 'original')
  })

  it('returns error for conflicting patch', () => {
    writeFileSync(join(repoDir, 'file.txt'), 'already changed\n')
    const result = applyPatch(repoDir, { diff: validDiff })
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('patch does not apply'))
  })
})
```

- [x] **步骤 2：实现 apply-patch.ts**

```typescript
// src/tools/apply-patch.ts
import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface ApplyPatchInput {
  diff: string
  checkOnly?: boolean
}

export interface ApplyPatchResult {
  ok: boolean
  error: string
}

export function applyPatch(cwd: string, input: ApplyPatchInput): ApplyPatchResult {
  const patchFile = join(tmpdir(), `rivet-patch-${Date.now()}.patch`)
  try {
    writeFileSync(patchFile, input.diff)
    const args = ['apply', '--3way']
    if (input.checkOnly) args.push('--check')
    args.push(patchFile)
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status === 0) return { ok: true, error: '' }
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : 'unknown error'
    return { ok: false, error: stderr }
  } finally {
    try { unlinkSync(patchFile) } catch {}
  }
}
```

- [x] **步骤 3：注册工具到 main.tsx**

在 `src/main.tsx` 的工具注册区域，添加 `apply_patch` 工具定义（参数：`diff: string`, `check_only?: boolean`），内部调用 `applyPatch(cwd, input)`。

- [x] **步骤 4：运行测试**

运行：`tsx --test src/tools/__tests__/apply-patch.test.ts`
预期：全部 PASS

- [x] **步骤 5：Commit**

```bash
git add src/tools/apply-patch.ts src/tools/__tests__/apply-patch.test.ts src/main.tsx
git commit -m "feat(tools): add apply_patch tool for applying worker diffs to main repo"
```

---

### 任务 6：端到端 Smoke Test

**目标（天枢 7.11）：** 一个测试覆盖完整 patcher 闭环，不是只验证局部函数。

**文件：** `src/agent/__tests__/patcher-e2e.test.ts`

- [x] **步骤 1：编写端到端测试**

```typescript
// src/agent/__tests__/patcher-e2e.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { collectDiff, formatDiffArtifact } from '../diff-collector.js'
import { materializeScope } from '../worktree-scope.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'
import { buildPrimaryWorkerPacket } from '../worker-prompts.js'
import { applyPatch } from '../../tools/apply-patch.js'

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('patcher e2e: untracked scope → worktree edit → diff → apply', () => {
  let repoDir: string
  let wtDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'e2e-repo-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'src/app.ts'), 'export const broken = true\n')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
    // Untracked plan doc
    writeFileSync(join(repoDir, 'docs/plan.md'), '# Fix broken')
    // Create worktree
    wtDir = mkdtempSync(join(tmpdir(), 'e2e-wt-'))
    rmSync(wtDir, { recursive: true })
    git(repoDir, ['worktree', 'add', '-b', 'patch-branch', wtDir])
  })

  afterEach(() => {
    git(repoDir, ['worktree', 'remove', '--force', wtDir])
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('full patcher lifecycle produces applicable patch', () => {
    // Step 1: materialize scope (untracked plan.md → worktree)
    const scope = materializeScope(repoDir, wtDir, ['docs/plan.md', 'src/app.ts'])
    assert.ok(existsSync(join(wtDir, 'docs/plan.md')), 'plan.md materialized')
    assert.equal(scope.missing.length, 0)

    // Step 2: simulate worker editing files in worktree (no commit!)
    writeFileSync(join(wtDir, 'src/app.ts'), 'export const broken = false\n')

    // Step 3: collect diff (should capture the edit)
    const diff = collectDiff(repoDir, wtDir, 'main')
    assert.ok(diff.includes('broken = false'), 'diff captures worker edit')

    // Step 4: format artifact — not truncated
    const artifact = formatDiffArtifact(diff, 'patcher')
    assert.ok(artifact.content.length > 10, 'artifact not empty')
    assert.ok(!artifact.content.endsWith('…'), 'artifact not truncated')

    // Step 5: evidence gate — patcher not blocked
    const workerResult = {
      workOrderId: 'test-order',
      status: 'passed' as const,
      summary: 'fixed broken flag',
      findings: [],
      artifacts: [artifact],
      changedFiles: ['src/app.ts'],
      examinedFiles: ['docs/plan.md'],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified' as const,
    }
    const gated = verifyWorkerEvidence(workerResult, 'patcher')
    assert.notEqual(gated.status, 'blocked', 'patcher should not be blocked')

    // Step 6: packet not truncated
    const packet = buildPrimaryWorkerPacket([gated])
    assert.ok(packet.includes('broken = false'), 'packet preserves diff content')

    // Step 7: apply patch to main repo
    const applyResult = applyPatch(repoDir, { diff, checkOnly: true })
    assert.ok(applyResult.ok, 'patch applies cleanly (check)')

    const applyReal = applyPatch(repoDir, { diff })
    assert.ok(applyReal.ok, 'patch applies cleanly')
    assert.equal(
      readFileSync(join(repoDir, 'src/app.ts'), 'utf-8').trim(),
      'export const broken = false',
      'main repo file updated'
    )
  })
})
```

- [x] **步骤 2：运行测试**

运行：`tsx --test src/agent/__tests__/patcher-e2e.test.ts`
预期：全部 PASS（依赖任务 0-5 完成）

- [x] **步骤 3：Commit**

```bash
git add src/agent/__tests__/patcher-e2e.test.ts
git commit -m "test(worker): add patcher e2e smoke test covering full lifecycle"
```

---

## 四、执行顺序与依赖

```
任务 0 (scope materialization) ─┐
任务 1 (diff 收集)              ├─→ 任务 6 (e2e smoke test)
任务 2 (prompt 全链路)          │
任务 3 (artifact 不截断)        │
任务 4 (证据门 + profile map)   │
任务 5 (apply_patch 工具)      ─┘
```

任务 0-5 之间无硬依赖，可并行执行。任务 6 依赖全部前置任务完成。

推荐顺序（按风险）：**0 → 1 → 2 → 4 → 3 → 5 → 6**

---

## 五、自检

### 1. 失败点覆盖

| 失败点 | 覆盖任务 |
|--------|---------|
| scope 文件不可见 | 任务 0 |
| diff 只收集 committed | 任务 1 |
| diff 遗漏 untracked | 任务 1 |
| prompt 无 CWD | 任务 2 |
| prompt 没传到实际 worker | 任务 2（通过 WorkOrder.workerCwd） |
| artifact 截断 500 字符 | 任务 3 |
| packet 截断 8K | 任务 3 |
| 证据门 block patcher | 任务 4 |
| profile 没传到证据门 | 任务 4 |
| 主会话无 apply 工具 | 任务 5 |
| 端到端闭环验证 | 任务 6 |

### 2. 类型一致性

- `WorkOrder.workerCwd?: string` — 新增 optional，不破坏现有代码
- `buildWorkerPrompt(order)` — 签名不变（移除了 `workerCwd` 独立参数，改为从 order 读取）
- `collectDiff(baseCwd, workerCwd, baseRef)` — 签名不变，实现改变
- `verifyWorkerEvidence(result, profile?)` — 签名不变
- `aggregateResults(results, policy, profiles?)` — profiles 已是 optional 参数
- `materializeScope(baseCwd, workerCwd, files)` — 新函数
- `applyPatch(cwd, input)` — 新函数

### 3. 与 prefix cache 不变量兼容性

全部修改在 worker 子系统，不触碰主会话的 PromptEngine / oaiMessages / volatile。**无关。**

---

## 六、执行交接

计划已保存。两种执行方式：

1. **子代理驱动（推荐）** — 任务 0-5 可并行派给 6 个 patcher worker（ironic but effective），任务 6 等全部完成后执行。

2. **内联执行** — 按 0→1→2→4→3→5→6 顺序，每个任务完成后 typecheck 检查点。

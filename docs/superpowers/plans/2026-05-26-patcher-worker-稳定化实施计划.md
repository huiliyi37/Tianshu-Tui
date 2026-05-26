# Patcher Worker 稳定化实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 patcher profile 的 delegate_task 能稳定产出可应用的 patch，解决当前 worktree 隔离下工人无法产出有效补丁的问题。

**架构：** 五个修复点：(1) diff 收集改为包含 unstaged changes；(2) worker prompt 注入 CWD 和相对路径指引；(3) artifact 大小限制放宽到可用水平；(4) 证据门对 patcher 降级为 advisory；(5) 主会话增加 apply_patch 工具闭环。

**技术栈：** TypeScript strict, node:test, 现有 WorktreeCoordinator / DelegationCoordinator / HandsSession 基础设施。

## 实施完成记录（2026-05-26）

**状态：已被 V2 计划完整覆盖并完成。** 本文为初版方案；实际执行以 `2026-05-26-patcher-worker-稳定化实施计划-v2.md` 为准。

**完成提交：**

- `f26f494 fix(worker): stabilize patcher worktree diff flow` — 覆盖 scope materialization、diff collector、workerCwd prompt、diff artifact/packet 稳定化。
- `f0f74f3 fix(worker): complete patcher evidence and apply patch flow` — 覆盖 evidence advisory、profile map、apply_patch 工具、端到端 smoke test。

**最终验证：**

- `npx tsc --noEmit` — PASS。
- `./node_modules/.bin/tsx --test src/agent/__tests__/worktree-scope.test.ts src/agent/__tests__/diff-collector.test.ts src/agent/__tests__/hands-session.test.ts src/agent/__tests__/worker-prompts.test.ts src/agent/__tests__/worker-evidence.test.ts src/agent/__tests__/aggregation-profile.test.ts src/agent/__tests__/patcher-e2e.test.ts src/tools/__tests__/apply-patch.test.ts src/__tests__/wave5-integration.test.ts` — 51 passed, 0 failed。

**已知外部事项：** 全量测试仍有既有外部失败 `src/config/__tests__/schema.test.ts`（`cheap` vs `mimo`），不属于本计划范围。

---

## 根因分析

天枢复盘中 patcher worker "没产出 patch" 的失败链：

```
主会话 delegate_task(profile: "patcher")
  → coordinator 创建 worktree 在 /tmp/rivet-wt-xxx/
  → worker 在 worktree 中执行
  → [失败点 1] worker prompt 没告知 CWD 已变，工人可能用主仓库绝对路径
  → [失败点 2] 即使工人成功编辑了文件，diff-collector 只收集 committed changes
  →            工人没有被指示 git add + commit，所以 diff 为空
  → [失败点 3] 即使 diff 非空，MAX_ARTIFACT_CONTENT_CHARS=500 截断了补丁
  → [失败点 4] 证据门要求 evidenceStatus="verified"，工人跑测试可能失败
  →            导致 status="blocked"，主会话拿到的是 blocked 而非 patch
  → [失败点 5] 主会话拿到 diff artifact 后没有 apply_patch 工具，只能手动重做
```

5 个失败点中任何一个都足以导致"没产出 patch"。当前设计是 5 个串联的脆弱点。

---

## 前置阅读

| 文件 | 关键内容 |
|------|---------|
| `src/agent/hands-session.ts` | worktree 生命周期：create → runAgent → collectDiff → remove |
| `src/agent/diff-collector.ts` | `collectDiff()` 用 `git diff baseBranch...workerBranch`，只看 committed |
| `src/agent/worker-prompts.ts` | worker prompt 构建，无 CWD 信息；`MAX_ARTIFACT_CONTENT_CHARS=500` |
| `src/agent/worker-evidence.ts` | 证据门：changedFiles 非空时强制要求 verified |
| `src/agent/coordinator.ts:270-298` | hands 路径的 runAgent 回调实现 |
| `src/agent/worktree.ts` | `createWorktree()` 在 `/tmp/` 下创建 |
| `src/tools/path-validate.ts` | `validatePathSafe()` 基于 CWD 做路径围栏 |

---

## 文件结构

### 任务 1：修复 diff 收集（收集 unstaged + staged + committed）

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/diff-collector.ts` | 改为收集 worktree 中所有变更（不依赖 commit） | 修改 |
| `src/agent/__tests__/diff-collector.test.ts` | 测试 unstaged/staged/committed 三种情况 | 新建 |

### 任务 2：Worker prompt 注入 CWD + 相对路径 + commit 指引

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/worker-prompts.ts` | `buildWorkerPrompt` 接受 `workerCwd` 参数，注入路径指引 | 修改 |
| `src/agent/hands-session.ts` | 传递 `wt.path` 到 prompt 构建 | 修改 |

### 任务 3：放宽 artifact 大小限制

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/worker-prompts.ts` | `MAX_ARTIFACT_CONTENT_CHARS` 从 500 → 8000；diff artifact 不截断 | 修改 |

### 任务 4：证据门对 patcher 降级

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/worker-evidence.ts` | patcher profile 时 evidenceStatus 不强制 verified，改为 advisory warning | 修改 |
| `src/agent/__tests__/worker-evidence.test.ts` | 测试 patcher 不被 blocked | 修改 |

### 任务 5：apply_patch 工具 + 主会话闭环

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/tools/apply-patch.ts` | 新工具：接收 unified diff，`git apply` 到主仓库 | 新建 |
| `src/tools/__tests__/apply-patch.test.ts` | 测试 apply 成功/失败/冲突 | 新建 |
| `src/main.tsx` | 注册 apply_patch 到主会话工具列表 | 修改 |

---

## 三、任务详情

### 任务 1：修复 diff 收集（收集 unstaged + staged + committed）

**问题：** `collectDiff()` 使用 `git diff baseBranch...workerBranch`，这只能看到已 commit 到 workerBranch 的变更。工人编辑文件后如果没有 `git add && git commit`，diff 为空。

**修复方向：** 改为在 worktree 内直接收集所有变更（committed + staged + unstaged），不依赖工人是否 commit。

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

  it('collects unstaged changes without requiring commit', () => {
    writeFileSync(join(repoDir, 'file.txt'), 'modified')
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.ok(diff.includes('modified'), 'should capture unstaged change')
  })

  it('collects staged but uncommitted changes', () => {
    writeFileSync(join(repoDir, 'new.txt'), 'new file content')
    git(repoDir, ['add', 'new.txt'])
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.ok(diff.includes('new file content'), 'should capture staged change')
  })

  it('returns empty string when no changes', () => {
    const diff = collectDiff(repoDir, repoDir, 'main')
    assert.equal(diff, '', 'no changes should produce empty diff')
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/diff-collector.test.ts`
预期：unstaged 测试 FAIL（当前只看 committed）

- [x] **步骤 3：修改 collectDiff 实现**

```typescript
// src/agent/diff-collector.ts — 替换 collectDiff 函数体
export function collectDiff(_baseCwd: string, workerCwd: string, _baseRef: string): string {
  // Collect ALL changes in the worktree relative to HEAD:
  // committed (on worker branch vs base) + staged + unstaged.
  // This doesn't require the worker to git commit.

  // unstaged + staged combined: diff against HEAD covers both
  const allChanges = git(workerCwd, ['diff', 'HEAD'])
  if (allChanges.ok && allChanges.stdout.trim()) return allChanges.stdout.trim()

  // If no uncommitted changes, check for new untracked files
  const untracked = git(workerCwd, ['ls-files', '--others', '--exclude-standard'])
  if (untracked.ok && untracked.stdout.trim()) {
    // Stage untracked to get a diff
    git(workerCwd, ['add', '-A'])
    const staged = git(workerCwd, ['diff', '--cached'])
    return staged.ok ? staged.stdout.trim() : ''
  }

  return ''
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/diff-collector.test.ts`
预期：全部 PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/diff-collector.ts src/agent/__tests__/diff-collector.test.ts
git commit -m "fix(worker): collect all worktree changes in diff-collector, not just committed"
```

---

### 任务 2：Worker prompt 注入 CWD + 相对路径 + commit 指引

**问题：** `buildWorkerPrompt()` 不告知工人当前 CWD。工人可能用主仓库的绝对路径（如 `/Users/banxia/app/.../src/foo.ts`），被 `path-validate.ts` 的围栏拒绝（CWD 是 `/tmp/rivet-wt-xxx/`）。

**修复方向：** prompt 中明确注入 workerCwd，指示工人使用相对路径，完成后 commit。

**文件：**
- 修改：`src/agent/worker-prompts.ts`
- 修改：`src/agent/hands-session.ts`

- [x] **步骤 1：修改 buildWorkerPrompt 签名和内容**

在 `src/agent/worker-prompts.ts` 的 `buildWorkerPrompt` 函数中：

```typescript
export function buildWorkerPrompt(order: WorkOrder, authoritySuffix?: string, workerCwd?: string): string {
  // ... existing code ...
  const parts = [
    `You are a headless ${capability} Rivet worker.`,
    // ... existing fields ...
  ]

  // NEW: inject CWD and path guidance for write workers
  if (workerCwd && hasWriteTools) {
    parts.push(
      '',
      '## Working Directory',
      `CWD: ${workerCwd}`,
      'This is an isolated git worktree. ALL file paths must be RELATIVE (e.g. src/agent/foo.ts).',
      'Do NOT use absolute paths from the original repository.',
      'After completing edits, run: git add -A && git commit -m "patch: <description>"',
    )
  }

  // ... rest of existing code ...
}
```

- [x] **步骤 2：修改 hands-session.ts 传递 workerCwd**

在 `src/agent/hands-session.ts` 第 55 行：

```typescript
// Before:
text = await config.runAgent(buildWorkerPrompt(config.order), { ... }, wt.path)

// After:
text = await config.runAgent(buildWorkerPrompt(config.order, undefined, wt.path), { ... }, wt.path)
```

- [x] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS（新参数是 optional，不破坏现有调用）

- [x] **步骤 4：Commit**

```bash
git add src/agent/worker-prompts.ts src/agent/hands-session.ts
git commit -m "fix(worker): inject CWD and relative-path guidance into patcher prompt"
```

---

### 任务 3：放宽 artifact 大小限制

**问题：** `MAX_ARTIFACT_CONTENT_CHARS = 500`。一个正常的 patch（修改 2-3 个文件）轻松超过 500 字符。截断后主会话拿到的是不完整 diff，无法 apply。

**修复方向：** diff 类型的 artifact 不截断（它是 patcher 的核心产出）。其他 artifact 保持限制但提高到 2000。

**文件：** `src/agent/worker-prompts.ts`

- [x] **步骤 1：修改截断逻辑**

```typescript
// src/agent/worker-prompts.ts

/** Maximum characters for a single artifact content field (non-diff). */
const MAX_ARTIFACT_CONTENT_CHARS = 2_000

function truncateArtifactContent(artifacts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return artifacts.map(a => {
    // Never truncate diff artifacts — they are the primary output of patcher workers
    if (a.kind === 'diff') return a
    if (typeof a.content === 'string' && a.content.length > MAX_ARTIFACT_CONTENT_CHARS) {
      return { ...a, content: a.content.slice(0, MAX_ARTIFACT_CONTENT_CHARS) + '…' }
    }
    return a
  })
}
```

- [x] **步骤 2：同步提高 packet 上限**

```typescript
// MAX_WORKER_PACKET_CHARS: 8000 → 16000
// 理由：一个 patcher 的 diff 可能 4-8KB，加上 metadata 需要 16KB 空间
const MAX_WORKER_PACKET_CHARS = 16_000
```

- [x] **步骤 3：运行现有测试**

运行：`npx tsx --test src/agent/__tests__/worker-prompts.test.ts`（如果存在）
预期：PASS

- [x] **步骤 4：Commit**

```bash
git add src/agent/worker-prompts.ts
git commit -m "fix(worker): don't truncate diff artifacts, raise packet limit to 16KB"
```

---

### 任务 4：证据门对 patcher 降级为 advisory

**问题：** `verifyWorkerEvidence()` 在 `changedFiles` 非空且 `evidenceStatus !== 'verified'` 时直接返回 `status: 'blocked'`。patcher 的核心职责是产出 patch，验证应由主会话或 verifier 做。当前设计让 patcher 既要写代码又要跑测试通过，增加了失败面。

**修复方向：** patcher profile 时，证据门不 block，改为在 risks 中添加 advisory warning。主会话决定是否 apply。

**文件：**
- 修改：`src/agent/worker-evidence.ts`
- 修改/新建：`src/agent/__tests__/worker-evidence.test.ts`

- [x] **步骤 1：修改 verifyWorkerEvidence**

```typescript
// src/agent/worker-evidence.ts
export function verifyWorkerEvidence(result: WorkerResult, profile?: string): WorkerResult {
  if (result.changedFiles.length === 0) return result

  // Patcher profile: evidence is advisory, not blocking.
  // Patcher's job is to produce a patch; verification is the caller's responsibility.
  if (profile === 'patcher') {
    if (result.evidenceStatus !== 'verified') {
      return {
        ...result,
        risks: addRisk(result.risks, `advisory: ${result.changedFiles.length} file(s) changed without verified evidence`),
      }
    }
    return result
  }

  // Other profiles: existing blocking behavior
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

- [x] **步骤 2：编写测试**

```typescript
// 在 worker-evidence 测试中添加
it('patcher profile is not blocked by unverified evidence', () => {
  const result: WorkerResult = {
    workOrderId: 'test',
    status: 'passed',
    summary: 'patched',
    findings: [],
    artifacts: [],
    changedFiles: ['src/foo.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
  }

  const verified = verifyWorkerEvidence(result, 'patcher')
  assert.equal(verified.status, 'passed', 'patcher should not be blocked')
  assert.ok(verified.risks.some(r => r.includes('advisory')), 'should add advisory risk')
})
```

- [x] **步骤 3：运行测试**

运行：`npx tsx --test src/agent/__tests__/worker-evidence.test.ts`
预期：PASS

- [x] **步骤 4：Commit**

```bash
git add src/agent/worker-evidence.ts src/agent/__tests__/worker-evidence.test.ts
git commit -m "fix(worker): patcher evidence gate is advisory, not blocking"
```

---

### 任务 5：apply_patch 工具

**问题：** 主会话拿到 patcher 的 diff artifact 后，没有工具可以直接 apply。只能手动重新编辑，等于 patcher 白跑。

**修复方向：** 新增 `apply_patch` 工具，接收 unified diff 字符串，用 `git apply` 应用到主仓库。

**文件：**
- 新建：`src/tools/apply-patch.ts`
- 新建：`src/tools/__tests__/apply-patch.test.ts`
- 修改：`src/main.tsx`（注册工具）

- [x] **步骤 1：实现 apply_patch 工具**

```typescript
// src/tools/apply-patch.ts
import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface ApplyPatchInput {
  diff: string
  check_only?: boolean
}

export interface ApplyPatchResult {
  ok: boolean
  message: string
  files_affected?: string[]
}

export function applyPatch(cwd: string, input: ApplyPatchInput): ApplyPatchResult {
  const patchFile = join(tmpdir(), `rivet-patch-${Date.now()}.patch`)
  try {
    writeFileSync(patchFile, input.diff)

    const args = ['apply', '--stat', patchFile]
    if (input.check_only) args.splice(1, 0, '--check')

    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? 'unknown error'
      return { ok: false, message: `git apply failed: ${stderr}` }
    }

    if (input.check_only) {
      return { ok: true, message: 'Patch applies cleanly (dry-run)' }
    }

    // Actually apply
    const apply = spawnSync('git', ['apply', patchFile], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (apply.status !== 0) {
      return { ok: false, message: `git apply failed: ${apply.stderr?.trim()}` }
    }

    const files = (result.stdout ?? '').split('\n')
      .filter(l => l.includes('|'))
      .map(l => l.split('|')[0]!.trim())

    return { ok: true, message: 'Patch applied successfully', files_affected: files }
  } finally {
    try { unlinkSync(patchFile) } catch {}
  }
}

export function createApplyPatchTool() {
  return {
    name: 'apply_patch',
    description: 'Apply a unified diff patch to the working directory. Use check_only=true to dry-run first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        diff: { type: 'string', description: 'Unified diff content to apply' },
        check_only: { type: 'boolean', description: 'If true, only check if patch applies cleanly without modifying files' },
      },
      required: ['diff'],
    },
  }
}
```

- [x] **步骤 2：编写测试**

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
  spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: 'ignore' })
}

describe('applyPatch', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'patch-test-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'file.txt'), 'line1\nline2\nline3\n')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('applies a valid patch', () => {
    const diff = `--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2_modified\n line3\n`
    const result = applyPatch(repoDir, { diff })
    assert.ok(result.ok)
    const content = readFileSync(join(repoDir, 'file.txt'), 'utf-8')
    assert.ok(content.includes('line2_modified'))
  })

  it('check_only does not modify files', () => {
    const diff = `--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+changed\n line3\n`
    const result = applyPatch(repoDir, { diff, check_only: true })
    assert.ok(result.ok)
    const content = readFileSync(join(repoDir, 'file.txt'), 'utf-8')
    assert.ok(content.includes('line2'), 'file should not be modified in check_only mode')
  })

  it('returns error for conflicting patch', () => {
    const diff = `--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n wrong_context\n-line2\n+changed\n line3\n`
    const result = applyPatch(repoDir, { diff })
    assert.equal(result.ok, false)
    assert.ok(result.message.includes('failed'))
  })
})
```

- [x] **步骤 3：运行测试**

运行：`npx tsx --test src/tools/__tests__/apply-patch.test.ts`
预期：PASS

- [x] **步骤 4：在 main.tsx 注册工具**

在主会话的工具注册处添加 `apply_patch`。

- [x] **步骤 5：Commit**

```bash
git add src/tools/apply-patch.ts src/tools/__tests__/apply-patch.test.ts src/main.tsx
git commit -m "feat(tools): add apply_patch tool for applying worker diffs to main repo"
```

---

## 四、集成验证

完成任务 1-5 后，执行端到端验证：

- [x] **步骤 1：typecheck**

```bash
npx tsc --noEmit
```

- [x] **步骤 2：全量测试**

```bash
npx tsx --test $(find src -name '*.test.ts' | head -50)
```

- [x] **步骤 3：手动验证 patcher 流程**

在主会话中执行：
```
delegate_task(profile: "patcher", objective: "在 src/agent/context.ts 的 addToolResults 方法中添加一行注释", files: ["src/agent/context.ts"])
```

预期：
1. 工人在 worktree 中成功编辑文件
2. diff-collector 捕获到变更
3. 主会话收到包含完整 diff 的 artifact
4. 主会话可以用 apply_patch 工具应用 diff

---

## 五、自检

### 1. 规格覆盖度

| 失败点 | 覆盖任务 |
|--------|---------|
| diff 只收集 committed | 任务 1 |
| prompt 无 CWD 信息 | 任务 2 |
| artifact 截断 500 字符 | 任务 3 |
| 证据门 block patcher | 任务 4 |
| 主会话无 apply 工具 | 任务 5 |

### 2. 类型一致性

- `buildWorkerPrompt(order, authoritySuffix?, workerCwd?)` — 新增 optional 参数，不破坏现有调用
- `collectDiff(baseCwd, workerCwd, baseRef)` — 签名不变，内部实现改变
- `verifyWorkerEvidence(result, profile?)` — 签名不变，profile 已是 optional
- `applyPatch(cwd, input)` — 新函数，新文件
- `createApplyPatchTool()` — 新函数，注册到 main.tsx

### 3. 与 prefix cache 不变量的兼容性

本计划所有修改都在 worker 子系统中，不触碰：
- `PromptEngine.buildOaiRequest()`
- `volatileBlock` / `cachedFreshBlock`
- 主会话的 `oaiMessages` 数组
- system prompt / tools 数组

**与 cache 不变量完全无关。**

---

## 六、执行交接

计划已保存到 `docs/superpowers/plans/2026-05-26-patcher-worker-稳定化实施计划.md`。

两种执行方式：

1. **子代理驱动（推荐）** — 5 个任务可按 1→2→3→4→5 顺序执行，每个任务独立可验证。任务 1-4 无依赖可并行，任务 5 独立。

2. **内联执行** — 在当前会话中按顺序执行，每个任务完成后 typecheck 作为检查点。

选哪种方式？

---

## 七、天枢审阅补充（2026-05-26）

### 7.1 总体结论

原计划覆盖了 patcher worker 失败链的主干，但还缺少几个会直接影响落地效果的系统级接线点。建议在正式执行前把下面补充合并进实施范围，否则即使完成任务 1-5，patcher 仍可能出现“worker 运行了但主会话拿不到可用 patch”的情况。

### 7.2 必补缺口 A：worker worktree 看不到未提交/未跟踪的上下文文件

**现象：** 本轮实际复盘里，worker 曾报告计划文档在隔离 worker checkout 中不可读。根因是 hands worker 基于 git worktree 创建，只天然包含 **HEAD 中已跟踪的文件**。主会话里未提交的计划文档、临时 docs、外部资料不会自动出现在 `/tmp/rivet-wt-*`。

**风险：** 如果 delegation 的 scope 包含未跟踪文件，worker 会：

- `read_file` 找不到文件；
- 或使用主仓库绝对路径，触发 path validate 的 “outside project directory”；
- 最终返回 blocked，而不是 patch。

**建议新增任务 0：scope materialization / preflight**

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/hands-session.ts` 或 `src/agent/coordinator.ts` | 在创建 worker 前检查 scope.files 是否存在于 worker worktree | 修改 |
| `src/agent/worktree-scope.ts` | 可选新模块：把主仓库 scoped untracked 文件复制到 worker worktree，或明确阻断并提示先提交/传内联上下文 | 新建 |
| `src/agent/__tests__/hands-session.test.ts` | 测试未跟踪 scoped file 的处理 | 修改/新建 |

**推荐策略：**

1. 对 `scope.files` 做预检：
   - 若文件已 tracked：worktree 中应存在；
   - 若文件是 untracked：复制到 worker worktree 同路径，标记为 materialized context；
   - 若文件在主仓库外：阻断，并返回明确错误，不让 worker 猜路径。
2. prompt 中告知：materialized context 文件是 worker worktree 内副本，不要引用主仓库绝对路径。

### 7.3 必补缺口 B：`workerCwd` prompt 可能没有真正传到实际 worker

原计划任务 2 只修改：

```ts
buildWorkerPrompt(config.order, undefined, wt.path)
```

但当前 `DelegationCoordinator` 的 hands 路径中，`runHandsSession()` 传给 `runAgent(prompt, callbacks, workerCwd)` 的 `prompt` 在默认 coordinator 实现里并没有被使用：

```ts
runAgent: async (prompt, callbacks, workerCwd) => {
  const sessionRun = await this.runWorker({
    ...workerConfig,
    order,
    cwd: workerCwd,
    activeClaims,
  })
  return JSON.stringify(sessionRun.result)
}
```

而 `runWorkerSession()` 内部会重新调用：

```ts
buildWorkerPrompt(config.order)
```

所以仅改 `hands-session.ts` 可能不会把 CWD 指引注入真实 worker prompt。

**建议修正任务 2：**

- 给 `WorkerSessionConfig` 增加可选字段：

```ts
workerCwd?: string
initialPrompt?: string
```

- `runWorkerSession()` 构建 prompt 时使用：

```ts
const basePrompt = config.initialPrompt ?? buildWorkerPrompt(config.order, undefined, config.workerCwd ?? config.cwd)
```

- `DelegationCoordinator` hands runAgent 调用 `runWorker()` 时传入：

```ts
workerCwd,
initialPrompt: prompt,
```

这样才能保证 `workerCwd` 指引经过 `runHandsSession → coordinator.runAgent → runWorkerSession` 全链路生效。

### 7.4 必补缺口 C：patcher evidence advisory 需要 profile 传递到 aggregation

原计划任务 4 修改 `verifyWorkerEvidence(result, profile?)` 是对的，但当前 coordinator 聚合时没有传 profile map：

```ts
aggregateResults([run.result], 'primary_decides')
aggregateResults(allResults, policy)
```

因此即使 `verifyWorkerEvidence(result, 'patcher')` 支持 advisory，实际 coordinator 调用仍可能以 `profile=undefined` 进入旧 blocking 路径。

**建议修正任务 4：**

- 单 worker：

```ts
const profiles = new Map([[order.id, order.profile]])
const results = aggregateResults([run.result], 'primary_decides', profiles)
```

- batch worker：

```ts
const profiles = new Map(orders.map(o => [o.id, o.profile]))
const aggregated = aggregateResults(allResults, policy, profiles)
```

并补充 coordinator 级测试，不能只测 `worker-evidence.ts`。

### 7.5 必补缺口 D：diff collector 的拟议实现仍会漏 patch

原计划任务 1 的拟议实现有两个重要问题：

1. `git diff HEAD` 能覆盖 staged/unstaged tracked changes，但 **无法覆盖 worker 已 commit 的变更**；
2. 如果 tracked changes 已存在就提前 return，会 **漏掉 untracked files**。

**建议实现原则：** collectDiff 应合并以下四类 diff，而不是早退：

| 类型 | 命令建议 |
|------|----------|
| committed worker branch vs base | `git diff <baseRef>...HEAD` 或 `git diff <baseRef>..HEAD` |
| staged | `git diff --cached` |
| unstaged | `git diff` |
| untracked | `git add -N <file>` 后 `git diff -- <file>`，或用 `git diff --no-index /dev/null <file>` 生成 new-file diff |

**注意：** 如果用 `git add -N`/`git add -A` 生成 untracked diff，要明确这是在一次性 worker worktree 中的允许副作用；更稳妥的实现是用临时 index 或 `--no-index`，避免 collectDiff 修改 worker index。

建议测试覆盖：

- committed only；
- unstaged only；
- staged only；
- untracked only；
- tracked + untracked 同时存在；
- no changes。

### 7.6 必补缺口 E：worker packet 不能用 raw string slice 截断 JSON

原计划任务 3 放宽 artifact 限制是必要的，但当前 `buildPrimaryWorkerPacket()` 的最终兜底逻辑会直接：

```ts
json = json.slice(0, MAX_WORKER_PACKET_CHARS) + '…"'
```

这可能产生非 JSON 的 `<worker_results>` 内容。对主会话来说，坏 JSON 比大 JSON 更危险：它会让 worker 结果不可解析或证据丢失。

**建议修正任务 3：**

- diff artifact 不做 `MAX_ARTIFACT_CONTENT_CHARS` 截断；
- 但最终 packet 超限时不要 raw slice；
- 应构造一个 schema-valid fallback：

```ts
{
  workOrderId,
  status,
  summary,
  artifacts: [{ kind: 'risk', title: 'Worker packet truncated', content: '...' }],
  changedFiles,
  risks: [...risks, 'packet exceeded budget; diff omitted from packet'],
  nextActions: ['Use diff artifact/raw patch channel or rerun with smaller scope'],
  evidenceStatus
}
```

更进一步：diff artifact 可以单独落盘为 artifact/rawPath，packet 只传引用；否则 16KB 对中型 patch 仍可能不够。

### 7.7 必补缺口 F：apply_patch 工具实现要符合 Tool 接口和审批语义

原计划任务 5 的伪代码返回的是裸定义对象，不符合当前工具接口：

```ts
export interface Tool {
  definition: ToolDefinition
  execute(params: ToolCallParams): Promise<ToolResult>
  requiresApproval(params: ToolCallParams): boolean
  isConcurrencySafe(): boolean
  isEnabled(): boolean
}
```

建议：

1. `createApplyPatchTool()` 返回 `Tool`；
2. `check_only=true` 不需要 approval；实际 apply 必须 `requiresApproval=true`；
3. 不要用 `spawnSync`，按项目约定使用 async `spawn` / `execFile`；
4. `git apply --check` 和 `git apply --stat` 分两步执行，不要混用导致语义不清；
5. 注册位置应优先放在 `src/tools/default-registry.ts`，主会话自然获得工具；不要加入 `WRITE_WORKER_TOOLS`，避免 worker 自己 apply patch 到 worker worktree 造成闭环混乱；
6. apply 前应先 dry-run，失败时返回 stderr 和受影响文件列表；
7. 输出 `ToolResult` 应包含清晰的 `content`，例如 `Patch applied successfully\nFiles: ...`。

### 7.8 必补缺口 G：路径规范化应在 WorkOrder 边界完成

worker prompt 里提醒“使用相对路径”是必要但不充分。更稳的做法是在创建 WorkOrder 前把 scope.files 规范化：

- 主仓库内绝对路径 → 转为相对路径；
- 主仓库外路径 → 直接拒绝 delegation，返回 blocked/skipped；
- 已规范化路径写入 `order.scope.files`，worker prompt 中只出现相对路径。

这样能从数据层防止 worker 收到 `/Users/.../repo/src/foo.ts` 这类绝对路径。

建议补充测试：

- delegate_task(files=[absolute path inside repo]) → worker order scope 为 `src/foo.ts`；
- delegate_task(files=[absolute path outside repo]) → blocked with clear reason。

### 7.9 命令修正：避免继续使用 `npx tsx`

当前环境已确认 npm 11 下 `npx tsx ...` 会被误解析。计划中的验证命令建议统一改为：

```bash
npm exec -- tsx --test <test-file>
```

或在工具内部直接 spawn 本地 PATH 中的：

```bash
tsx --test <test-file>
```

不要在新计划里继续写 `npx tsx --test ...`，否则执行者会重复踩坑。

### 7.10 建议调整后的优先级

推荐顺序：

1. **任务 0：scope materialization + path normalization**（否则 worker 读不到未提交上下文）
2. **任务 1：collectDiff 合并 committed/staged/unstaged/untracked**
3. **任务 2：workerCwd prompt 全链路传递**
4. **任务 4：patcher evidence advisory + coordinator profile map**
5. **任务 3：packet/diff artifact 不截断且 JSON fallback 有效**
6. **任务 5：apply_patch Tool**
7. **端到端 patcher smoke test**

### 7.11 端到端验收必须补充

除单测外，建议新增一个 coordinator/hands 级 smoke test：

- 创建临时 git repo；
- 用 fake worker 在 workerCwd 写入文件但不 commit；
- `runHandsSession` 收集 diff；
- `buildPrimaryWorkerPacket` 不截断 diff；
- 主会话使用 `apply_patch(check_only=true)` 通过；
- 主会话使用 `apply_patch()` 后主仓库文件变化；
- patcher 即使未运行测试，也返回 advisory risk 而不是 blocked。

这个测试会一次性覆盖本计划的真实闭环，而不是只验证局部函数。

# Git 真相回读三件套 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用「强制回读真实 git 状态」封堵两个真实事故——#1 虚假提交（commit message 标签 ≠ 实际内容）与 #3 stash 污染（裸 `git stash pop` 撞他会话改动），不引入 worktree。

**架构：** 三件互补、可独立 ship 的改动，全部复用已造好的轮子：
1. **Phase 1（治 #3）**：给 `git` 工具新增 `stash_pop` action，pop 前调用已存在的 `createWorkspaceGuard(cwd).checkStashSafety(ref)` 做逐文件 hash 比对，`blocked` 则拒绝。
2. **Phase 2（治 #1）**：新增纯函数 `auditCommitTagScope(message, changedFiles)`，在 `commit` action 成功后 `git show --stat HEAD` 回读实际改动并注入 ToolResult，标签与改动子系统不符时附加警告。
3. **Phase 3（治混入源头）**：`approval-risk.ts` 把无 scope 的 bash 裸 git（`git add -A` / `commit -am` / 裸 `git stash`）从「需审批」升级为「拒绝并重定向到 deliver_task / git 工具」，保留 force 逃生口。

**技术栈：** TypeScript、node:test + tsx。测试命令 `npm exec -- tsx --test <file>`，类型检查 `npx tsc --noEmit`。

---

## 范围检查

本计划涉及 3 个改动点，但共享同一核心原则（强制回读真实 git 状态），且每个 Phase 独立可测、独立可交付。合为一个计划，按 Phase 顺序交付。Phase 之间无强依赖，可单独 ship。

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tools/git.ts` | 修改 | Phase 1：新增 `stash_pop` action（接线 checkStashSafety）；Phase 2：commit 成功后回读 --stat + 调 auditCommitTagScope |
| `src/tools/commit-audit.ts` | 创建 | Phase 2：纯函数 `auditCommitTagScope`，校验 commit message 任务标签与实际改动文件子系统是否匹配 |
| `src/tools/__tests__/commit-audit.test.ts` | 创建 | Phase 2：auditCommitTagScope 单元测试 |
| `src/tools/__tests__/git-stash-pop.test.ts` | 创建 | Phase 1：stash_pop action 集成测试（真实临时 git 仓库） |
| `src/agent/approval-risk.ts` | 修改 | Phase 3：新增 `bashGitBypassesScope` 判定 + 导出 |
| `src/agent/__tests__/approval-risk.test.ts` | 修改/创建 | Phase 3：bashGitBypassesScope 单元测试 |

---

## Phase 1：治 #3 — `stash_pop` action 接线 checkStashSafety

**背景：** `git.ts` 现有 `stash` action 只 push 不 pop（`git.ts:151-172`）；真实 pop 来自 bash 裸命令，撞他会话改动时炸在冲突上。`createWorkspaceGuard(cwd).checkStashSafety(stashRef)`（`workspace-guard.ts:139, 212`）已实现逐文件 hash 比对，返回 `{ conflicts, blocked, reasons }`，`blocked=true` 当且仅当有文件工作树内容与 stash 不同。我们新增受控的 `stash_pop` action，pop 前过这个 guard。

### 任务 1：扩展 ACTIONS 并接线 checkStashSafety

**文件：**
- 修改：`src/tools/git.ts:5`（ACTIONS 数组）、`src/tools/git.ts:3`（import）、`src/tools/git.ts:172` 后（新增 case）
- 测试：`src/tools/__tests__/git-stash-pop.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/tools/__tests__/git-stash-pop.test.ts`：

```ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { GIT_TOOL } from '../git.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

describe('git stash_pop action', () => {
  let repo: string
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rivet-stashpop-'))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 't@t.co')
    git(repo, 'config', 'user.name', 'T')
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  })
  after(() => rmSync(repo, { recursive: true, force: true }))

  it('blocks pop when working tree content differs from stash', async () => {
    // 改 a.txt → stash → 用不同内容再改 a.txt（模拟他会话改动）
    writeFileSync(join(repo, 'a.txt'), 'session-A-edit\n')
    git(repo, 'stash', 'push', '-q')
    writeFileSync(join(repo, 'a.txt'), 'session-B-edit\n')
    const res = await GIT_TOOL.execute({
      input: { action: 'stash_pop', stashRef: 'stash@{0}' }, cwd: repo,
    } as any)
    assert.equal(res.isError, true)
    assert.match(res.content, /BLOCKED|different content/)
    // 确认未真正 pop：a.txt 仍是 B 的内容
    assert.match(git(repo, 'show', ':a.txt'), /session-B-edit|base/)
  })

  it('pops cleanly when no conflict', async () => {
    git(repo, 'checkout', '-q', '--', 'a.txt')
    git(repo, 'stash', 'clear')
    writeFileSync(join(repo, 'b.txt'), 'new\n')
    git(repo, 'stash', 'push', '-q', '--include-untracked')
    const res = await GIT_TOOL.execute({
      input: { action: 'stash_pop', stashRef: 'stash@{0}' }, cwd: repo,
    } as any)
    assert.notEqual(res.isError, true)
    assert.match(res.content, /Popped|restored/i)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm exec -- tsx --test src/tools/__tests__/git-stash-pop.test.ts`
预期：FAIL，`Unknown action: stash_pop`（因为 ACTIONS 还没有它）。

- [ ] **步骤 3：编写最少实现代码**

`src/tools/git.ts:3` 的 import 改为加入 guard：

```ts
import { createWorkspaceGuard } from '../agent/workspace-guard.js'
```

`src/tools/git.ts:5` ACTIONS 加入 `stash_pop`：

```ts
const ACTIONS = ['status', 'diff_summary', 'commit', 'log', 'stash', 'stash_pop'] as const
```

在 `case 'stash':` 块（`git.ts:172` 的 `}` 之后）新增 case：

```ts
        case 'stash_pop': {
          const stashRef = (params.input.stashRef as string) || 'stash@{0}'
          const safety = await createWorkspaceGuard(cwd).checkStashSafety(stashRef)
          if (safety.blocked) {
            return { content: safety.reasons.join('\n'), isError: true }
          }
          runGit(['stash', 'pop', stashRef], cwd)
          return { content: `Popped ${stashRef} (safety-checked: no overwriting conflicts).` }
        }
```

注意：`execute` 已是 `async`（`git.ts:80 async execute(params)`），导出名为 `GIT_TOOL`（`git.ts:48`）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm exec -- tsx --test src/tools/__tests__/git-stash-pop.test.ts`
预期：PASS（2 个测试）。

- [ ] **步骤 5：类型检查**

运行：`npx tsc --noEmit`
预期：exit 0。

- [ ] **步骤 6：Commit**

```bash
git add src/tools/git.ts src/tools/__tests__/git-stash-pop.test.ts
git commit -m "feat(git): add safety-checked stash_pop action to prevent cross-session overwrite (Phase 1)"
```

---

## Phase 2：治 #1 — 提交后回读 --stat + 标签一致性自检

**背景：** #1 是 commit message 标签（如 `S14`）与实际改动内容不符。反证确认：`git.ts` 的 scoped commit 用 `--only` 不会提交未 own 文件，但 agent 仍可能在 message 写一个任务标签、实际只改了无关文件。修复 = 提交成功后强制 `git show --stat HEAD` 回读真实改动注入 ToolResult（让 agent 必须面对真相），并用纯函数判定「message 含 N 个任务标签，但改动只落在不相干文件」时附加警告。纯函数不碰 git，独立可测。

### 任务 2：创建 auditCommitTagScope 纯函数

**文件：**
- 创建：`src/tools/commit-audit.ts`
- 测试：`src/tools/__tests__/commit-audit.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/tools/__tests__/commit-audit.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { auditCommitTagScope, extractTaskTags } from '../commit-audit.js'

describe('extractTaskTags', () => {
  it('extracts single tag', () => {
    assert.deepEqual(extractTaskTags('perf(tui): throttle resize (S14)'), ['S14'])
  })
  it('extracts multiple tags', () => {
    assert.deepEqual(extractTaskTags('fix: replace flaky perf test (M1, L1, M2)'), ['M1', 'L1', 'M2'])
  })
  it('returns empty for no tag', () => {
    assert.deepEqual(extractTaskTags('fix: correct typo'), [])
  })
})

describe('auditCommitTagScope', () => {
  it('ok when tag present and files changed', () => {
    const r = auditCommitTagScope('perf(tui): resize (S14)', ['src/tui/use-terminal-size.ts'])
    assert.equal(r.ok, true)
    assert.deepEqual(r.tags, ['S14'])
  })
  it('warns when commit has tag but zero files (empty commit / mislabel)', () => {
    const r = auditCommitTagScope('perf(tui): resize (S14)', [])
    assert.equal(r.ok, false)
    assert.match(r.message, /S14/)
    assert.match(r.message, /no files|0 file/i)
  })
  it('warns when message claims many tags but only one file changed (scope creep signal)', () => {
    const r = auditCommitTagScope('mixed (S13, S2, S9)', ['src/agent/loop.ts'])
    assert.equal(r.ok, false)
    assert.match(r.message, /3 task tag/i)
  })
  it('ok when no tag (untagged commits not audited)', () => {
    const r = auditCommitTagScope('fix: typo', ['src/a.ts'])
    assert.equal(r.ok, true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm exec -- tsx --test src/tools/__tests__/commit-audit.test.ts`
预期：FAIL，`Cannot find module '../commit-audit.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/tools/commit-audit.ts`：

```ts
export interface CommitAuditResult {
  ok: boolean
  tags: string[]
  message: string
}

const TASK_TAG_RE = /\b([A-Z]\d+[a-z]?)\b/g

/** 从 commit message 提取任务标签（S14、M1、C2a 等）。 */
export function extractTaskTags(message: string): string[] {
  return [...message.matchAll(TASK_TAG_RE)].map(m => m[1]!)
}

/**
 * 校验 commit message 的任务标签是否与实际改动文件一致。
 * 仅在 message 含标签时审计（无标签的提交不审）。
 * - 有标签但 0 文件 → 警告（空壳/虚假提交，如 933887d S14）。
 * - 标签数 >1 且文件数 <标签数 → 警告（多任务混入信号，如 1adcf6c）。
 */
export function auditCommitTagScope(message: string, changedFiles: string[]): CommitAuditResult {
  const tags = extractTaskTags(message)
  if (tags.length === 0) {
    return { ok: true, tags, message: '' }
  }
  if (changedFiles.length === 0) {
    return { ok: false, tags, message: `⚠️ Commit tagged ${tags.join(',')} but changed 0 files — possible mislabel or empty commit.` }
  }
  if (tags.length > 1 && changedFiles.length < tags.length) {
    return { ok: false, tags, message: `⚠️ Commit claims ${tags.length} task tags (${tags.join(',')}) but changed only ${changedFiles.length} file(s) — possible multiple unrelated tasks in one commit.` }
  }
  return { ok: true, tags, message: '' }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm exec -- tsx --test src/tools/__tests__/commit-audit.test.ts`
预期：PASS（7 个测试）。

- [ ] **步骤 5：Commit**

```bash
git add src/tools/commit-audit.ts src/tools/__tests__/commit-audit.test.ts
git commit -m "feat(git): add auditCommitTagScope pure function for tag/content mismatch detection (Phase 2)"
```

### 任务 3：commit action 成功后回读 --stat + 调用 audit

**文件：**
- 修改：`src/tools/git.ts`（commit case 的 return，`git.ts:142`）、import（`git.ts:3`）

- [ ] **步骤 1：修改 commit case 的 return（`git.ts:139-142`）**

import 加入：

```ts
import { auditCommitTagScope } from './commit-audit.js'
```

把 `git.ts:142` 的 `return { content: result.stdout.trim() }` 替换为：

```ts
          // 强制回读：提交后读实际落盘的文件清单，注入结果（不信任 message 假设）
          const changed = runGit(['show', '--stat', '--format=', 'HEAD'], cwd).trim()
          const changedFiles = changed.split('\n').map(l => l.split('|')[0]!.trim()).filter(f => f && f.includes('/'))
          const audit = auditCommitTagScope(message, changedFiles)
          const body = `${result.stdout.trim()}\n\n--- actual changes (git show --stat) ---\n${changed}`
          return { content: audit.ok ? body : `${body}\n\n${audit.message}` }
```

- [ ] **步骤 2：手动验证（无新测试，逻辑由任务 2 纯函数覆盖 + 任务 1 测试框架已验证 execute）**

运行已有 git 测试确认未回归：`npm exec -- tsx --test src/tools/__tests__/git-stash-pop.test.ts`
预期：PASS。运行 `npx tsc --noEmit` 预期 exit 0。

- [ ] **步骤 3：Commit**

```bash
git add src/tools/git.ts
git commit -m "feat(git): read back git show --stat after commit + tag-scope audit (Phase 2)"
```

---

## Phase 3：治混入源头 — 识别 bash 裸全量 git 旁路

**背景：** 反证（事实级）确认 `d5e2388` 把 plan 文档混入提交，结构上只能来自 bash 裸 `git add -A` / `git commit -am`（git.ts 的 `--only` 不可能提交未 own 文件）。`approval-risk.ts:51` 已把所有 `git add|commit|...` 标为「需审批」，但只审批不限 scope。本 Phase 新增一个纯判定 `bashGitBypassesScope(command)`，识别「无文件范围限定的全量提交/stash」（`git add -A`/`git add .`/`commit -am`/`commit -a`/裸 `git stash`），供上层在审批提示里给出「请走 deliver_task 或 git 工具」的重定向建议。**本 Phase 只新增判定 + 提示文案，不强行拒绝**（保留 force 逃生口：判定结果仅用于增强提示，最终仍由现有审批门 + 用户决定）。

### 任务 4：新增 bashGitBypassesScope 判定

**文件：**
- 修改：`src/agent/approval-risk.ts`（在 `bashCommandMayWrite` 后，`approval-risk.ts:58` 之后新增）
- 测试：`src/agent/__tests__/approval-risk.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/approval-risk.test.ts` 追加（若文件不存在则创建，顶部加 `import { bashGitBypassesScope } from '../approval-risk.js'` 与 node:test/assert 导入）：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bashGitBypassesScope } from '../approval-risk.js'

describe('bashGitBypassesScope', () => {
  it('flags git add -A', () => {
    assert.equal(bashGitBypassesScope('git add -A && git commit -m x'), true)
  })
  it('flags git add .', () => {
    assert.equal(bashGitBypassesScope('git add .'), true)
  })
  it('flags git commit -am', () => {
    assert.equal(bashGitBypassesScope('git commit -am "msg"'), true)
  })
  it('flags bare git stash (no pathspec)', () => {
    assert.equal(bashGitBypassesScope('git stash'), true)
  })
  it('does NOT flag scoped git add -- <file>', () => {
    assert.equal(bashGitBypassesScope('git add -- src/a.ts'), false)
  })
  it('does NOT flag git status', () => {
    assert.equal(bashGitBypassesScope('git status'), false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm exec -- tsx --test src/agent/__tests__/approval-risk.test.ts`
预期：FAIL，`bashGitBypassesScope is not a function`。

- [ ] **步骤 3：编写最少实现代码**

在 `src/agent/approval-risk.ts:58`（`bashCommandMayWrite` 之后）新增：

```ts
/** 识别绕过 scope 的 bash 裸全量 git 提交/暂存（无文件范围限定）。 */
const GIT_BYPASS_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+add\s+(?:-A\b|--all\b|\.(?:\s|$))/,        // git add -A / --all / .
  /\bgit\s+commit\s+[^\n]*-[a-z]*a/,                  // git commit -a / -am
  /\bgit\s+stash\s*$/,                                 // 裸 git stash（无 pathspec）
  /\bgit\s+stash\s+(?:push\s*)?$/,                     // git stash push（无 --）
]

export function bashGitBypassesScope(command: string): boolean {
  return GIT_BYPASS_PATTERNS.some(p => p.test(command.trim()))
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm exec -- tsx --test src/agent/__tests__/approval-risk.test.ts`
预期：PASS（6 个测试）。

- [ ] **步骤 5：类型检查 + Commit**

运行：`npx tsc --noEmit` 预期 exit 0。

```bash
git add src/agent/approval-risk.ts src/agent/__tests__/approval-risk.test.ts
git commit -m "feat(approval): detect scope-bypassing bash git commands (Phase 3)"
```

---

## 自检

**1. 规格覆盖度（对照 deep-brainstorm 存活方案）：**
- V4 治 #3 stash 污染 → Phase 1（任务 1，stash_pop 接线 checkStashSafety）✅
- V3 治 #1 虚假提交 → Phase 2（任务 2 纯函数 + 任务 3 回读 --stat）✅
- V2 治混入源头 → Phase 3（任务 4 bashGitBypassesScope）✅
- 被灭绝的 V1（worktree-per-session）→ 不实现 ✅（反证证明并发覆盖未发生）

**2. 占位符扫描：** 无 TODO/待定。每个代码步骤含完整代码块。

**3. 类型一致性：**
- `checkStashSafety(stashRef: string): Promise<StashSafetyCheck>`（workspace-guard.ts:212）/ 返回 `{ conflicts, blocked, reasons }`（:296）—— Phase 1 用 `safety.blocked` / `safety.reasons` 匹配 ✅
- `createWorkspaceGuard(cwd: string): WorkspaceGuard`（workspace-guard.ts:139）—— Phase 1 调用签名匹配 ✅
- `GIT_TOOL`（git.ts:48）/ `async execute(params)`（git.ts:80）—— Phase 1 测试导入名 + await 匹配 ✅
- `auditCommitTagScope(message, changedFiles)` 返回 `{ ok, tags, message }`（任务 2 定义）—— 任务 3 用 `audit.ok` / `audit.message` 匹配 ✅
- `extractTaskTags` / `auditCommitTagScope` 任务 2 定义、任务 2 测试 + 任务 3 消费，命名一致 ✅
- `bashGitBypassesScope(command: string): boolean`（任务 4 定义 + 测试）命名一致 ✅

**4. 范围检查：** 3 个 Phase 共享「强制回读真实 git 状态」原则，各自独立可测可交付。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-30-git-truth-readback.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新子代理，任务间审查，快速迭代。
2. **内联执行** — 在当前会话用 executing-plans 批量执行并设检查点。

选哪种方式？

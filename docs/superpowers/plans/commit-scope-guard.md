# Commit Scope Guard 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 防止多个不相关任务的改动混入同一个 commit（scope creep），确保每个 commit 只包含其消息所描述任务的文件。

**架构：** 在 `src/tools/git.ts` 的 `commit` action 中添加 **scope audit** 阶段——在执行 `git commit` 前，提取 commit message 中的任务标签（如 `S14`、`M1`、`B4`），用 `git diff --cached --name-only` 获取即将提交的文件列表，与 `params.ownedFiles` 交叉验证。如果发现"不属于当前任务但已 staged"的文件，发出警告并拒绝提交（可通过 `force: true` 覆盖）。纯函数 `auditCommitScope` 可独立测试，不改变现有 happy path。

**技术栈：** TypeScript、node:test + tsx、git CLI。测试命令 `npm exec -- tsx --test <file>`，类型检查 `npx tsc --noEmit`。

---

## 问题诊断（上一会话的实际事故）

| Commit | 标签 | 实际内容 | 问题 |
|--------|------|----------|------|
| `1adcf6c` | `perf(persist): S13` | S13 compactOaiAsync + **S2 onStreamStart** + **S9-M1 warmup typing** | 3 个任务混入 1 个 commit |
| `933887d` | `perf(tui): S14` | 仅删除 dead `loadOaiAsync`（5 行） | 标签与内容完全不符，S14 未实现 |
| `d5e2388` | `perf(turn-stream): S12` | S12 prewarm setImmediate + **计划文件 547 行** | 计划文档不应随代码提交 |

### 根因链条

1. **Agent 用 `bash` tool 的 `git add` + `git commit` 自由组合提交**——绕过 `scoped-git-commit.ts` 的 `--only` 保护。
2. **`git.ts` commit action 有 scoped 逻辑**（`:122 getScopedCommitFiles`），但只使用 `params.ownedFiles`——若 ownedFiles 未设置（AI 代理未走 B1 流程），则退化为无 scope 限制。
3. **无 pre-commit hook 或 commitlint**——没有任何自动化的"commit 内容与标签不匹配"检测。
4. **多会话共享 worktree**——其他会话 staged 的文件被当前会话的 `git commit` 一起提交。

---

## 范围检查

本方案涉及 2 个独立子系统，但改动紧密耦合，合为一个计划：

1. **Scope audit 纯函数**（新增模块）→ 可独立测试
2. **git.ts commit 集成**（修改现有 commit action）→ 调用纯函数

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tools/commit-audit.ts` | 创建 | 纯函数 `auditCommitScope`：提取任务标签、比较 staged 文件与 owned 文件 |
| `src/tools/__tests__/commit-audit.test.ts` | 创建 | scope audit 单元测试 |
| `src/tools/git.ts:117-142` | 修改 | commit action 中调用 auditCommitScope，有外来文件时拒绝或警告 |
| `.rivet.md` | 修改 | 添加 commit 卫生约定文档 |

---

## 调研背书

### 新增 `auditCommitScope`

- **调用方**：`src/tools/git.ts` commit action（`:117-142`）
- **存在理由**：当前 commit action 在 `ownedFiles` 未设置时无 scope 限制，即使设置了也只做正向白名单（只添加 owned 文件），不检测"是否有非 owned 文件被意外带入"
- **边缘风险**：
  - Agent 未设 ownedFiles → audit 无法判断 scope → 退化为 pass-through（不阻塞现有工作流）
  - Commit message 无任务标签 → audit 跳过标签匹配，只做 owned/staged 比较
  - `force: true` 参数允许覆盖 → 紧急修复场景不受阻

### 修改 `git.ts` commit action

- **调用方**：Agent loop 中 `git` tool 的 `commit` action
- **现有保护**：`getScopedCommitFiles` 用 `--only` 限制 commit 文件范围
- **缺陷**：`ownedFiles` 为空时，`scopedFiles` 为空，进入 `hasStagedChanges` 分支直接提交所有 staged 文件
- **改动**：在 staged 检测后、实际 commit 前，调用 audit 报告外来文件

---

## 任务

### 任务 A1：创建 `auditCommitScope` 纯函数 + 测试

- [ ] **步骤 1：写失败测试**

创建 `src/tools/__tests__/commit-audit.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { auditCommitScope } from '../commit-audit.js'

describe('auditCommitScope', () => {
  it('passes when all staged files are owned', () => {
    const result = auditCommitScope({
      stagedFiles: ['src/agent/loop.ts', 'src/agent/__tests__/loop.test.ts'],
      ownedFiles: ['src/agent/loop.ts', 'src/agent/__tests__/loop.test.ts'],
      commitMessage: 'perf(loop): defer prewarm (S12)',
    })
    assert.equal(result.ok, true)
    assert.equal(result.foreignFiles.length, 0)
  })

  it('detects staged files not in owned list', () => {
    const result = auditCommitScope({
      stagedFiles: ['src/agent/loop.ts', 'src/tui/thinking.tsx', 'src/agent/turn-stream.ts'],
      ownedFiles: ['src/agent/loop.ts'],
      commitMessage: 'perf(loop): defer prewarm (S12)',
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.foreignFiles, ['src/tui/thinking.tsx', 'src/agent/turn-stream.ts'])
    assert.ok(result.message.includes('2 foreign file(s)'))
  })

  it('passes when ownedFiles is undefined (no B1 context)', () => {
    const result = auditCommitScope({
      stagedFiles: ['src/agent/loop.ts', 'src/tui/thinking.tsx'],
      ownedFiles: undefined,
      commitMessage: 'fix: something (X1)',
    })
    assert.equal(result.ok, true)
    assert.equal(result.foreignFiles.length, 0)
  })

  it('extracts task tag from commit message', () => {
    const result = auditCommitScope({
      stagedFiles: ['src/agent/loop.ts'],
      ownedFiles: ['src/agent/loop.ts'],
      commitMessage: 'perf(persist): async atomic rewrite (S13)',
    })
    assert.equal(result.taskTag, 'S13')
  })

  it('handles commit messages without task tags', () => {
    const result = auditCommitScope({
      stagedFiles: ['src/agent/loop.ts'],
      ownedFiles: ['src/agent/loop.ts'],
      commitMessage: 'fix: correct typo in error message',
    })
    assert.equal(result.taskTag, undefined)
    assert.equal(result.ok, true)
  })

  it('includes task tag in warning message for context', () => {
    const result = auditCommitScope({
      stagedFiles: ['src/agent/loop.ts', 'src/tui/thinking.tsx'],
      ownedFiles: ['src/agent/loop.ts'],
      commitMessage: 'perf(persist): async atomic rewrite (S13)',
    })
    assert.ok(result.message.includes('S13'), `warning should mention task tag S13, got: ${result.message}`)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm exec -- tsx --test src/tools/__tests__/commit-audit.test.ts`
预期：FAIL。`Cannot find module '../commit-audit.js'`。

- [ ] **步骤 3：写最小实现**

创建 `src/tools/commit-audit.ts`：

```ts
export interface CommitScopeInput {
  stagedFiles: string[]
  ownedFiles: string[] | undefined
  commitMessage: string
}

export interface CommitScopeResult {
  ok: boolean
  foreignFiles: string[]
  taskTag: string | undefined
  message: string
}

const TASK_TAG_RE = /\(([A-Z]\d+)\)|\[([A-Z]\d+)\]/

/** Extract task tag like S13, M1, B4 from commit message. */
export function extractTaskTag(message: string): string | undefined {
  const match = TASK_TAG_RE.exec(message)
  return match?.[1] ?? match?.[2] ?? undefined
}

/**
 * Audit whether staged files match the task's ownership scope.
 * Returns { ok: true } when no foreign files detected or when
 * ownedFiles is undefined (no B1 context — skip audit).
 */
export function auditCommitScope(input: CommitScopeInput): CommitScopeResult {
  const taskTag = extractTaskTag(input.commitMessage)

  // No B1 context — cannot audit, pass through
  if (input.ownedFiles === undefined) {
    return { ok: true, foreignFiles: [], taskTag, message: 'No B1 ownership context — scope audit skipped.' }
  }

  const ownedSet = new Set(input.ownedFiles)
  const foreignFiles = input.stagedFiles.filter(f => !ownedSet.has(f))

  if (foreignFiles.length === 0) {
    const tagInfo = taskTag ? ` (tag: ${taskTag})` : ''
    return { ok: true, foreignFiles: [], taskTag, message: `All staged files match ownership scope${tagInfo}.` }
  }

  const tagInfo = taskTag ? ` (tag: ${taskTag})` : ''
  const msg = `⚠️ Commit scope creep detected${tagInfo}: ${foreignFiles.length} foreign file(s) not in ownership scope:\n` +
    foreignFiles.map(f => `  - ${f}`).join('\n') +
    '\n\nUse deliver_task for ownership-scoped commit, or add these files to the task scope if intentional.'

  return { ok: false, foreignFiles, taskTag, message: msg }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm exec -- tsx --test src/tools/__tests__/commit-audit.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tools/commit-audit.ts src/tools/__tests__/commit-audit.test.ts
git commit -m "feat(git): add auditCommitScope pure function for commit scope checking (A1)"
```

---

### 任务 A2：集成 scope audit 到 git.ts commit action

- [ ] **步骤 1：读现有代码确认接缝**

`src/tools/git.ts:117-142` 是 commit action。当前流程：
1. `getScopedCommitFiles()` 获取 owned 文件列表
2. 如果有 scopedFiles → `git add -- <scoped>` + `git commit -m <msg> --only -- <scoped>`
3. 如果没有 scopedFiles → `hasStagedChanges()` → 直接 commit 所有 staged

**改动点**：在第 2 步和第 3 步之间，在执行实际 `spawnSync('git', ['commit', ...])` 之前，调用 `auditCommitScope`。如果 audit 失败（有 foreign files），在 commit 输出中追加警告。不阻塞提交（避免过度限制），但将警告信息注入 `ToolResult.content`。

- [ ] **步骤 2：写最小实现**

`src/tools/git.ts` 顶部添加 import：

```ts
import { auditCommitScope } from './commit-audit.js'
```

在 commit action 中（`spawnSync('git', commitArgs, ...)` 之后、return 之前），添加 audit 输出。替换 commit case 的 return 逻辑：

```ts
        case 'commit': {
          const message = params.input.message as string
          if (!message) {
            return { content: 'Commit requires a "message" parameter.', isError: true }
          }

          const scopedFiles = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
          const commitArgs = ['commit', '-m', message]
          if (scopedFiles.length > 0) {
            runGit(['add', '--', ...scopedFiles], cwd)
            commitArgs.push('--only', '--', ...scopedFiles)
          } else if (!hasStagedChanges(cwd)) {
            return {
              content: 'No session-owned files were provided to git commit and no staged changes exist. Use deliver_task with commit=true for ownership-scoped delivery, or stage explicit files if you intentionally manage git manually.',
              isError: true,
            }
          }

          // Scope audit: detect foreign files that shouldn't be in this commit
          const stagedResult = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd, encoding: 'utf-8', timeout: 5000 })
          const stagedFiles = stagedResult.status === 0 ? stagedResult.stdout.split('\0').filter(Boolean) : []
          const audit = auditCommitScope({ stagedFiles, ownedFiles: params.ownedFiles, commitMessage: message })

          const result = spawnSync('git', commitArgs, {
            cwd,
            encoding: 'utf-8',
            timeout: 10_000,
          })
          if (result.status !== 0) {
            return { content: `git commit failed: ${(result.stderr ?? '').trim()}`, isError: true }
          }

          let output = result.stdout.trim()
          if (!audit.ok) {
            output += `\n\n${audit.message}`
          }
          return { content: output }
        }
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npm exec -- tsx --test src/tools/__tests__/commit-audit.test.ts && npx tsc --noEmit`
预期：PASS + 类型检查通过。

- [ ] **步骤 4：Commit**

```bash
git add src/tools/git.ts
git commit -m "feat(git): integrate scope audit into commit action with foreign file warning (A2)"
```

---

### 任务 A3：文档化 commit 卫生约定

- [ ] **步骤 1：在 `.rivet.md` 添加约定**

在 `.rivet.md` 的 `## Code Conventions` 部分（`Test framework` 行之后）追加：

```markdown
- Each commit must contain only files related to its task tag (e.g. S12, M1). Use `deliver_task` for scoped commits. If using `git` tool directly, stage only task-relevant files before committing. The scope audit will warn on foreign files.
- Never bundle multiple task tags in one commit. If two tasks touch the same file, commit them separately with the relevant subset.
- Plan documents (docs/superpowers/plans/) go in their own commit, never mixed with code changes.
```

- [ ] **步骤 2：Commit**

```bash
git add .rivet.md
git commit -m "docs: add commit scope hygiene conventions (A3)"
```

---

## 验证

### 全局验证命令

```bash
# 类型检查
npx tsc --noEmit

# 单元测试
npm exec -- tsx --test src/tools/__tests__/commit-audit.test.ts

# 确认 git tool 编译通过
npx tsc --noEmit 2>&1 | grep git.ts
```

### 预期结果

| 命令 | 预期 |
|------|------|
| `npx tsc --noEmit` | exit 0 |
| `commit-audit.test.ts` | 全部 PASS（6 个测试） |
| `grep git.ts` | 无错误输出 |

---

## 自检

- **Spec 覆盖度：**
  - scope creep 检测 → A1（纯函数）+ A2（集成）✅
  - ownedFiles 未设置时的退化 → A1 测试覆盖 ✅
  - 无任务标签的 commit message → A1 测试覆盖 ✅
  - commit 卫生约定文档 → A3 ✅
- **占位符扫描：** 无 TODO / TBD / 待定。每个步骤含具体代码。
- **类型一致性：** `auditCommitScope(input: CommitScopeInput): CommitScopeResult`（A1 定义）/ `CommitScopeInput` 含 `{ stagedFiles: string[], ownedFiles: string[] | undefined, commitMessage: string }`（A2 调用点构造的参数与之匹配）/ `extractTaskTag(message: string): string | undefined`（A1 内部使用）。
- **不影响现有 happy path：** audit 仅在 commit 成功后追加警告文本，不阻塞提交。`ownedFiles` 为 undefined 时跳过审计。

---

## 未来优化方向（不在本计划范围）

以下是基于上一次会话事故分析识别出的额外改进点，记录在此供后续迭代参考：

1. **Pre-commit hook**：用 Husky + 自定义脚本在 `git commit` 前运行 scope audit，自动阻止 scope creep（需要 `npm install husky` + `.husky/pre-commit` 脚本）
2. **bash tool git commit 拦截**：当前 AI agent 可通过 `bash` tool 执行任意 `git commit`，完全绕过 `git.ts` 的 scope 保护。可在 `bash.ts` 中检测 `git commit` 命令并重定向到 `git.ts` 的 commit action
3. **Commit message lint**：用 commitlint 强制 conventional commit 格式 + 任务标签
4. **多会话文件冲突检测**：`git stash pop` 冲突的根本原因是多会话共享 worktree。长期方案是 worktree per session（`git worktree add`）

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/commit-scope-guard.md`。两种执行方式：
1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？

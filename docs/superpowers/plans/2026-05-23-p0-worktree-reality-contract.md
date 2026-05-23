# Worktree Reality Contract 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现一个纯异步函数 `detectWorktreeReality(cwd, injected?)`，用于检测注入上下文与实时 git 工作区状态是否一致，返回结构化 mismatch 报告和 severity 等级。

**架构：** 新模块 `src/agent/worktree-reality.ts` 导出两个 interface 和一个 async 函数。函数内部通过 `execFile`（promisified）调用 `git rev-parse` 系列命令获取实际状态，再与可选的注入上下文逐字段比较，输出 `green/yellow/red` 严重度。不接入 AgentLoop，不改 prompt，不改 TUI。

**技术栈：** TypeScript strict + `node:child_process` execFile (promisified) + `node:test` + `node:assert/strict`

---

## 1. Scope Check

| 项 | 是否在范围 | 说明 |
|---|---|---|
| `src/agent/worktree-reality.ts` | ✅ 新建 | 核心模块 |
| `src/agent/__tests__/worktree-reality.test.ts` | ✅ 新建 | 测试 |
| 接入 AgentLoop | ❌ 不做 | 纯函数独立交付 |
| 修改 `prompt/static.ts` | ❌ 不做 | 不影响 prefix cache |
| 修改 TUI | ❌ 不做 | 无 UI 变更 |
| 归属星轨 ledger | ❌ 不做 | 不处理运行时 artifact 归属 |
| 注册到 `src/main.tsx` | ❌ 不做 | 非工具，纯函数 |

范围限制在 2 个新文件，0 个修改文件。

---

## 2. File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/agent/worktree-reality.ts` | 创建 | 导出 `InjectedWorktreeContext` interface、`WorktreeReality` interface、`detectWorktreeReality()` 函数。内部 `gitExec()` helper 调用 git 命令。 |
| `src/agent/__tests__/worktree-reality.test.ts` | 创建 | 使用临时 git repo 测试所有分支：cwd 不存在、非 git repo、无注入上下文、完全匹配、branch/HEAD/cwd/isGitRepo 不匹配。 |

### 关键依赖（已有代码，只参考不修改）

| 文件 | 参考内容 |
|---|---|
| `src/agent/git-freshness.ts:1-30` | `gitSpawn` pattern：spawn + stdout pipe + trim + error→empty。本模块采用相同思路但用 `execFile` + promisify（与 checkpoint.ts 一致）。 |
| `src/agent/__tests__/git-freshness.test.ts:1-30` | 测试 pattern：`mkdtempSync` + `execSync`（仅 setup）+ `afterEach` 清理 `tempDirs` 数组。 |
| `src/agent/__tests__/worktree-coordinator.test.ts:1-20` | `git init -b main` 确定初始分支名。 |

---

## 3. Tasks

---

### Task 1: 创建源文件骨架 — 接口定义 + 抛出式 stub

**目的：** 建立类型契约，确保后续 typecheck 有锚点。

**创建：** `src/agent/worktree-reality.ts`

```typescript
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface InjectedWorktreeContext {
  cwd?: string
  branch?: string
  head?: string
  isGitRepo?: boolean
}

export interface WorktreeReality {
  cwd: string
  isGitRepo: boolean
  repoRoot?: string
  branch?: string
  head?: string
  statusAvailable: boolean
  injectedContextMatchesReality: boolean
  mismatchReasons: string[]
  severity: 'green' | 'yellow' | 'red'
}

async function gitExec(args: string[], cwd: string, timeoutMs = 5000): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      timeout: timeoutMs,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function detectWorktreeReality(
  _cwd: string,
  _injected?: InjectedWorktreeContext,
): Promise<WorktreeReality> {
  throw new Error('not implemented')
}
```

**验证命令：**

```bash
npx tsc --noEmit
```

**期望结果：** 0 errors, exit 0。

**提交：**

```bash
git add src/agent/worktree-reality.ts && git commit -m "feat(agent): scaffold worktree-reality interfaces and stub"
```

- [ ] Task 1 完成

---

### Task 2: 创建测试文件 — helper + 全部测试用例

**目的：** 一次性写完所有测试用例（TDD 红灯阶段），之后逐批实现让它们通过。

**创建：** `src/agent/__tests__/worktree-reality.test.ts`

```typescript
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { detectWorktreeReality } from '../worktree-reality.js'

const tempDirs: string[] = []

/** Create a temporary git repo with one commit on branch 'main'. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-reality-test-'))
  tempDirs.push(dir)
  execSync('git init -b main', { cwd: dir })
  execSync('git config user.email "test@test"', { cwd: dir })
  execSync('git config user.name "test"', { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A', { cwd: dir })
  execSync('git commit -m "init"', { cwd: dir })
  return dir
}

/** Create a bare temporary directory (not a git repo). */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-reality-test-'))
  tempDirs.push(dir)
  return dir
}

/** Read current HEAD hash from a git repo. */
function getHead(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim()
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore cleanup failures */
    }
  }
})

describe('detectWorktreeReality', () => {
  // ── A. CWD 不存在 ──────────────────────────────────────
  it('returns red when cwd does not exist', async () => {
    const result = await detectWorktreeReality(
      '/nonexistent/path/that/does/not/exist',
    )
    assert.equal(result.severity, 'red')
    assert.equal(result.isGitRepo, false)
    assert.equal(result.statusAvailable, false)
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('cwd does not exist')),
    )
  })

  // ── B. 非 git repo ─────────────────────────────────────
  it('returns green when cwd exists but is not a git repo and no injected context', async () => {
    const dir = makeTempDir()
    const result = await detectWorktreeReality(dir)
    assert.equal(result.severity, 'green')
    assert.equal(result.isGitRepo, false)
    assert.equal(result.statusAvailable, false)
    assert.equal(result.injectedContextMatchesReality, true)
    assert.equal(result.mismatchReasons.length, 0)
  })

  it('returns red when injected says isGitRepo=true but cwd is not a git repo', async () => {
    const dir = makeTempDir()
    const result = await detectWorktreeReality(dir, { isGitRepo: true })
    assert.equal(result.severity, 'red')
    assert.equal(result.isGitRepo, false)
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('isGitRepo')),
    )
  })

  // ── C. 有效 git repo，无注入上下文 ──────────────────────
  it('returns green for valid git repo with no injected context', async () => {
    const dir = makeGitRepo()
    const result = await detectWorktreeReality(dir)
    assert.equal(result.severity, 'green')
    assert.equal(result.isGitRepo, true)
    assert.equal(result.statusAvailable, true)
    assert.ok(result.repoRoot)
    assert.equal(result.branch, 'main')
    assert.ok(result.head)
    assert.equal(result.injectedContextMatchesReality, true)
    assert.equal(result.mismatchReasons.length, 0)
  })

  // ── D. 注入上下文完全匹配 ─────────────────────────────
  it('returns green when injected context matches reality', async () => {
    const dir = makeGitRepo()
    const head = getHead(dir)
    const result = await detectWorktreeReality(dir, {
      cwd: dir,
      branch: 'main',
      head,
      isGitRepo: true,
    })
    assert.equal(result.severity, 'green')
    assert.equal(result.injectedContextMatchesReality, true)
    assert.equal(result.mismatchReasons.length, 0)
  })

  // ── E. Branch 不匹配 → yellow ──────────────────────────
  it('returns yellow on branch mismatch', async () => {
    const dir = makeGitRepo()
    const head = getHead(dir)
    const result = await detectWorktreeReality(dir, {
      branch: 'wrong-branch',
      head,
      isGitRepo: true,
    })
    assert.equal(result.severity, 'yellow')
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('branch mismatch')),
    )
    assert.equal(
      result.mismatchReasons.some(r => r.includes('HEAD mismatch')),
      false,
    )
  })

  // ── F. HEAD 不匹配 → red ───────────────────────────────
  it('returns red on HEAD mismatch', async () => {
    const dir = makeGitRepo()
    const result = await detectWorktreeReality(dir, {
      head: '0000000000000000000000000000000000000000',
      branch: 'main',
      isGitRepo: true,
    })
    assert.equal(result.severity, 'red')
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('HEAD mismatch')),
    )
  })

  // ── G. CWD 不匹配 → yellow ────────────────────────────
  it('returns yellow on cwd mismatch', async () => {
    const dir = makeGitRepo()
    const head = getHead(dir)
    const result = await detectWorktreeReality(dir, {
      cwd: '/some/other/path',
      branch: 'main',
      head,
      isGitRepo: true,
    })
    assert.equal(result.severity, 'yellow')
    assert.ok(
      result.mismatchReasons.some(r => r.includes('cwd mismatch')),
    )
  })

  // ── H. HEAD + Branch 同时不匹配 → red ─────────────────
  it('returns red when HEAD and branch both mismatch', async () => {
    const dir = makeGitRepo()
    const result = await detectWorktreeReality(dir, {
      head: '0000000000000000000000000000000000000000',
      branch: 'wrong-branch',
      isGitRepo: true,
    })
    assert.equal(result.severity, 'red')
    assert.ok(
      result.mismatchReasons.some(r => r.includes('HEAD mismatch')),
    )
    assert.ok(
      result.mismatchReasons.some(r => r.includes('branch mismatch')),
    )
  })

  // ── I. isGitRepo 反向不匹配 → yellow ──────────────────
  it('returns yellow when injected says isGitRepo=false but actual is a git repo', async () => {
    const dir = makeGitRepo()
    const result = await detectWorktreeReality(dir, {
      isGitRepo: false,
    })
    assert.equal(result.severity, 'yellow')
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('isGitRepo')),
    )
  })
})
```

**验证命令：**

```bash
npx tsc --noEmit
```

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/worktree-reality.test.ts
```

**期望结果：** typecheck 通过（0 errors）。所有 10 个测试失败，错误信息为 `Error: not implemented`。

**提交：**

```bash
git add src/agent/__tests__/worktree-reality.test.ts && git commit -m "test(agent): add worktree-reality test suite (all red, stub throws)"
```

- [ ] Task 2 完成

---

### Task 3: 实现 `detectWorktreeReality` — 完整功能

**目的：** 用完整实现替换 stub，让全部 10 个测试从红变绿。

**修改：** `src/agent/worktree-reality.ts:46-50`

将 stub 函数体：

```typescript
export async function detectWorktreeReality(
  _cwd: string,
  _injected?: InjectedWorktreeContext,
): Promise<WorktreeReality> {
  throw new Error('not implemented')
}
```

替换为完整实现：

```typescript
export async function detectWorktreeReality(
  cwd: string,
  injected?: InjectedWorktreeContext,
): Promise<WorktreeReality> {
  // ── 1. CWD 存在性检查 ──
  if (!existsSync(cwd)) {
    return {
      cwd,
      isGitRepo: false,
      statusAvailable: false,
      injectedContextMatchesReality: false,
      mismatchReasons: [`cwd does not exist: ${cwd}`],
      severity: 'red',
    }
  }

  // ── 2. Git 仓库检测 ──
  const repoRoot = await gitExec(['rev-parse', '--show-toplevel'], cwd)
  if (!repoRoot) {
    const isGitRepoMismatch = injected?.isGitRepo === true
    return {
      cwd,
      isGitRepo: false,
      statusAvailable: false,
      injectedContextMatchesReality: !isGitRepoMismatch,
      mismatchReasons: isGitRepoMismatch
        ? ['injected context says isGitRepo=true but directory is not a git repo']
        : [],
      severity: isGitRepoMismatch ? 'red' : 'green',
    }
  }

  // ── 3. 采集实际状态 ──
  const branch = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  const head = await gitExec(['rev-parse', 'HEAD'], cwd)

  // ── 4. 无注入上下文 → 直接返回 green ──
  if (!injected) {
    return {
      cwd,
      isGitRepo: true,
      repoRoot,
      branch: branch || undefined,
      head: head || undefined,
      statusAvailable: true,
      injectedContextMatchesReality: true,
      mismatchReasons: [],
      severity: 'green',
    }
  }

  // ── 5. 注入上下文 vs 实际逐字段比较 ──
  const mismatchReasons: string[] = []

  // HEAD 不匹配
  if (injected.head && head && injected.head !== head) {
    mismatchReasons.push(`HEAD mismatch: injected=${injected.head}, actual=${head}`)
  }

  // Branch 不匹配
  if (injected.branch && branch && injected.branch !== branch) {
    mismatchReasons.push(`branch mismatch: injected=${injected.branch}, actual=${branch}`)
  }

  // CWD 不匹配（resolve 到绝对路径再比较）
  if (injected.cwd) {
    const resolvedInjected = resolve(injected.cwd)
    const resolvedActual = resolve(cwd)
    if (resolvedInjected !== resolvedActual) {
      mismatchReasons.push(`cwd mismatch: injected=${resolvedInjected}, actual=${resolvedActual}`)
    }
  }

  // isGitRepo 反向不匹配（注入=false，实际=true）
  if (injected.isGitRepo === false) {
    mismatchReasons.push('injected context says isGitRepo=false but directory is a git repo')
  }

  // ── 6. Severity 判定 ──
  // HEAD 不匹配 → red；其他不匹配 → yellow；无不匹配 → green
  const hasHeadMismatch = mismatchReasons.some(r => r.startsWith('HEAD mismatch'))
  let severity: 'green' | 'yellow' | 'red' = 'green'
  if (hasHeadMismatch) {
    severity = 'red'
  } else if (mismatchReasons.length > 0) {
    severity = 'yellow'
  }

  return {
    cwd,
    isGitRepo: true,
    repoRoot,
    branch: branch || undefined,
    head: head || undefined,
    statusAvailable: true,
    injectedContextMatchesReality: mismatchReasons.length === 0,
    mismatchReasons,
    severity,
  }
}
```

**注意：** 函数签名中 `_cwd` / `_injected` 的下划线前缀也要去掉（已在上面代码中处理）。

**验证命令：**

```bash
npx tsc --noEmit
```

期望：0 errors, exit 0。

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/worktree-reality.test.ts
```

期望：10 tests passed, 0 failed。

**提交：**

```bash
git add src/agent/worktree-reality.ts && git commit -m "feat(agent): implement detectWorktreeReality with severity comparison"
```

- [ ] Task 3 完成

---

### Task 4: 最终验证 — typecheck + 全量测试 + 完整提交

**目的：** 确保新代码不破坏已有测试套件，做最终签收。

**验证命令：**

```bash
npx tsc --noEmit
```

期望：0 errors, exit 0。

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/worktree-reality.test.ts
```

期望：10 tests passed, 0 failed。

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/*.test.ts
```

期望：所有 agent 测试通过（含已有的 git-freshness、checkpoint、worktree-coordinator 等测试）。

**提交：** 无新文件需要提交。如有未提交的调整（如调整 import 顺序、注释等），使用：

```bash
git add -u && git commit -m "chore(agent): finalize worktree-reality module"
```

- [ ] Task 4 完成

---

## 4. Verification

| 验证项 | 命令 | 期望 |
|---|---|---|
| TypeScript 类型检查 | `npx tsc --noEmit` | exit 0, 0 errors |
| 新模块独立测试 | `./node_modules/.bin/tsx --test src/agent/__tests__/worktree-reality.test.ts` | 10 tests, 0 failures |
| Agent 测试套件无回归 | `./node_modules/.bin/tsx --test src/agent/__tests__/*.test.ts` | 全部通过 |
| 不接 AgentLoop | grep 确认 `worktree-reality` 不被 `src/main.tsx` 或 `src/agent/loop.ts` 导入 | 0 matches |
| 不改 static.ts | `git diff src/prompt/static.ts` | 无变更 |

---

## 5. Self-Check

### 5.1 Spec 覆盖率

| 需求 | 覆盖任务 | 测试用例 |
|---|---|---|
| 使用 `execFile`/`spawn`，不用 `execSync` | Task 1, 3 | 代码审查：`gitExec` 使用 `promisify(execFile)` |
| 非 git repo 不抛异常，返回 red | Task 3 | 测试 B: `returns red when injected says isGitRepo=true but cwd is not a git repo` |
| cwd 不存在不抛异常，返回 red | Task 3 | 测试 A: `returns red when cwd does not exist` |
| branch 不匹配 → yellow | Task 3 | 测试 E: `returns yellow on branch mismatch` |
| HEAD 不匹配 → red | Task 3 | 测试 F: `returns red on HEAD mismatch` |
| cwd 不匹配 → yellow | Task 3 | 测试 G: `returns yellow on cwd mismatch` |
| 测试用 `node:test` + `assert/strict` | Task 2 | 文件头部 import |
| 测试创建临时 git repo | Task 2 | `makeGitRepo()` helper |
| 不依赖当前仓库状态 | Task 2 | 使用 `mkdtempSync`，`afterEach` 清理 |

### 5.2 占位符扫描

- ✅ 无 TODO / TBD / 待定 / 后续实现
- ✅ 无 "添加适当的错误处理" 式模糊描述
- ✅ 无 "为上述代码编写测试" 式引用
- ✅ 无 "类似任务 N" 式引用

### 5.3 类型一致性

| 名称 | 定义位置 | 使用位置 | 一致 |
|---|---|---|---|
| `InjectedWorktreeContext` | `worktree-reality.ts:9-14` | 函数参数类型 + 测试中构造对象 | ✅ |
| `WorktreeReality` | `worktree-reality.ts:16-28` | 函数返回类型 + 测试中断言字段 | ✅ |
| `detectWorktreeReality` | `worktree-reality.ts:46` | 测试 import `../worktree-reality.js` | ✅ |
| `gitExec` | `worktree-reality.ts:38` | 仅模块内部调用 | ✅ |
| `severity` 字段 | interface 定义 `'green' \| 'yellow' \| 'red'` | 所有 return 语句 + 所有 assert | ✅ |
| `mismatchReasons` 字段 | `string[]` | 所有 return 语句 + `result.mismatchReasons.some(...)` | ✅ |

---

## 6. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-23-p0-worktree-reality-contract.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？

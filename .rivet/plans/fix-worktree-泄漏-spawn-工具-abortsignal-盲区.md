# fix: worktree 泄漏 + spawn 工具 abortSignal 盲区

# Plan: worktree 泄漏 + spawn 工具 abortSignal 盲区

## Scope Check

只碰以下文件，不涉及其他子系统：

| 文件 | 改什么 |
|------|--------|
| `src/agent/worktree.ts` | createWorktree 失败清理 + createWorktreeAt 同口径 |
| `src/agent/hands-session.ts` | create() 移入 try |
| `src/agent/verification-snapshot-manager.ts` | 新增 reapOrphanHandsWorktrees |
| `src/tools/grep.ts` | tryRipgrep 接入 abortSignal |
| `src/tools/git.ts` | runGit 接入 abortSignal |
| `src/tools/diff.ts` | execute spawn 接入 abortSignal |

不碰：TUI 渲染、loop、prompt、compact、cache、config。

---

## S1: worktree 创建失败/崩溃泄漏

### S1a — `createWorktree` 失败时清理 mkdtemp 目录

`src/agent/worktree.ts:94-99`

当前：`mkdtempSync` → `git worktree add` → `throw`（git 失败时目录泄漏）
改后：git 失败时 `rmSync(wtPath, { recursive: true, force: true })` 再 throw。

```ts
export function createWorktree(cwd, sessionId, branch): CreatedWorktree {
  const wtPath = mkdtempSync(join(tmpdir(), `rivet-wt-${sessionId.slice(0, 8)}-`))
  const result = git(cwd, buildWorktreeArgs(wtPath, branch))
  if (!result.ok) {
    try { rmSync(wtPath, { recursive: true, force: true }) } catch {}
    throw new Error(`failed to create git worktree for ${sessionId}`)
  }
  return { path: wtPath, branch }
}
```

`createWorktreeAt`（L107-112）同理——虽然路径是调用方指定的，但 git 失败时 `mkdirSync` 已创建父目录，需同口径清理。

### S1b — `runHandsSession` create() 移入 try

`src/agent/hands-session.ts:70`

当前：`create()` 在 `try` 之前，失败抛异常时 `finally` 不执行，worktree 泄漏。
改后：`create()` 移入 `try` 块内第一行。

```ts
export async function runHandsSession(config): Promise<HandsSessionRun> {
  try {
    const wt = config.wtCoordinator.create(config.order.id)  // ← 移入 try
    config.order.workerCwd = wt.path
    // ... 其余逻辑不变
  } finally {
    config.wtCoordinator.remove(config.order.id)
  }
}
```

### S1c — 启动时 reap `/tmp/rivet-wt-*` 孤儿 worktree

`src/agent/verification-snapshot-manager.ts` — 新增 `reapOrphanHandsWorktrees()` 函数。

当前：`reapOrphanSnapshots` 只扫 `.rivet/vsw/*`（VSW 快照），Hands worktree 在 `/tmp/rivet-wt-*` 下，永不回收。
改后：新增函数扫描 `/tmp/rivet-wt-*` 目录，检查 owner pid 存活性（复用 `isPidAlive`），清理死进程留下的 worktree。

```ts
export function reapOrphanHandsWorktrees(opts: {
  isAlive?: (pid: number) => boolean
  removeWorktreeDir?: (baseCwd: string, dir: string) => void
}): ReapOrphanSnapshotsResult { ... }
```

Owner marker 写入：`createWorktree` 成功后在 wtPath 写入 `.vsw-owner.json`（复用 `writeOwnerMarker`），`removeWorktree` 成功后删除。

启动时调用：`bootstrap.ts` 中在 `reapOrphanSnapshots` 之后追加 `reapOrphanHandsWorktrees`。

---

## S2: spawn 工具 abortSignal 盲区

### 通用模式（对齐 `bash.ts` + `run-tests.ts`）

三个工具均遵循同一模式——在 spawn 后立即接入 `params.abortSignal`：

```ts
const signal = params.abortSignal
const onAbort = () => {
  clearTimeout(timer)
  gracefulKill(child) // 或 killProcessTree
  resolve({ content: 'Aborted by user.', isError: false })
}
if (signal) {
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
}

child.on('close', () => {
  clearTimeout(timer)
  if (signal) signal.removeEventListener('abort', onAbort)
  // ... resolve
})
```

### S2a — `grep.ts` tryRipgrep

`src/tools/grep.ts:254-330`

`tryRipgrep` 函数签名追加 `abortSignal?: AbortSignal` 参数。在调用点（L95）传入 `params.abortSignal`。

### S2b — `git.ts` runGit

`src/tools/git.ts:22-80`

`runGit` 函数签名追加 `abortSignal?: AbortSignal` 参数。各 `runGit(...)` 调用点传入 `params.abortSignal`。

⚠ `runGit` 已有 `detached: true` + `killProcessTree` 超时模式——abortSignal 处理复用同一 kill 路径，不改变现有超时逻辑。

### S2c — `diff.ts` execute

`src/tools/diff.ts:66-115`

直接在 Promise 内接入 `params.abortSignal`，参照 bash.ts 模式。

---

## 验证计划

每阶段完成后：
1. `npx tsc --noEmit` — typecheck
2. 相关测试：`src/__tests__/worktree.test.ts`、`src/tools/__tests__/grep.test.ts`、`src/tools/__tests__/git.test.ts`
3. 全量：`npm exec -- tsx --test src/**/__tests__/*.test.ts`

### S1 反证测试

| 测试 | 验证点 |
|------|--------|
| createWorktree git 失败后 wtPath 目录已清理 | 不泄漏 |
| runHandsSession create 抛异常后 remove 被调用 | 不泄漏 |
| reapOrphanHandsWorktrees 清理死进程 worktree | 启动回收 |

### S2 反证测试

| 测试 | 验证点 |
|------|--------|
| grep abortSignal 触发 → rg 子进程被 kill | 不残留 |
| git abortSignal 触发 → git 子进程被 kill | 不残留 |
| diff abortSignal 触发 → git diff 子进程被 kill | 不残留 |

---

## 风险

- **低**：`createWorktree` 的 `rmSync` 在 git 失败后清理——git 失败通常意味着目录为空，清理安全。
- **低**：`hands-session.ts` 把 `create()` 移入 `try`——`finally` 里 `remove()` 对不存在的 worktree 已是 no-op（`WorktreeCoordinator.remove` 检查 `active.get()`）。
- **低**：spawn 工具加 abortSignal——对齐已有模式（bash.ts/run-tests.ts/apply-patch.ts），不引入新范式。

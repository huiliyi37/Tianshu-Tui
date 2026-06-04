# 提交事实回执与持久化 实现计划

> **状态：✅ 已全部实施** — post-commit git show readback

**目标：** 修复 commit 回执丢失 hash 的问题，并在压缩后让 agent 仍能回忆提交事实——三层：展示修复（A）、claim 持久化（B）、归属兜底（C）。

**架构：** 三层同源于一个核心洞察：提交事实必须写进 agent 决策点强制可见的外部记录，不信任工作记忆。
- **A 层（展示）**：`git.ts` 的 `git show --stat --format=` 用空 format 抹掉了 hash → 改 `--format=%h%d`；`deliver_task` 的 scoped commit 路径完全没有 truth readback → 补上。2-3 行 + 10 行。
- **B 层（持久化）**：在 `claim-extractor.ts` 加 commit 结果识别分支，产出 `decision` kind claim（TTL=Infinity），靠现有 `<active-claims>` 自动注入机制让压缩后的 agent 仍可见。零新基础设施。
- **C 层（归属兜底）**：`autoOwnFromBaseline` 对 baseline 外的 dirty 文件无条件 auto-own → 加 ledger 痕迹第二维度，无痕迹的退回不 auto-own。低频但致命。

**技术栈：** TypeScript strict · Node.js 22 · node:test + node:assert/strict · ESM（导入带 `.js` 扩展）。

**设计来源：** `docs/superpowers/specs/2026-05-30-commit-fact-amnesia-design.md`

**对设计文档的优化意见（已纳入本计划）：**
1. 设计文档 Layer A 只提了 `git.ts` 的 `--format=` 修复，但遗漏了 `deliver_task` 的 scoped commit 路径完全没有 truth readback。本计划补上。
2. 设计文档 Layer B 方向正确，但本计划将 extractor 分支设计为同时覆盖 `git` commit 和 `deliver_task` commit 两条路径，避免单点盲区。
3. 设计文档 Layer C 低频但致命——本计划保留，但将实现简化为只增加一个 `hasLedgerTrace` 守卫，不改变外部 API。

---

## 现状（已读真实代码）

### 提交回执链路

| 入口 | 文件:行号 | 回执行为 | 问题 |
|---|---|---|---|
| `git` 工具 commit 分支 | `src/tools/git.ts:146` | `git show --stat --format= HEAD` → 空格式**抹掉 hash** | 用户看不到 hash |
| `deliver_task` commit 分支 | `src/agent/deliver-task.ts:231-247` | 只输出 `commitResult.output`（git 原始 stdout） | 无 truth readback，无文件级审计 |

`git commit` stdout 格式：`[branch abc1234] message`（hash 在此），但被 `--- actual changes ---` 后的空 format stat 输出淹没。

### Claim 持久化链路

- `extractClaimsFromToolResult`（`src/context/claim-extractor.ts:30`）：tool-pipeline 在每次工具调用后调用（`src/agent/tool-pipeline.ts:716`），proposals 经 `store.propose()` 入库。
- 当前分支覆盖：`read_file` → `file_observation`，测试 → `verification_fact`/`failure_pattern`，安全 → `security_finding`。**无 commit 分支**。
- `<active-claims>` 注入（`src/context/claims.ts:184`）：`renderActiveClaimsBlock` 取前 20 条 active claims 注入 prompt。`decision` kind 的 TTL=Infinity（`claim-extractor.ts:23`），天然持久。

### 归属链路

- `autoOwnFromBaseline`（`src/agent/ownership-ledger.ts:75-84`）：闭包内可访问 `taskLedger`（`:55` 解构）。当前逻辑：dirty 文件不在 baseline external → 无条件 auto-own。缺第二维度：是否有 ledger `file_write`/`git_action` 事件痕迹。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| 修改 `src/tools/git.ts:146` | `--format=` → `--format=%h%d`，hash+refs 进 stat 输出首行 |
| 修改 `src/agent/deliver-task.ts:231-247` | scoped commit 后补 truth readback（`git show --stat --format=%h%d HEAD`） |
| 修改 `src/context/claim-extractor.ts` | 加 `commitFact` 分支，识别 git/deliver_task commit 结果 |
| 测试 `src/context/__tests__/claim-extractor.test.ts` | 验证 commit 结果被提取为 `decision` claim |
| 修改 `src/agent/ownership-ledger.ts:75-84` | `autoOwnFromBaseline` 加 ledger 痕迹守卫 |
| 测试 `src/agent/__tests__/ownership-ledger.test.ts` | 验证无 ledger 痕迹的 dirty 文件不被 auto-own |

---

## 调研背书

### `git.ts:146` — `--format=` 空格式

**存在理由：** 设计者只想看 stat 行（文件列表 + 变更统计），不想要 `git show` 默认的 commit message/header。但空 `--format=` 连短 hash 也抹掉了。

**调用方：** 只在 commit 分支内部使用，结果拼入 `body` 返回给 agent。无外部依赖。

**边缘情况：** `--format=%h%d` 在无 tag 时只输出 `abc1234`（无多余字符）；有 tag 时输出 `abc1234 (HEAD -> main, tag: v1.0)`——两者均为可扫文本。

### `deliver-task.ts:231-247` — scoped commit 路径

**存在理由：** `deliver_task` 是 B1 交付门工具，commit 只走 `commitScopedFiles`（`src/agent/scoped-git-commit.ts:15`），后者只做 `git add --only && git commit`，不跑 `git show --stat`。

**调用方：** 只有 `deliver_task` 的 commit=true 分支调用 `commitScopedFiles`。

**边缘情况：** `commitScopedFiles` 成功后 `commitResult.output` 包含 git 原始 stdout（`[branch abc1234] message\n N files changed...`），hash 在此但不易定位。补 truth readback 让 hash 显式出现在独立行。

### `claim-extractor.ts` — commit 事实提取

**存在理由：** tool-pipeline 的通用 claim 提取器，在每次工具调用后自动运行。设计为可扩展的分支结构（`if/else if` 链）。

**调用方：** `tool-pipeline.ts:716` 唯一调用点。proposals 经 `store.propose()` 入库，自动进入 `<active-claims>` 注入。

**边缘情况：** git commit 可能失败（`isError=true`），此时不应提取 claim。deliver_task commit 也可能走 YELLOW/RED 路径不执行实际 commit，需检测 `✅ Scoped commit created` 标记。

### `ownership-ledger.ts:75-84` — autoOwnFromBaseline

**存在理由：** 处理 `autoOwnFromLedger` 未覆盖的新建文件场景——如果 agent 创建了一个新文件但 ledger 尚未记录 `file_write` 事件（例如通过 bash 重定向），该文件不在 ledger 里但确实是本会话创建的。

**调用方：** `deliver-task.ts:127` 在每次 `deliver_task` 执行时调用。

**边缘情况：** 多会话共享 worktree 时，另一个会话创建的新文件（不在 baseline 里）会被误 auto-own。加 ledger 痕迹检查后，无痕迹的文件不 auto-own（保持 unclassified，后续由人工或 yellow 路径处理）。

---

## 任务 1：修复 git show-stat hash 显示

**文件：**
- 修改：`src/tools/git.ts:146`

- [ ] **步骤 1：编辑 `--format=` 为 `--format=%h%d`**

将 `src/tools/git.ts:146`：

```typescript
          const changed = runGit(['show', '--stat', '--format=', 'HEAD'], cwd).trim()
```

改为：

```typescript
          const changed = runGit(['show', '--stat', '--format=%h%d', 'HEAD'], cwd).trim()
```

- [ ] **步骤 2：验证 typecheck**

运行：`npx tsc --noEmit 2>&1 | grep "error TS"`
预期：无输出（无类型错误）。

- [ ] **步骤 3：运行 git 工具测试**

运行：`npx tsx --test src/tools/__tests__/git.test.ts`
预期：全部 PASS。

- [ ] **步骤 4：Commit**

```bash
git add src/tools/git.ts
git commit -m "fix(git): restore commit hash in show-stat readback via --format=%h%d"
```

---

## 任务 2：deliver_task scoped commit 补 truth readback

**文件：**
- 修改：`src/agent/deliver-task.ts:241-247`

- [ ] **步骤 1：在 scoped commit 成功后加 truth readback**

在 `src/agent/deliver-task.ts`，将 commit 成功后的输出块（约 `:241-247`）：

```typescript
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${report.ownedFiles.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
```

改为：

```typescript
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${report.ownedFiles.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
        // Post-commit truth readback: verify actual landed changes + surface hash
        const readback = spawnSync('git', ['show', '--stat', '--format=%h%d', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 10_000 })
        if (readback.status === 0) {
          lines.push('', '--- actual changes (git show --stat) ---')
          lines.push(readback.stdout.trim())
        }
```

需确认文件顶部已有 `spawnSync` 导入（已有，`deliver-task.ts` 多处使用 `spawnSync`）。

- [ ] **步骤 2：验证 typecheck**

运行：`npx tsc --noEmit 2>&1 | grep "error TS"`
预期：无输出。

- [ ] **步骤 3：运行 deliver_task 测试**

运行：`npx tsx --test src/agent/__tests__/deliver-task.test.ts`
预期：全部 PASS。

- [ ] **步骤 4：Commit**

```bash
git add src/agent/deliver-task.ts
git commit -m "feat(deliver-task): add truth readback to scoped commit path"
```

---

## 任务 3：commit 事实 claim 提取

**文件：**
- 修改：`src/context/claim-extractor.ts`
- 测试：`src/context/__tests__/claim-extractor.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/context/__tests__/claim-extractor.test.ts` 末尾添加：

```typescript
describe('commit fact extraction', () => {
  it('extracts decision claim from git commit result', () => {
    const ctx: ToolResultContext = {
      toolName: 'git',
      input: { command: 'commit', message: 'fix: restore hash in show-stat readback' },
      result: '[feat/knowledge-manifest-minimal abc1234] fix: restore hash in show-stat readback\n 2 files changed, 10 insertions(+), 2 deletions(-)\n\n--- actual changes (git show --stat) ---\nabc1234 (HEAD -> feat/knowledge-manifest-minimal)\n src/tools/git.ts | 3 ++-\n 1 file changed, 3 insertions(+), 2 deletions(-)',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'decision')
    assert.match(proposals[0]!.text, /abc1234/)
    assert.match(proposals[0]!.text, /restore hash/)
    assert.equal(proposals[0]!.expiresAt, undefined) // Infinity TTL via decision kind
  })

  it('extracts decision claim from deliver_task commit result', () => {
    const ctx: ToolResultContext = {
      toolName: 'deliver_task',
      input: { commit: true, message: 'fix: scoped commit' },
      result: 'Delivery Gate: GREEN\n\n✅ Scoped commit created with message: "fix: scoped commit"\n   Files: src/a.ts, src/b.ts\n   [main def5678] fix: scoped commit\n 2 files changed, 5 insertions(+)\n\n--- actual changes (git show --stat) ---\ndef5678 (HEAD -> main)\n src/a.ts | 3 ++-\n src/b.ts | 2 +-\n 2 files changed, 5 insertions(+), 2 deletions(-)',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'decision')
    assert.match(proposals[0]!.text, /def5678/)
  })

  it('does not extract claim from failed commit', () => {
    const ctx: ToolResultContext = {
      toolName: 'git',
      input: { command: 'commit', message: 'test' },
      result: 'git commit failed: nothing to commit',
      isError: true,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 0)
  })

  it('does not extract claim from non-commit git commands', () => {
    const ctx: ToolResultContext = {
      toolName: 'git',
      input: { command: 'log', maxCount: 5 },
      result: 'abc1234 fix: something\ndef5678 feat: other',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/context/__tests__/claim-extractor.test.ts`
预期：新测试 FAIL（commit 结果不会被提取，返回空数组）。

- [ ] **步骤 3：实现 commit 事实提取**

在 `src/context/claim-extractor.ts` 的 `extractClaimsFromToolResult` 函数中，在 `return []` 终尾之前加：

```typescript
  // Commit fact: extract hash + message as a decision claim (Infinity TTL)
  // Covers both `git commit` and `deliver_task` commit paths
  const isCommitResult = (ctx.toolName === 'git' && String(ctx.input.command ?? '') === 'commit')
    || (ctx.toolName === 'deliver_task' && ctx.input.commit === true)
  if (isCommitResult && !ctx.isError) {
    return [commitFact(ctx, meta, now)]
  }
```

在同一文件底部（`securityFinding` 函数之后）添加：

```typescript
const COMMIT_HASH_RE = /\b([0-9a-f]{7,40})\b/

function commitFact(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const hashMatch = ctx.result.match(COMMIT_HASH_RE)
  const hash = hashMatch?.[1] ?? 'unknown'
  const message = String(ctx.input.message ?? '').slice(0, 80)
  // Extract file list from stat lines (lines with |)
  const statLines = ctx.result.split('\n')
    .map(l => l.split('|')[0]?.trim() ?? '')
    .filter(f => f.length > 0 && !f.includes('file changed') && !f.includes('files changed') && !f.startsWith('('))
  const files = statLines.length > 0 ? statLines.slice(0, 5).join(', ') : 'unknown files'
  const text = `Commit ${hash}: "${message}" (${files})`
  return {
    kind: 'decision',
    scope: 'session',
    text,
    confidence: 0.95,
    fitness: 8,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:commit`, kind: 'tool_result' as EvidenceKind, summary: text, createdAt: now }],
    createdAt: now,
    // decision kind has TTL=Infinity in the TTL table — no expiresAt needed
    tags: ['tool', 'commit', 'git'],
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/context/__tests__/claim-extractor.test.ts`
预期：全部 PASS（包括新增的 4 个 commit fact 测试）。

- [ ] **步骤 5：typecheck**

运行：`npx tsc --noEmit 2>&1 | grep "error TS"`
预期：无输出。

- [ ] **步骤 6：Commit**

```bash
git add src/context/claim-extractor.ts src/context/__tests__/claim-extractor.test.ts
git commit -m "feat(claims): extract commit-fact decision claims from git/deliver_task results"
```

---

## 任务 4：归属守卫——autoOwnFromBaseline 加 ledger 痕迹检查

**文件：**
- 修改：`src/agent/ownership-ledger.ts:75-84`
- 测试：`src/agent/__tests__/ownership-ledger.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/ownership-ledger.test.ts` 末尾添加：

```typescript
describe('autoOwnFromBaseline ledger trace guard', () => {
  it('does not auto-own dirty file without ledger trace', () => {
    const baseline = createBaseline({ existing: ['src/old.ts'] })
    const ledger = createTaskLedger({ taskId: 'test' })
    // ledger has NO events for 'src/new-from-other.ts'
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/new-from-other.ts'])
    assert.equal(ownership.isOwned('src/new-from-other.ts'), false)
  })

  it('auto-owns dirty file that has a ledger file_write trace', () => {
    const baseline = createBaseline({ existing: ['src/old.ts'] })
    const ledger = createTaskLedger({ taskId: 'test' })
    ledger.record({ type: 'file_write', path: 'src/new-ours.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/new-ours.ts'])
    assert.equal(ownership.isOwned('src/new-ours.ts'), true)
  })

  it('auto-owns dirty file that has a ledger git_action trace', () => {
    const baseline = createBaseline({ existing: ['src/old.ts'] })
    const ledger = createTaskLedger({ taskId: 'test' })
    ledger.record({ type: 'git_action', path: 'src/staged.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/staged.ts'])
    assert.equal(ownership.isOwned('src/staged.ts'), true)
  })
})
```

注意：需检查测试文件头部是否已有 `createBaseline` 和 `createTaskLedger` 的导入。若不存在，添加：

```typescript
import { createTaskLedger } from '../task-ledger.js'
```

`createBaseline` 若不存在，需用一个最小 stub：接受 `{ existing: string[] }` 参数，返回一个 `WorktreeBaseline` 对象（`isExternal(path)` 对 existing 中的文件返回 true）。需检查现有测试文件中的 baseline 构造方式。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/ownership-ledger.test.ts`
预期：新测试 FAIL（`autoOwnFromBaseline` 无条件 auto-own，导致无 ledger 痕迹的文件也被 own）。

- [ ] **步骤 3：实现 ledger 痕迹守卫**

将 `src/agent/ownership-ledger.ts:75-84` 的 `autoOwnFromBaseline`：

```typescript
  function autoOwnFromBaseline(dirtyFiles: string[]): void {
    for (const f of dirtyFiles) {
      // Already classified — skip
      if (ownedSet.has(f) || coOwnedSet.has(f)) continue
      // Pre-existing in baseline — not ours to auto-own
      if (baseline.isExternal(f)) continue
      // New file created this session → auto-own
      ownedSet.add(f)
    }
  }
```

改为：

```typescript
  function autoOwnFromBaseline(dirtyFiles: string[]): void {
    // Collect paths that have ledger traces for fast lookup
    const ledgerPaths = new Set<string>()
    for (const event of taskLedger.getEvents()) {
      if ((event.type === 'file_write' || event.type === 'git_action') && event.path) {
        ledgerPaths.add(event.path)
      }
    }
    for (const f of dirtyFiles) {
      // Already classified — skip
      if (ownedSet.has(f) || coOwnedSet.has(f)) continue
      // Pre-existing in baseline — not ours to auto-own
      if (baseline.isExternal(f)) continue
      // Must have a ledger trace (file_write/git_action) to auto-own.
      // Files modified by other sessions without our ledger record are not ours.
      if (!ledgerPaths.has(f)) continue
      ownedSet.add(f)
    }
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/ownership-ledger.test.ts`
预期：全部 PASS。

- [ ] **步骤 5：运行 deliver_task 测试回归**

运行：`npx tsx --test src/agent/__tests__/deliver-task.test.ts`
预期：全部 PASS（deliver_task 调用 `autoOwnFromBaseline`，新的守卫不应阻断正常路径——正常路径下文件都有 ledger 痕迹）。

- [ ] **步骤 6：typecheck**

运行：`npx tsc --noEmit 2>&1 | grep "error TS"`
预期：无输出。

- [ ] **步骤 7：Commit**

```bash
git add src/agent/ownership-ledger.ts src/agent/__tests__/ownership-ledger.test.ts
git commit -m "fix(ownership): guard autoOwnFromBaseline with ledger trace check"
```

---

## 任务 5：全量回归

**文件：** 无（仅验证）

- [ ] **步骤 1：运行全量测试**

运行：`npm exec -- tsx --test src/**/__tests__/*.test.ts`
预期：全部 PASS。已知 `activity-status` 的 "transitions to testing after 2 consecutive run_tests" 是预存 flaky，与本改动无关。

- [ ] **步骤 2：typecheck**

运行：`npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 3：构建确认**

运行：`npm run build`
预期：tsup 构建成功。

---

## 自检

**1. 设计文档覆盖度：**

| 设计层 | 治哪个症状 | 对应任务 | 备注 |
|---|---|---|---|
| A（展示） | "看不到标签号" | 任务 1 + 任务 2 | 设计文档只提 git.ts，本计划补上 deliver_task 路径 |
| B（持久化） | "追问时混乱失忆" | 任务 3 | 复用 `<active-claims>` 自动注入，零新基础设施 |
| C（归属） | "误提交他人文件" | 任务 4 | 低频兜底，5 行守卫 |
| 回归 | 整体不破坏 | 任务 5 | 全量测试 + typecheck + 构建 |

**2. 占位符扫描：** 无 TODO / TBD / 待定 / 后续实现 / 补充细节 / 类似任务 N。每个代码步骤含完整代码 + 精确行号/位置。

**3. 类型一致性：**
- `ClaimProposal` 的 `kind: 'decision'` 在 `claims.ts:7` 的 `ContextClaimKind` 联合中存在；TTL 表（`claim-extractor.ts:23`）中 `decision: Infinity` 已有。
- `EvidenceKind` 的 `'tool_result'` 在 `claims.ts:26` 存在。
- `TaskLedgerEvent.type` 的 `'file_write'` / `'git_action'` 在 `task-ledger.ts:17-23` 存在。
- `spawnSync` 在 `deliver-task.ts` 已有导入（多处使用），无需新增。
- `extractClaimsFromToolResult` 的返回类型 `ClaimProposal[]` 与 `commitFact` 返回类型一致。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-30-commit-truth-readback.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？

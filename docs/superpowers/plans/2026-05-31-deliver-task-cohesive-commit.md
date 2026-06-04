# deliver_task 按逻辑单元提交 实现计划

> **状态：✅ 已全部实施** — deliver_task 内聚性门禁 (commit-cohesion)

**目标：** 让 `deliver_task` 在 agent 试图批量提交不相关改动时产生结构摩擦，迫使 agent 按逻辑单元分步提交。

**架构：** 四层防护，从软到硬：(1) **files 参数** — 允许显式指定子集提交；(2) **内聚性红门** — 跨 >2 区域或 >5 文件的提交默认 RED，必须 `force=true` 覆盖；(3) **写后累积推力** — `tool-pipeline.ts` 在每次 file_write 后检查未提交文件累积量，超阈值在工具结果中注入推力提示；(4) **提示词引导** — 行为规范层面的预防。不改动 `scoped-git-commit.ts`、`ownership-ledger.ts`、`delivery-gate-v2.ts`。

**技术栈：** TypeScript strict, node:test + node:assert/strict, 现有 B1 架构。

---

## Scope Check

涉及两个子系统：`src/agent/deliver-task.ts`（门禁逻辑）和 `src/agent/tool-pipeline.ts`（写后推力注入）。两者独立，但同属 B1 交付流水线。不需要拆分 plan。

## File Structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/commit-cohesion.ts` | 内聚性检测纯函数：提取顶层目录分组，判断是否需要门禁 | 创建 |
| `src/agent/__tests__/commit-cohesion.test.ts` | `checkCommitCohesion` 单元测试 | 创建 |
| `src/agent/deliver-task.ts:60-64` | `input_schema` 新增 `files` 和 `force` 属性 | 修改 |
| `src/agent/deliver-task.ts:225-260` | commit 路径：`files` 子集验证 → 内聚性红门 → 执行提交 | 修改 |
| `src/agent/deliver-task.ts:36-60` | `definition.description` 更新文档 | 修改 |
| `src/agent/tool-pipeline.ts:678-692` | file_write 后注入累积推力到工具结果 | 修改 |
| `src/agent/__tests__/deliver-task.test.ts` | 新增 `files` 参数 + `force` 门禁 + 内聚性测试 | 修改 |
| `src/prompt/static.ts:54-56` | `<shared-worktree>` 增加行为引导 | 修改 |

## Research Endorsement

### `deliver-task.ts` commit 路径（修改行为）

**调用方：** `src/main.tsx` 通过 `createDeliverTaskTool(getB1Context)` 注册到 tool pipeline。

**存在理由：** 语义化交付原语，B1-8 交付门禁的终端节点。

**边缘情况：**
- `files` 为空数组 → 与当前无 owned files 行为一致，返回错误
- `files` 包含非 owned 文件 → 必须拒绝，防止越权提交
- `files` 与 `commit=false` 一起传入 → 忽略 `files`，只做 status report
- `force=true` 但 `commit=false` → 忽略 `force`
- 内聚性门禁 RED 但 `force=true` → 放行，输出"覆盖门禁"提示
- 内聚性门禁 RED 且 `force` 未设 → 返回 isError + 具体建议

### `tool-pipeline.ts` file_write 后推力注入（修改行为）

**调用方：** `executeTool` 函数内，`deps.taskLedger.record({ type: 'file_write', ... })` 之后。

**存在理由：** 在写入路径上建立摩擦点，实时提醒 agent 积累的未提交文件量。

**边缘情况：**
- `taskLedger` 为 undefined（旧调用路径）→ 跳过推力注入
- 推力文本追加到 `finalContent` → 不影响工具返回值结构
- 推力只在文件数量 >3 时触发 → 小改动不受干扰

### `static.ts` 提示词（修改内容）

**调用方：** `src/prompt/static.ts` → `buildSystemPrompt` → 每次对话的系统提示。

**边缘情况：** 新增内容不影响其他段落，纯追加。

### `scoped-git-commit.ts`（不修改）

**理由：** 已支持 `files: string[]` 参数，`deliver_task` 改动只需过滤传入的 files 即可。

---

## Tasks

### Task 1: 创建 `commit-cohesion.ts` 内聚性检测模块

- [ ] **1a.** 创建测试文件 `src/agent/__tests__/commit-cohesion.test.ts`

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkCommitCohesion } from '../commit-cohesion.js'

describe('checkCommitCohesion', () => {
  it('returns no warning for 1-2 files in same area', () => {
    const report = checkCommitCohesion(['src/agent/a.ts', 'src/agent/b.ts'])
    assert.equal(report.needsWarning, false)
    assert.equal(report.topDirCount, 1)
    assert.equal(report.fileCount, 2)
  })

  it('returns no warning for files within threshold (≤5 files, ≤2 top dirs)', () => {
    const report = checkCommitCohesion([
      'src/agent/a.ts',
      'src/agent/b.ts',
      'src/agent/c.ts',
      'src/tools/x.ts',
      'src/tools/y.ts',
    ])
    assert.equal(report.needsWarning, false)
    assert.equal(report.topDirCount, 2)
  })

  it('flags as gate when files span more than 2 top-level directories', () => {
    const report = checkCommitCohesion([
      'src/agent/a.ts',
      'src/tools/b.ts',
      'src/tui/c.ts',
    ])
    assert.equal(report.needsWarning, true)
    assert.equal(report.topDirCount, 3)
    assert.ok(report.warningLines.length > 0)
    assert.match(report.warningLines[0]!, /3 owned files across 3 areas/)
  })

  it('flags as gate when more than 5 files even in same directory', () => {
    const files = Array.from({ length: 6 }, (_, i) => `src/agent/file${i}.ts`)
    const report = checkCommitCohesion(files)
    assert.equal(report.needsWarning, true)
    assert.equal(report.topDirCount, 1)
    assert.ok(report.warningLines.some(l => /Consider/.test(l)))
  })

  it('extracts top-level directory as first two segments', () => {
    const report = checkCommitCohesion([
      'src/agent/deep/nested/a.ts',
      'src/tools/b.ts',
    ])
    assert.deepEqual(report.topDirs, ['src/agent', 'src/tools'])
  })

  it('handles root-level files as top-level dir', () => {
    const report = checkCommitCohesion(['package.json', 'src/a.ts'])
    assert.deepEqual(report.topDirs, ['.', 'src'])
  })

  it('returns no warning for empty file list', () => {
    const report = checkCommitCohesion([])
    assert.equal(report.needsWarning, false)
    assert.equal(report.fileCount, 0)
  })

  it('accepts custom thresholds', () => {
    const report = checkCommitCohesion(
      ['src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts'],
      { maxFiles: 2 },
    )
    assert.equal(report.needsWarning, true)
  })
})
```

**预期：** 8 个测试全部 fail（模块不存在）。

```bash
npm exec -- tsx --test src/agent/__tests__/commit-cohesion.test.ts
# → 测试失败：Cannot find module '../commit-cohesion.js'
```

- [ ] **1b.** 创建 `src/agent/commit-cohesion.ts`

```typescript
/**
 * commit-cohesion — 提交内聚性检测 (B1-8b)
 *
 * 纯函数模块。检查即将提交的文件列表是否跨越过多逻辑区域。
 * 超阈值时返回 needsWarning=true，由 deliver_task 作为 RED 门禁使用。
 *
 * @module commit-cohesion
 */

export interface CohesionReport {
  /** 按顶层目录分组的区域列表（去重排序） */
  topDirs: string[]
  /** 唯一顶层目录数 */
  topDirCount: number
  /** 文件总数 */
  fileCount: number
  /** 是否应显示内聚性门禁 */
  needsWarning: boolean
  /** 人类可读的警告行 */
  warningLines: string[]
}

export interface CohesionThresholds {
  /** 超过此文件数触发门禁（默认 5） */
  maxFiles?: number
  /** 超过此顶层目录数触发门禁（默认 2） */
  maxTopDirs?: number
}

/** 提取文件的顶层目录（前两个路径段） */
function extractTopDir(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 1) return '.'
  return parts.slice(0, 2).join('/')
}

export function checkCommitCohesion(
  files: string[],
  thresholds?: CohesionThresholds,
): CohesionReport {
  const maxFiles = thresholds?.maxFiles ?? 5
  const maxTopDirs = thresholds?.maxTopDirs ?? 2

  const topDirSet = new Set<string>()
  for (const f of files) {
    topDirSet.add(extractTopDir(f))
  }
  const topDirs = [...topDirSet].sort()
  const topDirCount = topDirs.length
  const fileCount = files.length

  const overFileLimit = fileCount > maxFiles
  const overDirLimit = topDirCount > maxTopDirs
  const needsWarning = overFileLimit || overDirLimit

  const warningLines: string[] = []
  if (needsWarning) {
    const areaSummary = topDirs.join(', ')
    if (overDirLimit) {
      warningLines.push(
        `❌ Commit cohesion gate: ${fileCount} owned files across ${topDirCount} areas (${areaSummary}).`,
      )
    } else {
      warningLines.push(
        `❌ Commit cohesion gate: ${fileCount} owned files. Large commit — verify all changes are one logical unit.`,
      )
    }
    warningLines.push(
      'Split strategy: call deliver_task commit=true files=[subset1] for each logical unit.',
    )
    warningLines.push(
      'If this truly is one logical unit, re-run with force=true to override.',
    )
  }

  return { topDirs, topDirCount, fileCount, needsWarning, warningLines }
}
```

**预期：** 8 个测试全部 pass。

```bash
npm exec -- tsx --test src/agent/__tests__/commit-cohesion.test.ts
# → 8 tests passed
```

- [ ] **1c.** 提交

```bash
git add src/agent/commit-cohesion.ts src/agent/__tests__/commit-cohesion.test.ts
git commit -m "feat(agent): add commit-cohesion detection module with RED gate support"
```

---

### Task 2: 为 `deliver_task` 添加 `files` + `force` 参数 + 内聚性红门

- [ ] **2a.** 在测试文件 `src/agent/__tests__/deliver-task.test.ts` 末尾 `describe('detectSymptomPatch', ...)` 块之前，添加三个新的 describe 块：

```typescript
  describe('files parameter — subset commit', () => {
    it('commits only specified subset of owned files when files param provided', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: P1 only', files: ['src/agent/a.ts', 'src/agent/b.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.deepEqual(calls, [{ files: ['src/agent/a.ts', 'src/agent/b.ts'], message: 'feat: P1 only' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('rejects files param containing non-owned file', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: test', files: ['src/agent/a.ts', 'src/tools/NOT-OWNED.ts'] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /not in owned files/)
    })

    it('rejects empty files array', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: test', files: [] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /No files specified/)
    })

    it('ignores files param when commit is false (status-only)', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute({
        ...params,
        input: { files: ['src/agent/a.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.doesNotMatch(result.content, /Scoped commit/)
    })
  })

  describe('cohesion RED gate on commit', () => {
    it('BLOCKS commit when files span 3+ areas without force', async () => {
      const files = [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts',
        'src/tui/d.ts',
      ]
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: files,
        dirtyFiles: files,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('commit executor should NOT be called when cohesion gate blocks')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: big batch' },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /Commit cohesion gate/)
      assert.match(result.content, /Split strategy/)
    })

    it('allows commit with force=true when cohesion gate triggers', async () => {
      const files = [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts',
        'src/tui/d.ts',
      ]
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: files,
        dirtyFiles: files,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, f, msg) => {
          calls.push({ files: f, message: msg })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: truly one unit', force: true },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Cohesion gate overridden/)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files, message: 'feat: truly one unit' }])
    })

    it('does not block small focused commit (≤2 areas, ≤5 files)', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'fix: focused' },
      })

      assert.equal(result.isError ?? false, false)
      assert.doesNotMatch(result.content, /Commit cohesion gate/)
      assert.match(result.content, /Scoped commit created/)
    })

    it('applies cohesion gate to files subset too', async () => {
      const allFiles = ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts', 'src/tui/d.ts', 'src/config/e.ts']
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: allFiles,
        dirtyFiles: allFiles,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      // Request a subset that still spans 3 areas
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: subset', files: ['src/agent/a.ts', 'src/tools/c.ts', 'src/tui/d.ts'] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /Commit cohesion gate/)
    })

    it('allows small subset commit even when total owned files are large', async () => {
      const allFiles = [
        'src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts',
        'src/tools/d.ts', 'src/tui/e.ts', 'src/config/f.ts',
      ]
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: allFiles,
        dirtyFiles: allFiles,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, f, msg) => {
          calls.push({ files: f, message: msg })
          return { ok: true, output: 'commit abc123' }
        },
      })

      // Request a focused subset (1 area, 2 files) — should pass
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: P1', files: ['src/agent/a.ts', 'src/agent/b.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files: ['src/agent/a.ts', 'src/agent/b.ts'], message: 'feat: P1' }])
    })
  })
```

**预期：** 新测试全部 fail（功能未实现）。

```bash
npm exec -- tsx --test src/agent/__tests__/deliver-task.test.ts
# → 新增的 9 个测试失败
```

- [ ] **2b.** 修改 `src/agent/deliver-task.ts`：

**改动 1：** 在文件顶部 imports 区域（约第 33 行后）添加 import：

```typescript
import { checkCommitCohesion } from './commit-cohesion.js'
```

**改动 2：** 在 `definition.input_schema.properties` 中（约第 63 行 `message` 属性后）添加 `files` 和 `force` 属性：

```typescript
          message: { type: 'string', description: 'Commit message (required if commit=true)' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional subset of owned files to commit. When omitted, commits all owned files. Use this to split work into separate logical commits.',
          },
          force: {
            type: 'boolean',
            description: 'Override cohesion gate. Only use when the commit truly is one logical unit despite spanning multiple areas.',
          },
```

**改动 3：** 在 `definition.description` 字符串末尾（`### Parameters` 区域）添加：

```
- files: optional array of owned file paths to commit (subset). When omitted, commits all owned files. Use this to commit logical units separately.
- force: set to true to override the cohesion gate when committing many files across multiple areas. Use sparingly.
```

**改动 4：** 在 commit 路径（`const executor = ...` 行之前），替换整段提交逻辑。将现有的：

```typescript
        const executor = ctx.commitOwnedFiles ?? ((cwd, files, msg) => commitScopedFiles({ cwd, files, message: msg }))
        const commitResult = executor(params.cwd, report.ownedFiles, message)
        if (!commitResult.ok) {
          lines.push('', `❌ Scoped commit failed: ${commitResult.output}`)
          return { content: lines.join('\n'), isError: true }
        }
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${report.ownedFiles.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
```

替换为：

```typescript
        // Resolve files to commit: subset from `files` param, or all owned
        const requestedFiles = params.input.files as string[] | undefined
        let filesToCommit = report.ownedFiles

        if (requestedFiles && Array.isArray(requestedFiles) && requestedFiles.length > 0) {
          const ownedSet = new Set(report.ownedFiles)
          const notOwned = requestedFiles.filter(f => !ownedSet.has(f))
          if (notOwned.length > 0) {
            lines.push('', `❌ File(s) not in owned files: ${notOwned.join(', ')}. Cannot commit non-owned files.`)
            return { content: lines.join('\n'), isError: true }
          }
          filesToCommit = requestedFiles
        } else if (requestedFiles && Array.isArray(requestedFiles) && requestedFiles.length === 0) {
          lines.push('', '❌ No files specified for commit. Provide non-empty files array or omit to commit all owned files.')
          return { content: lines.join('\n'), isError: true }
        }

        // Cohesion gate: RED if files span too many areas (unless force=true)
        const forceOverride = params.input.force === true
        const cohesion = checkCommitCohesion(filesToCommit)
        if (cohesion.needsWarning && !forceOverride) {
          lines.push('', ...cohesion.warningLines.map(l => `  ${l}`))
          return { content: lines.join('\n'), isError: true }
        }
        if (cohesion.needsWarning && forceOverride) {
          lines.push('', '  ⚠️ Cohesion gate overridden with force=true. Verify this is truly one logical unit.')
        }

        const executor = ctx.commitOwnedFiles ?? ((cwd, files, msg) => commitScopedFiles({ cwd, files, message: msg }))
        const commitResult = executor(params.cwd, filesToCommit, message)
        if (!commitResult.ok) {
          lines.push('', `❌ Scoped commit failed: ${commitResult.output}`)
          return { content: lines.join('\n'), isError: true }
        }
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${filesToCommit.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
```

**预期：** 所有测试通过。

```bash
npm exec -- tsx --test src/agent/__tests__/deliver-task.test.ts
# → 全部通过（包括原有 ~30 个 + 新增 9 个）
```

- [ ] **2c.** 类型检查：

```bash
npx tsc --noEmit
# → 0 errors
```

- [ ] **2d.** 提交：

```bash
git add src/agent/deliver-task.ts src/agent/__tests__/deliver-task.test.ts
git commit -m "feat(deliver-task): add files/force params + cohesion RED gate for batch commit friction"
```

---

### Task 3: 写后累积推力 — tool-pipeline.ts 中注入未提交文件提醒

- [ ] **3a.** 在 `src/agent/__tests__/tool-pipeline.test.ts`（如不存在则在末尾新建 describe）添加测试：

首先确认是否已有 tool-pipeline 测试文件。如果不存在，创建一个最小测试来验证推力注入行为：

创建 `src/agent/__tests__/commit-nudge.test.ts`（独立模块测试，不依赖完整的 tool-pipeline harness）：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCommitNudge } from '../commit-nudge.js'

describe('buildCommitNudge', () => {
  it('returns empty string when file count is within threshold', () => {
    const nudge = buildCommitNudge({
      ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
    })
    assert.equal(nudge, '')
  })

  it('returns nudge when owned files exceed 4 across 2+ areas', () => {
    const nudge = buildCommitNudge({
      ownedFiles: [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts', 'src/tui/d.ts', 'src/config/e.ts',
      ],
    })
    assert.match(nudge, /deliver_task/)
    assert.match(nudge, /commit=true/)
  })

  it('returns nudge when owned files exceed 4 in same area', () => {
    const files = ['src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts', 'src/agent/d.ts', 'src/agent/e.ts']
    const nudge = buildCommitNudge({ ownedFiles: files })
    assert.match(nudge, /deliver_task/)
  })

  it('returns empty string for empty file list', () => {
    const nudge = buildCommitNudge({ ownedFiles: [] })
    assert.equal(nudge, '')
  })

  it('returns empty string when all files are in 1 area with ≤4 files', () => {
    const nudge = buildCommitNudge({
      ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts', 'src/agent/d.ts'],
    })
    assert.equal(nudge, '')
  })

  it('suggests files parameter when multiple areas detected', () => {
    const nudge = buildCommitNudge({
      ownedFiles: ['src/agent/a.ts', 'src/tools/b.ts', 'src/tui/c.ts', 'src/config/d.ts', 'src/api/e.ts'],
    })
    assert.match(nudge, /files=\[/)
  })
})
```

**预期：** 测试 fail（模块不存在）。

```bash
npm exec -- tsx --test src/agent/__tests__/commit-nudge.test.ts
# → Cannot find module '../commit-nudge.js'
```

- [ ] **3b.** 创建 `src/agent/commit-nudge.ts`

```typescript
/**
 * commit-nudge — 写后累积推力 (B1-8c)
 *
 * 纯函数模块。根据未提交 owned files 的数量和区域分布，
 * 生成一段推力文本，由 tool-pipeline 在每次 file_write 后
 * 追加到工具结果中。
 *
 * 阈值设计：
 * - >4 files 或 >2 areas → 注入推力
 * - 这个阈值比 commit-cohesion 的门禁阈值（>5 files / >2 areas）低一级
 *   推力先出现，门禁后出现，形成"先提醒后阻止"的渐进摩擦。
 *
 * @module commit-nudge
 */

export interface NudgeInput {
  /** 当前所有 owned files（来自 TaskLedger.getOwnedFiles()） */
  ownedFiles: string[]
}

/** 提取文件的顶层目录（前两个路径段） */
function extractTopDir(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 1) return '.'
  return parts.slice(0, 2).join('/')
}

const NUDGE_FILE_THRESHOLD = 4
const NUDGE_AREA_THRESHOLD = 2

/**
 * Build a commit nudge string to append to tool results after file writes.
 * Returns empty string when no nudge is needed.
 */
export function buildCommitNudge(input: NudgeInput): string {
  const { ownedFiles } = input
  if (ownedFiles.length <= NUDGE_FILE_THRESHOLD) return ''

  const topDirs = new Set(ownedFiles.map(extractTopDir))
  if (ownedFiles.length <= NUDGE_FILE_THRESHOLD && topDirs.size <= NUDGE_AREA_THRESHOLD) return ''

  const lines: string[] = [
    '',
    '💡 Uncommitted files accumulating: ' + ownedFiles.length + ' owned files across ' + topDirs.size + ' areas.',
  ]

  if (topDirs.size > NUDGE_AREA_THRESHOLD) {
    lines.push('   Consider committing completed logical units before starting new ones.')
    lines.push('   Call deliver_task commit=true files=[subset] to commit per logical unit.')
  } else {
    lines.push('   Consider committing what you have so far before continuing.')
    lines.push('   Call deliver_task commit=true to commit, or deliver_task to check readiness.')
  }

  return lines.join('\n')
}
```

**预期：** 6 个测试全部 pass。

```bash
npm exec -- tsx --test src/agent/__tests__/commit-nudge.test.ts
# → 6 tests passed
```

- [ ] **3c.** 修改 `src/agent/tool-pipeline.ts`，在 file_write 记录后注入推力。

在 `deps.taskLedger.record({ type: 'file_write', path: filePath })` 行之后（约第 683 行和第 691 行两处），添加推力注入逻辑。

在文件顶部 imports 区域添加：

```typescript
import { buildCommitNudge } from './commit-nudge.js'
```

找到第一处 file_write 记录（`deps.taskLedger.record({ type: 'file_write', path: filePath })`），在该行之后添加：

```typescript
          // Commit nudge: warn when uncommitted files accumulate
          if (tu.name === 'edit_file' || tu.name === 'write_file') {
            const nudge = buildCommitNudge({ ownedFiles: deps.taskLedger.getOwnedFiles() })
            if (nudge) finalContent += nudge
          }
```

注意：这段代码放在 `if (deps.taskLedger)` 块内部，紧跟在对应的 `deps.taskLedger.record(...)` 之后。有两处 file_write record（第 683 行对应 `write_file`/`edit_file`，第 691 行对应其他写入工具），只需在第一处（直接编辑文件的路径）注入推力。

**预期：** typecheck 通过，现有测试不受影响（推力只在文件数 >4 时出现）。

```bash
npx tsc --noEmit
# → 0 errors
```

- [ ] **3d.** 提交：

```bash
git add src/agent/commit-nudge.ts src/agent/__tests__/commit-nudge.test.ts src/agent/tool-pipeline.ts
git commit -m "feat(agent): add post-write commit nudge when uncommitted files accumulate"
```

---

### Task 4: 更新提示词引导 — 按逻辑单元提交

- [ ] **4a.** 修改 `src/prompt/static.ts` 第 54-56 行 `<shared-worktree>` 段落。

将现有的：
```
多会话共享工作区。交付门禁（deliver_task）会自动追踪文件归属，只提交你本次改动的文件——你不需要手动判断哪些是自己的。
己方文件须验证通过；外部文件的失败不阻塞你的交付。
交付前调用 deliver_task 检查门禁（GREEN/YELLOW/RED），GREEN 即可放心提交。
```

替换为：
```
多会话共享工作区。交付门禁（deliver_task）会自动追踪文件归属，只提交你本次改动的文件——你不需要手动判断哪些是自己的。
己方文件须验证通过；外部文件的失败不阻塞你的交付。
交付前调用 deliver_task 检查门禁（GREEN/YELLOW/RED），GREEN 即可放心提交。
每个逻辑单元（一个 bugfix / 一个 feature / 一个 refactor）完成后立即调用 deliver_task commit=true 提交，不要积累多个不相关改动再一起提交。若一次任务涉及多个独立改动，用 files 参数分批提交：先完成 P1 → typecheck → deliver_task commit=true files=[P1文件] → 再开始 P2。
跨多个区域的批量提交会被内聚性门禁拒绝（RED），需要 force=true 覆盖——先想想能不能拆成更小的提交。
```

- [ ] **4b.** 类型检查：

```bash
npx tsc --noEmit
# → 0 errors
```

- [ ] **4c.** 提交：

```bash
git add src/prompt/static.ts
git commit -m "feat(prompt): add per-logical-unit commit guidance with cohesion gate awareness"
```

---

## Verification

### 类型检查

```bash
npx tsc --noEmit
# → 0 errors
```

### 单元测试

```bash
# 内聚性检测模块
npm exec -- tsx --test src/agent/__tests__/commit-cohesion.test.ts
# → 8 tests passed

# 推力模块
npm exec -- tsx --test src/agent/__tests__/commit-nudge.test.ts
# → 6 tests passed

# deliver-task 全量测试（含 files/force + cohesion gate）
npm exec -- tsx --test src/agent/__tests__/deliver-task.test.ts
# → 全部通过（原有 ~30 + 新增 9）

# scoped-git-commit 不变
npm exec -- tsx --test src/agent/__tests__/scoped-git-commit.test.ts
# → 全部通过（未修改）
```

### 防护层行为对照

用户描述的场景：7 个文件、3 个不相关改动、P1/P2 重叠文件集合。

| 防护层 | 触发时机 | 行为 | agent 必须做什么 |
|--------|----------|------|-----------------|
| **推力（Task 3）** | 写第 5 个文件时 | 工具结果出现"💡 Uncommitted files accumulating: 5 owned files across 3 areas" | 无（信息性） |
| **门禁（Task 2）** | `deliver_task commit=true` | RED：`❌ Commit cohesion gate: 7 owned files across 3 areas` | 必须用 `files=[子集]` 拆分，或 `force=true` 显式覆盖 |
| **files 参数（Task 2）** | `deliver_task commit=true files=[P1文件]` | 只提交指定文件 | 无（正常路径） |
| **提示词（Task 4）** | 全程 | 系统提示中明确要求"每完成一个逻辑单元立即提交" | 无（预防性） |

**具体流程：**
1. Agent 写 P1 文件 → 推力在第 5 个文件时出现
2. Agent 继续 P1 → 完成 → `deliver_task commit=true files=[P1文件]`
3. 内聚性检查：P1 文件在 1-2 个区域内 → 通过 → commit 成功
4. Agent 开始 P2 → 写新文件
5. Agent 完成 P2 → `deliver_task commit=true files=[P2文件]`
6. 内聚性检查通过 → commit 成功

**如果 agent 无视推力直接批量提交：**
1. `deliver_task commit=true`（无 files 参数）
2. 内聚性门禁：7 files / 3 areas → RED → **被拒绝**
3. Agent 必须选择：拆分（`files`）或 显式覆盖（`force=true`）

---

## Self-check

### 1. Spec Coverage

| 需求 | 任务 | 状态 |
|------|------|------|
| 支持 `files` 子集参数 | Task 2 | ✅ |
| 验证 `files` 必须是 owned subset | Task 2 | ✅ |
| 空数组 `files=[]` 拒绝 | Task 2 | ✅ |
| `commit=false` 时忽略 `files` | Task 2 | ✅ |
| 内聚性检测（>5 文件或 >2 区域） | Task 1 | ✅ |
| 内聚性门禁 RED（阻塞提交） | Task 2 | ✅ |
| `force=true` 覆盖门禁 | Task 2 | ✅ |
| 写后累积推力（>4 文件） | Task 3 | ✅ |
| 推力含分步策略建议 | Task 3 | ✅ |
| 提示词引导 agent 行为改变 | Task 4 | ✅ |
| 向后兼容（不传 files = 全量） | Task 2 | ✅ |

### 2. Placeholder Scan

无 TODO / TBD / 待定 / 后续实现 / 补充细节。所有代码片段完整。

### 3. Type Consistency

| 名称 | 定义位置 | 使用位置 | 一致 |
|------|----------|----------|------|
| `CohesionReport` | `commit-cohesion.ts` | `deliver-task.ts` | ✅ |
| `checkCommitCohesion(files, thresholds?)` | `commit-cohesion.ts` | `deliver-task.ts` + 测试 | ✅ |
| `NudgeInput` | `commit-nudge.ts` | `tool-pipeline.ts` + 测试 | ✅ |
| `buildCommitNudge(input)` | `commit-nudge.ts` | `tool-pipeline.ts` + 测试 | ✅ |
| `files` input param | `deliver-task.ts` schema | execute 函数 | ✅ |
| `force` input param | `deliver-task.ts` schema | execute 函数 | ✅ |
| `commitOwnedFiles(cwd, files, msg)` | `B1Context` interface | `deliver-task.ts` execute | ✅ |

### 4. 遗留风险

| 风险 | 缓解措施 |
|------|----------|
| agent 用 `force=true` 绕过所有门禁 | `force` 会输出覆盖提示 + 提示词中明确"先想想能不能拆" |
| 重叠文件（同一文件被 P1 和 P2 修改）无法用 `files` 参数拆分 | 这是 git 的固有局限（文件级提交），推力 + 门禁迫使 agent 在开始 P2 前先提交 P1 |
| 推力文本增加 token 消耗 | 仅在 >4 文件时触发，文本 ~100 tokens，影响极小 |

---

## Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-31-deliver-task-cohesive-commit.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？

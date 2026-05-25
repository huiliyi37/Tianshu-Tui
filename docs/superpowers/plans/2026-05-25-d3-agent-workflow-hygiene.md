# 流程与交付卫生 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 隔离运行时诊断文件，增强 ownership/delivery 报告的健康检查，降低共享工作区中的提交噪音和误归因。

**架构：** `.gitignore` 明确忽略 runtime/tmp 诊断路径但保留 canonical memory；新增纯函数 `summarizeOwnershipHealth()` 对 owned/external/dirty 文件关系做报告；`deliver_task` 只展示健康警告，不改变 GREEN/YELLOW/RED 判定。

**技术栈：** TypeScript strict、node:test、B1 TaskLedger、OwnershipLedger、deliver_task tool、gitignore runtime hygiene

---

> 总索引：`docs/superpowers/plans/2026-05-25-把这些写到计划里-可能文档太长了-分三个文档来做-d1-d2-d3.md`

## 1. Scope check

本计划只处理共享工作区流程卫生：

| 范围 | 包含 | 不包含 |
|---|---|---|
| 运行时文件隔离 | `.rivet/runtime/`、`.rivet/tmp/`、`.rivet/prefix-diag.jsonl` ignore 规则 | 删除现有运行时文件 |
| Ownership 健康检查 | owned/external/dirty 的一致性报告 | 改变 ownership ledger 核心归属规则 |
| 交付报告 | 在 deliver_task 中展示健康警告 | 改变 GREEN/YELLOW/RED 判定语义 |

独立性判断：该计划不影响工具输出，不影响 PromptEngine，不影响 cache usage 解析。完成后可单独验证流程报告。

---

## 2. File structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `.gitignore` | 忽略 runtime 诊断路径，保留 project memory 可显式提交 | 修改 |
| `src/__tests__/runtime-ignore.test.ts` | 验证 ignore 规则 | 创建 |
| `src/agent/ownership-health.ts` | ownership 健康报告纯函数 | 创建 |
| `src/agent/__tests__/ownership-health.test.ts` | ownership health 单元测试 | 创建 |
| `src/agent/deliver-task.ts:50-105` | 在报告中展示 health warning | 修改 |
| `src/agent/__tests__/deliver-task.test.ts` | 验证 deliver_task 报告包含 warning 且不改变 gate state | 修改 |

---

## 3. Tasks

### Task 1：隔离 runtime 诊断文件

**文件：**
- 修改：`.gitignore`
- 创建：`src/__tests__/runtime-ignore.test.ts`

- [ ] **步骤 1：创建失败测试**

创建 `src/__tests__/runtime-ignore.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('runtime ignore rules', () => {
  it('ignores runtime diagnostics while preserving canonical memory paths', () => {
    const content = readFileSync(join(process.cwd(), '.gitignore'), 'utf-8')
    assert.match(content, /^\.rivet\/runtime\/$/m)
    assert.match(content, /^\.rivet\/tmp\/$/m)
    assert.match(content, /^\.rivet\/prefix-diag\.jsonl$/m)
    assert.doesNotMatch(content, /^\.rivet\/knowledge\/$/m)
    assert.doesNotMatch(content, /^\.rivet\/knowledge\/project-memory\.md$/m)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
npx tsx --test src/__tests__/runtime-ignore.test.ts
```

预期结果：失败，因为 `.gitignore` 尚未包含三条 runtime 诊断规则。

- [ ] **步骤 3：修改 `.gitignore`**

在 `.gitignore` 的 `# Local agent runtime state` 区域追加：

```gitignore
.rivet/runtime/
.rivet/tmp/
.rivet/prefix-diag.jsonl
```

不要加入 `.rivet/knowledge/` 或 `.rivet/knowledge/project-memory.md`。

- [ ] **步骤 4：运行测试确认通过**

```bash
npx tsx --test src/__tests__/runtime-ignore.test.ts
```

预期结果：runtime ignore test pass。

- [ ] **步骤 5：提交 ignore 规则**

```bash
git add .gitignore src/__tests__/runtime-ignore.test.ts
git commit -m "fix(runtime): ignore local diagnostic files"
```

预期结果：生成 runtime ignore 提交。

---

### Task 2：创建 ownership health 纯函数

**文件：**
- 创建：`src/agent/ownership-health.ts`
- 创建：`src/agent/__tests__/ownership-health.test.ts`

- [ ] **步骤 1：创建失败测试**

创建 `src/agent/__tests__/ownership-health.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeOwnershipHealth } from '../ownership-health.js'

describe('summarizeOwnershipHealth', () => {
  it('classifies dirty owned and dirty external files', () => {
    const report = summarizeOwnershipHealth({
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      externalFiles: ['.rivet/prefix-diag.jsonl'],
      dirtyFiles: ['src/a.ts', '.rivet/prefix-diag.jsonl'],
    })
    assert.deepEqual(report.untrackedDirtyOwned, ['src/a.ts'])
    assert.deepEqual(report.dirtyExternal, ['.rivet/prefix-diag.jsonl'])
    assert.deepEqual(report.cleanOwned, ['src/b.ts'])
  })

  it('warns for dirty files without ownership classification', () => {
    const report = summarizeOwnershipHealth({ ownedFiles: [], externalFiles: [], dirtyFiles: ['src/unknown.ts'] })
    assert.ok(report.warningLines.includes('Dirty file has no ownership classification: src/unknown.ts'))
  })

  it('warns when no owned files are registered but dirty files exist', () => {
    const report = summarizeOwnershipHealth({ ownedFiles: [], externalFiles: ['src/external.ts'], dirtyFiles: ['src/external.ts'] })
    assert.ok(report.warningLines.includes('No owned files registered, but dirty files exist. Check task-ledger write events.'))
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

```bash
npx tsx --test src/agent/__tests__/ownership-health.test.ts
```

预期结果：失败，错误包含 `Cannot find module '../ownership-health.js'`。

- [ ] **步骤 3：实现 `ownership-health.ts`**

创建 `src/agent/ownership-health.ts`：

```typescript
export interface OwnershipHealthInput {
  ownedFiles: string[]
  externalFiles: string[]
  dirtyFiles: string[]
}

export interface OwnershipHealthReport {
  untrackedDirtyOwned: string[]
  dirtyExternal: string[]
  cleanOwned: string[]
  warningLines: string[]
}

export function summarizeOwnershipHealth(input: OwnershipHealthInput): OwnershipHealthReport {
  const owned = new Set(input.ownedFiles)
  const external = new Set(input.externalFiles)
  const dirty = new Set(input.dirtyFiles)

  const untrackedDirtyOwned = input.dirtyFiles.filter(f => owned.has(f)).sort()
  const dirtyExternal = input.dirtyFiles.filter(f => external.has(f)).sort()
  const cleanOwned = input.ownedFiles.filter(f => !dirty.has(f)).sort()
  const warningLines: string[] = []

  for (const f of input.dirtyFiles) {
    if (!owned.has(f) && !external.has(f)) {
      warningLines.push(`Dirty file has no ownership classification: ${f}`)
    }
  }
  if (input.ownedFiles.length === 0 && input.dirtyFiles.length > 0) {
    warningLines.push('No owned files registered, but dirty files exist. Check task-ledger write events.')
  }

  return { untrackedDirtyOwned, dirtyExternal, cleanOwned, warningLines }
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
npx tsx --test src/agent/__tests__/ownership-health.test.ts
```

预期结果：3 tests pass。

- [ ] **步骤 5：提交 ownership health**

```bash
git add src/agent/ownership-health.ts src/agent/__tests__/ownership-health.test.ts
git commit -m "feat(agent): add ownership health summary"
```

预期结果：生成 ownership health 提交。

---

### Task 3：在 deliver_task 报告中展示 health warning

**文件：**
- 修改：`src/agent/deliver-task.ts:50-105`
- 修改：`src/agent/__tests__/deliver-task.test.ts`
- 测试：`src/agent/__tests__/ownership-health.test.ts`

- [ ] **步骤 1：扩展 deliver-task 测试**

在 `src/agent/__tests__/deliver-task.test.ts` 中新增测试：

```typescript
it('includes ownership health warnings without changing gate state', async () => {
  const tool = makeTool({
    state: 'GREEN',
    ownedFiles: [],
    externalFiles: ['.rivet/prefix-diag.jsonl'],
    verificationCount: 1,
  })

  const result = await tool.execute({ toolUseId: 'deliver', cwd: process.cwd(), input: {} })

  assert.equal(result.isError, undefined)
  assert.match(result.content, /Delivery Gate: GREEN/)
  assert.match(result.content, /Owned files \(0\)/)
  assert.match(result.content, /External files \(1\)/)
  assert.match(result.content, /Ownership health warnings:/)
})
```

如果现有 helper 不是 `makeTool`，使用文件里已有的 factory 名称，并传入等价的 report state、ownedFiles、externalFiles。

- [ ] **步骤 2：运行 deliver-task 测试确认失败**

```bash
npx tsx --test src/agent/__tests__/deliver-task.test.ts
```

预期结果：新增测试失败，因为报告尚未包含 `Ownership health warnings:`。

- [ ] **步骤 3：修改 `deliver-task.ts`**

在 `src/agent/deliver-task.ts` 顶部添加：

```typescript
import { summarizeOwnershipHealth } from './ownership-health.js'
```

在构造 `lines` 后、`if (report.blockingReason)` 前插入：

```typescript
const health = summarizeOwnershipHealth({
  ownedFiles: report.ownedFiles,
  externalFiles: report.externalFiles,
  dirtyFiles: [...report.ownedFiles, ...report.externalFiles],
})
if (health.warningLines.length > 0) {
  lines.push('', 'Ownership health warnings:')
  lines.push(...health.warningLines.map(line => `  ${line}`))
}
```

不要改变：

```typescript
const isError = report.state === 'RED'
```

- [ ] **步骤 4：运行相关测试确认通过**

```bash
npx tsx --test src/agent/__tests__/ownership-health.test.ts
npx tsx --test src/agent/__tests__/deliver-task.test.ts
```

预期结果：两个测试文件全部 pass。

- [ ] **步骤 5：提交 deliver_task 集成**

```bash
git add src/agent/deliver-task.ts src/agent/__tests__/deliver-task.test.ts
git commit -m "fix(agent): show ownership health in delivery report"
```

预期结果：生成 deliver_task 集成提交。

---

## 4. Verification

```bash
npx tsx --test src/__tests__/runtime-ignore.test.ts
# 预期：runtime ignore tests 全部 pass

npx tsx --test src/agent/__tests__/ownership-health.test.ts
# 预期：ownership health tests 全部 pass

npx tsx --test src/agent/__tests__/deliver-task.test.ts
# 预期：deliver-task tests 全部 pass

npx tsc --noEmit
# 预期：TypeScript 0 errors
```

最终提交后运行：

```bash
git status --short
# 预期：不再显示 .rivet/prefix-diag.jsonl；若 .rivet/knowledge/project-memory.md 有变更，它仍显示为可显式提交的 canonical memory
```

---

## 5. Self-check

1. **Spec coverage:**
   - runtime 诊断文件隔离 → Task 1。
   - ownership/delivery 报告健康检查 → Task 2、Task 3。
   - 不改变交付门判定 → Task 3 明确保留 `isError` 逻辑。
   - canonical memory 仍可提交 → Task 1 测试明确不忽略 `.rivet/knowledge/project-memory.md`。

2. **Placeholder scan:**
   - 本计划不包含禁用占位语句。
   - 所有函数名、接口名、路径均已定义。

3. **Type consistency:**
   - `OwnershipHealthInput` 字段与 `summarizeOwnershipHealth()` 调用一致。
   - `OwnershipHealthReport.warningLines` 是 `string[]`，deliver_task 使用 `map()` 输出文本。
   - `deliver_task` 不改变 `ToolResult` shape。

---

## 6. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-25-d3-agent-workflow-hygiene.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？

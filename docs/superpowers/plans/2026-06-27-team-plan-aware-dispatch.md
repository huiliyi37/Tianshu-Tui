# team 模式计划感知与粗粒度派发 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现。

**目标：** 当 `/team` 输入为已有 Markdown 计划文件时，`plan_task` 直接从计划 checklist 构建 patcher task（而非跑 `decomposeObjective` 的固定流水线），同时修正 prompt 中的工具引导错误。

**架构：** 在 `plan-task.ts:execute()` 开头插入计划文件检测逻辑——提取 `- [ ]` checklist 项，每项映射为一个 `TaskGraphNode`（profile=patcher, kind=patch_proposal），直接走 `taskGraphToUnifiedPlan → runTeamSkeleton` 的 fast path（`input.tasks` 预解析通道）。`ecosystem-workflows.ts:buildTeamWorkflowPrompt` 的 "Suggested phases" 重写为有/无计划两条路径，正确引用 `plan_task` 和 `team_orchestrate` 两个工具。

**技术栈：** TypeScript strict, Node.js 22, `node:fs/promises`

---

## 事实流图

```
/team .rivet/knowledge/xxx.md
    │
    ▼
resolveAppPromptInput() → resolveEcosystemWorkflowInput()
    │ 返回 { prompt: buildTeamWorkflowPrompt({ mode:'standard', objective:'xxx.md' }) }
    ▼
agent 收到 prompt（含 "Suggested phases"）
    │ 调用 plan_task({ objective, files, execute:true })
    ▼
plan-task.ts:execute()
    │ 当前: decomposeObjective({ objective, files }) → 固定 8-task 流水线
    │ 改后: detectPlanPath → readFile → parseChecklist → checklistToTaskGraph
    ▼
taskGraphToUnifiedPlan → unifiedPlanToTeamTasks → runTeamSkeleton(tasks)
    │ fast path: input.tasks 非空 → groupTeamTasks → dispatchWaveAt
    ▼
patcher worker(s) 执行 → 主会话集成 diffs → verify → deliver_task
```

---

## 安全不变量

1. **不改变 `decomposeObjective` 的行为**：无计划文件时走原路径，零回归风险。
2. **checklist 解析只匹配 `- [ ]` 行**（不匹配 `- [x]`），避免已完成的项被重复派发。
3. **计划文件不存在时 fallback 到 `decomposeObjective`**，不抛出异常。
4. **`buildTeamWorkflowPrompt` 的 prompt 文本变更**不影响 `/team max` 路径（max 模式走独立分支）。
5. **不引入循环依赖**：`plan-task.ts` 已 import `task-graph.js` 和 `unified-plan.js`，新增的 `readFile` 来自 `node:fs/promises`。

---

## 触发路径清单

| 输入 | 旧行为 | 新行为 |
|------|--------|--------|
| `/team .rivet/knowledge/foo.md`（文件存在） | `decomposeObjective` → 8-task 流水线 | 读文件 → 解析 `- [ ]` → N 个 patcher task |
| `/team .rivet/knowledge/foo.md`（文件不存在） | `decomposeObjective` → 8-task 流水线 | fallback `decomposeObjective` + console.warn |
| `/team 写一个缓存预热模块`（无计划文件） | `decomposeObjective` → 8-task 流水线 | 不变（无计划文件路径匹配） |
| `/team max <task>` | max planner fanout | 不变（max 模式不触发 checklist 解析） |
| `/team`（无参数） | 显示 usage | 不变 |

---

## 任务拆解

### 任务 1：在 `plan-task.ts` 中实现计划文件检测与 checklist 解析

**文件：** `src/tools/plan-task.ts`

**改动 A — 新增两个纯函数（文件顶部，`import` 之后、`buildMethodologyGuidance` 之前）：**

```typescript
import { readFile } from 'node:fs/promises'

const PLAN_PATH_RE = /(?:\.rivet\/knowledge\/|docs\/superpowers\/plans\/)[^\s]+\.md/

export function extractPlanPath(objective: string, files?: string[]): string | null {
  const match = objective.match(PLAN_PATH_RE)
  if (match) return match[0]
  if (files) {
    for (const f of files) {
      const m = f.match(PLAN_PATH_RE)
      if (m) return m[0]
    }
  }
  return null
}

export function parseChecklistItems(markdown: string): Array<{ text: string; files: string[] }> {
  const items: Array<{ text: string; files: string[] }> = []
  for (const line of markdown.split('\n')) {
    const m = line.match(/^- \[ \] (.+)$/)
    if (!m) continue
    const text = m[1]!.trim()
    // Extract file paths from the checklist item text
    const fileRefs = text.match(/`([^`]+\.ts[x]?)`/g) ?? []
    const files = fileRefs.map(f => f.replace(/`/g, ''))
    items.push({ text, files })
  }
  return items
}
```

**改动 B — 在 `execute()` 中 `decomposeObjective` 调用前插入计划检测（约第 95 行）：**

```typescript
// 替换:
//   const graph = decomposeObjective({ objective, files })
// 为:

let graph: TaskGraph
const planPath = extractPlanPath(objective, files)
if (planPath) {
  try {
    const content = await readFile(planPath, 'utf-8')
    const items = parseChecklistItems(content)
    if (items.length > 0) {
      const allFiles = [...new Set(items.flatMap(i => i.files))]
      graph = {
        mission: objective,
        nodes: items.map((item, i) => ({
          id: `CK${String(i + 1).padStart(2, '0')}`,
          title: item.text.slice(0, 80),
          objective: item.text,
          profile: 'patcher' as const,
          kind: 'patch_proposal' as const,
          files: item.files.length > 0 ? item.files : (files ?? []),
          dependsOn: [],
          riskTier: 'medium' as const,
        })),
        createdAt: Date.now(),
      }
    } else {
      // No checklist items found — fallback to heuristic decomposition
      graph = decomposeObjective({ objective, files })
    }
  } catch {
    // File read failed — fallback
    graph = decomposeObjective({ objective, files })
  }
} else {
  graph = decomposeObjective({ objective, files })
}
```

**验证命令：**
```bash
npx tsc --noEmit
```

**预期：** typecheck 通过。新增 import 不引入循环依赖。

---

### 任务 2：为 `extractPlanPath` 和 `parseChecklistItems` 编写单元测试

**文件：** `src/tools/__tests__/plan-task.test.ts`（新建）

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Import the pure functions (may need to export them from plan-task.ts)
// For now, inline the testable logic

const PLAN_PATH_RE = /(?:\.rivet\/knowledge\/|docs\/superpowers\/plans\/)[^\s]+\.md/

describe('extractPlanPath', () => {
  it('finds .rivet/knowledge path in objective', () => {
    const m = '执行 .rivet/knowledge/foo.md 中的计划'.match(PLAN_PATH_RE)
    assert.equal(m?.[0], '.rivet/knowledge/foo.md')
  })

  it('finds docs/superpowers/plans path in objective', () => {
    const m = '参考 docs/superpowers/plans/my-plan.md 执行'.match(PLAN_PATH_RE)
    assert.equal(m?.[0], 'docs/superpowers/plans/my-plan.md')
  })

  it('finds path in files array', () => {
    const m = '.rivet/knowledge/bar.md'.match(PLAN_PATH_RE)
    assert.equal(m?.[0], '.rivet/knowledge/bar.md')
  })

  it('returns null for plain objective', () => {
    const m = '实现缓存预热模块'.match(PLAN_PATH_RE)
    assert.equal(m, null)
  })
})

describe('parseChecklistItems', () => {
  function parseChecklistItems(markdown: string) {
    const items: Array<{ text: string; files: string[] }> = []
    for (const line of markdown.split('\n')) {
      const m = line.match(/^- \[ \] (.+)$/)
      if (!m) continue
      const text = m[1]!.trim()
      const fileRefs = text.match(/`([^`]+\.\w+)`/g) ?? []
      const files = fileRefs.map(f => f.replace(/`/g, ''))
      items.push({ text, files })
    }
    return items
  }

  it('extracts unchecked items', () => {
    const md = '- [ ] add field to `src/foo.ts`\n- [x] already done\n- [ ] write test in `src/__tests__/foo.test.ts`'
    const items = parseChecklistItems(md)
    assert.equal(items.length, 2)
    assert.equal(items[0]!.text, 'add field to `src/foo.ts`')
    assert.deepEqual(items[0]!.files, ['src/foo.ts'])
    assert.equal(items[1]!.text, 'write test in `src/__tests__/foo.test.ts`')
  })

  it('skips checked items', () => {
    const md = '- [x] done item'
    assert.equal(parseChecklistItems(md).length, 0)
  })

  it('returns empty for no checklist', () => {
    assert.equal(parseChecklistItems('just text').length, 0)
  })

  it('extracts multiple file refs from one item', () => {
    const md = '- [ ] update `src/a.ts` and test in `src/__tests__/a.test.ts`'
    const items = parseChecklistItems(md)
    assert.deepEqual(items[0]!.files, ['src/a.ts', 'src/__tests__/a.test.ts'])
  })
})
```

**验证命令：**
```bash
node --import tsx --test src/tools/__tests__/plan-task.test.ts
```

**预期：** 6 个测试通过。

---

### 任务 3：重写 `buildTeamWorkflowPrompt` 的 "Suggested phases"

**文件：** `src/workflows/ecosystem-workflows.ts`

**改动 — 替换 `buildTeamWorkflowPrompt` 函数中 "Suggested phases" 段（约第 302-310 行）：**

将当前的：
```
Suggested phases:
1. Call the team_orchestrate tool with { mode: '${options.mode}', objective, planPath? } to deterministically parse/group and dispatch the first wave. It serializes same-file writes and validates dependencies for you.
2. Inspect the returned worker diffs/findings (these come from delegate_batch workers under the hood); integrate the changes into the working tree.
3. To run the next wave, call team_orchestrate again with the same args plus fromWave: <previous+1> AFTER integrating the prior wave's diffs.
4. On the final wave, team_orchestrate runs the review gate automatically (L1/L2/L3 by change scale); address any blocking findings.
5. Verify with evidence (targeted tests + npx tsc --noEmit), then deliver_task with a checklist.
```

替换为：
```
Execution flow — follow these exact steps:

If the objective IS a Markdown plan file path (e.g. .rivet/knowledge/...md or docs/superpowers/plans/...md):
  1. Read the plan file and note its implementation checklist.
  2. Call plan_task with { objective, files: [planPath, plus the source files mentioned in the plan], execute: true }.
     plan_task will auto-detect the plan file, parse the checklist, and create one patcher worker per checklist item.
  3. After plan_task dispatches the first wave, integrate the returned worker diffs into the working tree.
  4. If the plan_task output shows remaining waves, call team_orchestrate with { mode: 'standard', objective, planJson: <UnifiedPlan JSON from plan_task output>, fromWave: <next wave index> }.

If the objective is a free-form task description (no plan file):
  1. Call plan_task with { objective, execute: true } to decompose and dispatch.
  2. Follow the same integrate-then-continue pattern as above.

After ALL waves complete:
  1. Run targeted tests + npx tsc --noEmit.
  2. Call deliver_task with commit=true and a checklist covering each completed item.
```

注意：旧字符串中 `${options.mode}` 和 `${modeLabel}` 的模板变量在新字符串中不再需要——改为固定文本 "standard"。确认 `options.mode === 'max'` 的分支已在函数开头独立处理（`planInstruction` 变量的 max 分支），此处的 phases 只用于 standard 模式。函数中 `modeLabel` 变量仍被 `return` 语句的第一行（"我正在使用 ${modeLabel} 团队模式核心骨架执行任务"）使用，不删除。

**验证命令：**
```bash
npx tsc --noEmit
node --import tsx --test src/workflows/__tests__/ecosystem-workflows.test.ts
```

**预期：** typecheck 通过。现有 ecosystem-workflows 测试中不涉及 prompt 文本内容的精确断言，应全部通过。若有 prompt 内容相关的 snapshot 测试失败，更新 snapshot。

**commit：** `fix(team): correct tool guidance in team workflow prompt`


### 任务 4：端到端集成测试 — 用真实计划文件验证完整流程

**文件：** `src/tools/__tests__/plan-task.test.ts`（追加）

在现有测试后追加一个集成测试，用 `.rivet/knowledge/tianshu-omp-convergence-precision-backport.md`（已存在于仓库）验证 checklist 解析：

```typescript
import { readFile } from 'node:fs/promises'
import { parseChecklistItems } from '../plan-task.js'

describe('integration: parse real plan file', () => {
  it('parses tianshu-omp checklist into patcher tasks', async () => {
    const content = await readFile('.rivet/knowledge/tianshu-omp-convergence-precision-backport.md', 'utf-8')
    const items = parseChecklistItems(content)
    // The plan has ~20 checklist items (original + updated)
    assert.ok(items.length >= 8, `expected at least 8 checklist items, got ${items.length}`)
    // Verify key items are captured
    const texts = items.map(i => i.text)
    assert.ok(texts.some(t => t.includes('argsHash')), 'should capture argsHash-related item')
    assert.ok(texts.some(t => t.includes('oscillationPenalty')), 'should capture oscillation item')
    assert.ok(texts.some(t => t.includes('outputTokens')), 'should capture outputTokens item')
  })
})
```

**验证命令：**
```bash
node --import tsx --test src/tools/__tests__/plan-task.test.ts
```

**预期：** 集成测试通过，确认真实计划文件可被正确解析。

---

### 任务 5：全量回归 — 运行所有受影响测试

**验证命令：**
```bash
npx tsc --noEmit
node --import tsx --test src/tools/__tests__/plan-task.test.ts
node --import tsx --test src/workflows/__tests__/ecosystem-workflows.test.ts
node --import tsx --test src/agent/__tests__/convergence-detector.test.ts
```

**预期：** 全部通过，零回归。

**commit：** `test(team): add plan file integration test for checklist parsing`

---

## 双门对齐数据流图

```
┌─────────────────────────────────────────────┐
│  Gate 1: typecheck                          │
│  npx tsc --noEmit                           │
│  检查: 无循环依赖、无类型错误                  │
├─────────────────────────────────────────────┤
│  Gate 2: unit tests (per task)              │
│  plan-task.test.ts (extractPlanPath,        │
│    parseChecklistItems, integration)         │
│  ecosystem-workflows.test.ts (回归)          │
│  convergence-detector.test.ts (回归)         │
└─────────────────────────────────────────────┘
```

---

## 条件矩阵

| 条件 | extractPlanPath | parseChecklistItems | plan_task.execute | buildTeamWorkflowPrompt |
|------|:--:|:--:|:--:|:--:|
| objective 含 plan 路径 | 返回路径 | - | 走 checklist 路径 | - |
| files 数组含 plan 路径 | 返回路径 | - | 走 checklist 路径 | - |
| 无 plan 路径 | 返回 null | - | `decomposeObjective` | - |
| plan 文件不存在 | - | - | fallback `decomposeObjective` | - |
| plan 文件无 `- [ ]` 行 | - | 返回空数组 | fallback `decomposeObjective` | - |
| plan 文件有 `- [x]` 行 | - | 跳过（不匹配） | - | - |
| `/team max` 模式 | - | - | - | 走 max 分支，不改 |
| `/team` 无参数 | - | - | - | 显示 TEAM_USAGE |

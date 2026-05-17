# Rivet Agent Parity Roadmap 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立 Rivet 对标 Claude Code + OpenCode 的能力闭环：评测任务、执行证据、失败归因、Provider 能力画像、局部诊断反馈。

**架构：** 本计划只落地 R1/R2 主线，并为 R3/R4 留出清晰接口。R1 建立 benchmark 与能力矩阵的数据底座，R2 将 TraceStore、EvidenceTracker、DeliveryGate、LSP diagnostics 接入执行闭环。R3 的 panic recovery TUI 与 R4 的公开 Open Model Lab 需要单独计划，避免把 TUI 大改、provider 重构和评测系统混成一个不可审查的大提交。

**技术栈：** TypeScript, Node 22, node:test, Zod, Ink 6, tsx, existing Rivet AgentLoop/ToolPipeline/ProviderCapabilities。

---

## 子代理探查结论

四条只读探查泳道给出的共同结论：

1. 执行闭环已经有 `TraceStore`、`EvidenceTracker`、`DeliveryGate`、`TurnHarness`、`FailureClassifier`，但缺少可导出的 benchmark report，DeliveryGate 仍偏提示性，失败样本没有自动沉淀。
2. TUI 已有 cockpit、checkpoint、rollback、session replay，但 recovery UX 仍分散在 `/rollback`、`/undo`、`ErrorBoundary` 和日志条目里。R3 需要单独计划重构 `app.tsx` 状态边界。
3. Provider/cache 已有 `ProviderCapabilities`、`prefixCacheStrategy`、OpenAI/DeepSeek client、cache diagnostics，但 provider metadata 分散在 defaults/profile/config 中，prompt/cache 策略还没有统一 scorecard。
4. Benchmark/Open Source 方向已有设计文档，但没有 runtime benchmark runner、scorecard store、task suite、capability matrix 生成器。

## 范围锁定

本计划实现：

- R1 Capability Baseline
  - benchmark task schema
  - benchmark run store
  - markdown capability matrix report
  - dry-run runner
  - package script
- R2 Execution Closure foundation
  - trace/evidence serializable report
  - LSP diagnostics seam hardening
  - completion guard message helper
  - provider registry and conformance scorecard foundation

本计划不实现：

- Panic recovery menu, checkpoint timeline, actionable cockpit。对应 R3 子计划。
- Hosted benchmark service or remote leaderboard。R4 第一版只做本地 scorecard。
- Full provider fallback chain。需要单独风险评审，因为会改变长会话模型一致性。
- Cache-sensitive prompt rewrite。任何 prompt/cache 边界修改必须单独审查 DeepSeek prefix contract。

## 文件结构

### 新增文件

- `src/benchmark/types.ts`：benchmark task、run、scorecard row 的 Zod schema 与 TypeScript 类型。
- `src/benchmark/store.ts`：append-only JSONL run store，负责写入和读取 benchmark run。
- `src/benchmark/report.ts`：从 run records 生成 capability matrix rows 和 Markdown。
- `src/benchmark/task-suite.ts`：加载 `benchmark/tasks/*.json` 并校验 task definition。
- `src/benchmark/runner.ts`：dry-run runner，先支持 task listing 与 scorecard smoke run。
- `src/benchmark/__tests__/types.test.ts`：schema 单元测试。
- `src/benchmark/__tests__/store.test.ts`：JSONL store 单元测试。
- `src/benchmark/__tests__/report.test.ts`：matrix report 单元测试。
- `src/benchmark/__tests__/task-suite.test.ts`：task suite loader 单元测试。
- `src/benchmark/__tests__/runner.test.ts`：dry-run runner 单元测试。
- `benchmark/tasks/r1-local-coding-smoke.json`：10 个本地 coding-agent benchmark 任务定义。
- `benchmark/tasks/provider-conformance.json`：Provider conformance 任务定义。
- `scripts/run-benchmark.ts`：CLI entry，调用 `src/benchmark/runner.ts`。
- `docs/benchmark/README.md`：如何运行 benchmark、解释结果、添加任务。
- `docs/benchmark/capability-matrix.md`：本地生成的能力矩阵说明。
- `src/api/provider-registry.ts`：Provider metadata 单一入口。
- `src/api/conformance-scorecard.ts`：provider config 与 capability 覆盖检查。
- `src/api/__tests__/provider-registry.test.ts`：registry 单元测试。
- `src/api/__tests__/conformance-scorecard.test.ts`：scorecard 单元测试。
- `src/agent/completion-guard.ts`：基于 DeliveryGate 的完成声明保护提示。
- `src/agent/__tests__/completion-guard.test.ts`：completion guard 单元测试。

### 修改文件

- `package.json`：增加 `benchmark` script。
- `src/agent/trace-store.ts`：增加 `exportTraceReport()`。
- `src/agent/evidence.ts`：增加 `serializeEvidenceState()`。
- `src/agent/tool-pipeline.ts`：调整 LSP diagnostics 拼接顺序，确保诊断不被成功结果截断吞掉。
- `src/lsp/client.ts`：替换 shell string `execSync` 为安全 argv 调用，保留 file filter。
- `src/api/provider.ts`：由 `provider-registry.ts` 承接 well-known metadata，保留兼容导出。
- `README.md`：补充 benchmark 命令和本地 scorecard 说明。

---

## 任务 1：Benchmark schema

**文件：**
- 创建：`src/benchmark/types.ts`
- 创建：`src/benchmark/__tests__/types.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/benchmark/__tests__/types.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  benchmarkRunSchema,
  taskDefinitionSchema,
  capabilityMatrixRowSchema,
} from '../types.js'

test('taskDefinitionSchema accepts a local coding task with verification commands', () => {
  const parsed = taskDefinitionSchema.parse({
    id: 'edit-single-function',
    title: 'Edit a single function and verify the focused test',
    category: 'code_edit',
    prompt: 'Change one pure helper and run its focused test.',
    setupCommands: ['npm run typecheck'],
    successCommands: ['npm test -- --test-name-pattern edit-single-function'],
    timeoutMs: 120000,
    tags: ['r1', 'local', 'verification'],
  })

  assert.equal(parsed.id, 'edit-single-function')
  assert.equal(parsed.successCommands.length, 1)
})

test('benchmarkRunSchema requires a provider, model, task id, and status', () => {
  const parsed = benchmarkRunSchema.parse({
    runId: 'run-20260517-001',
    suiteId: 'r1-local-coding-smoke',
    taskId: 'edit-single-function',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    status: 'passed',
    startedAt: '2026-05-17T12:00:00.000Z',
    endedAt: '2026-05-17T12:01:00.000Z',
    metrics: {
      turns: 4,
      toolCalls: 6,
      retries: 1,
      cacheHitRate: 0.99,
      costUsd: 0.001,
    },
    failures: [],
  })

  assert.equal(parsed.status, 'passed')
  assert.equal(parsed.metrics.cacheHitRate, 0.99)
})

test('capabilityMatrixRowSchema stores pass rate and cost per provider model pair', () => {
  const parsed = capabilityMatrixRowSchema.parse({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    suiteId: 'r1-local-coding-smoke',
    runs: 10,
    passed: 8,
    failed: 1,
    blocked: 1,
    passRate: 0.8,
    medianTurns: 5,
    medianToolCalls: 8,
    averageCostUsd: 0.003,
  })

  assert.equal(parsed.passRate, 0.8)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/benchmark/__tests__/types.test.ts
```

预期：FAIL，报错包含 `Cannot find module '../types.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/benchmark/types.ts`：

```ts
import { z } from 'zod'

export const taskCategorySchema = z.enum([
  'repo_inspection',
  'code_edit',
  'test_repair',
  'multi_file_refactor',
  'session_recovery',
  'provider_conformance',
])

export const benchmarkStatusSchema = z.enum(['passed', 'failed', 'blocked'])

export const taskDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: taskCategorySchema,
  prompt: z.string().min(1),
  setupCommands: z.array(z.string().min(1)).default([]),
  successCommands: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive(),
  tags: z.array(z.string().min(1)).default([]),
})

export const benchmarkFailureSchema = z.object({
  class: z.string().min(1),
  message: z.string().min(1),
  toolName: z.string().min(1).optional(),
})

export const benchmarkMetricsSchema = z.object({
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  cacheHitRate: z.number().min(0).max(1).optional(),
  costUsd: z.number().nonnegative().optional(),
})

export const benchmarkRunSchema = z.object({
  runId: z.string().min(1),
  suiteId: z.string().min(1),
  taskId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: benchmarkStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  metrics: benchmarkMetricsSchema,
  failures: z.array(benchmarkFailureSchema).default([]),
})

export const capabilityMatrixRowSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  suiteId: z.string().min(1),
  runs: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  medianTurns: z.number().nonnegative(),
  medianToolCalls: z.number().nonnegative(),
  averageCostUsd: z.number().nonnegative(),
})

export type TaskDefinition = z.infer<typeof taskDefinitionSchema>
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>
export type CapabilityMatrixRow = z.infer<typeof capabilityMatrixRowSchema>
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/benchmark/__tests__/types.test.ts
```

预期：PASS，3 个测试通过。

- [ ] **步骤 5：Commit**

```bash
git add src/benchmark/types.ts src/benchmark/__tests__/types.test.ts
git commit -m "feat: add benchmark schema"
```

---

## 任务 2：Benchmark run store

**文件：**
- 创建：`src/benchmark/store.ts`
- 创建：`src/benchmark/__tests__/store.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/benchmark/__tests__/store.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendBenchmarkRun, readBenchmarkRuns } from '../store.js'
import type { BenchmarkRun } from '../types.js'

function makeRun(taskId: string, status: BenchmarkRun['status']): BenchmarkRun {
  return {
    runId: `run-${taskId}`,
    suiteId: 'r1-local-coding-smoke',
    taskId,
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    status,
    startedAt: '2026-05-17T12:00:00.000Z',
    endedAt: '2026-05-17T12:01:00.000Z',
    metrics: { turns: 3, toolCalls: 4, retries: 0, cacheHitRate: 0.98, costUsd: 0.002 },
    failures: [],
  }
}

test('appendBenchmarkRun writes parseable JSONL records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-bench-'))
  try {
    const file = join(dir, 'runs.jsonl')
    appendBenchmarkRun(file, makeRun('task-a', 'passed'))
    appendBenchmarkRun(file, makeRun('task-b', 'failed'))

    const runs = readBenchmarkRuns(file)
    assert.equal(runs.length, 2)
    assert.equal(runs[0].taskId, 'task-a')
    assert.equal(runs[1].status, 'failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readBenchmarkRuns returns an empty array for a missing store file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-bench-'))
  try {
    assert.deepEqual(readBenchmarkRuns(join(dir, 'missing.jsonl')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- src/benchmark/__tests__/store.test.ts
```

预期：FAIL，报错包含 `Cannot find module '../store.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/benchmark/store.ts`：

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { benchmarkRunSchema, type BenchmarkRun } from './types.js'

export function appendBenchmarkRun(filePath: string, run: BenchmarkRun): void {
  const parsed = benchmarkRunSchema.parse(run)
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, `${JSON.stringify(parsed)}\n`, 'utf-8')
}

export function readBenchmarkRuns(filePath: string): BenchmarkRun[] {
  if (!existsSync(filePath)) return []
  const lines = readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  return lines.map(line => benchmarkRunSchema.parse(JSON.parse(line)))
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- src/benchmark/__tests__/store.test.ts src/benchmark/__tests__/types.test.ts
```

预期：PASS，所有 benchmark schema/store 测试通过。

- [ ] **步骤 5：Commit**

```bash
git add src/benchmark/store.ts src/benchmark/__tests__/store.test.ts
git commit -m "feat: add benchmark run store"
```

---

## 任务 3：Capability matrix report

**文件：**
- 创建：`src/benchmark/report.ts`
- 创建：`src/benchmark/__tests__/report.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/benchmark/__tests__/report.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCapabilityMatrix, renderCapabilityMatrixMarkdown } from '../report.js'
import type { BenchmarkRun } from '../types.js'

function run(taskId: string, status: BenchmarkRun['status'], turns: number): BenchmarkRun {
  return {
    runId: `${taskId}-${status}`,
    suiteId: 'r1-local-coding-smoke',
    taskId,
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    status,
    startedAt: '2026-05-17T12:00:00.000Z',
    endedAt: '2026-05-17T12:01:00.000Z',
    metrics: { turns, toolCalls: turns + 1, retries: 0, costUsd: 0.002 },
    failures: [],
  }
}

test('buildCapabilityMatrix groups runs by provider model and suite', () => {
  const rows = buildCapabilityMatrix([
    run('a', 'passed', 3),
    run('b', 'failed', 7),
    run('c', 'blocked', 5),
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].runs, 3)
  assert.equal(rows[0].passed, 1)
  assert.equal(rows[0].failed, 1)
  assert.equal(rows[0].blocked, 1)
  assert.equal(rows[0].passRate, 1 / 3)
  assert.equal(rows[0].medianTurns, 5)
})

test('renderCapabilityMatrixMarkdown renders a stable table', () => {
  const rows = buildCapabilityMatrix([run('a', 'passed', 3)])
  const markdown = renderCapabilityMatrixMarkdown(rows)

  assert.match(markdown, /\| Provider \| Model \| Suite \| Runs \| Pass rate \|/)
  assert.match(markdown, /\| deepseek \| deepseek-v4-pro \| r1-local-coding-smoke \| 1 \| 100% \|/)
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- src/benchmark/__tests__/report.test.ts
```

预期：FAIL，报错包含 `Cannot find module '../report.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/benchmark/report.ts`：

```ts
import { capabilityMatrixRowSchema, type BenchmarkRun, type CapabilityMatrixRow } from './types.js'

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function buildCapabilityMatrix(runs: BenchmarkRun[]): CapabilityMatrixRow[] {
  const groups = new Map<string, BenchmarkRun[]>()
  for (const run of runs) {
    const key = `${run.provider} ${run.model} ${run.suiteId}`
    groups.set(key, [...(groups.get(key) ?? []), run])
  }

  return [...groups.values()].map(group => {
    const first = group[0]
    const passed = group.filter(run => run.status === 'passed').length
    const failed = group.filter(run => run.status === 'failed').length
    const blocked = group.filter(run => run.status === 'blocked').length
    return capabilityMatrixRowSchema.parse({
      provider: first.provider,
      model: first.model,
      suiteId: first.suiteId,
      runs: group.length,
      passed,
      failed,
      blocked,
      passRate: group.length === 0 ? 0 : passed / group.length,
      medianTurns: median(group.map(run => run.metrics.turns)),
      medianToolCalls: median(group.map(run => run.metrics.toolCalls)),
      averageCostUsd: average(group.map(run => run.metrics.costUsd ?? 0)),
    })
  })
}

export function renderCapabilityMatrixMarkdown(rows: CapabilityMatrixRow[]): string {
  const lines = [
    '| Provider | Model | Suite | Runs | Pass rate | Median turns | Median tools | Avg cost USD |',
    '|---|---|---|---:|---:|---:|---:|---:|',
  ]

  for (const row of rows) {
    lines.push([
      `| ${row.provider}`,
      row.model,
      row.suiteId,
      String(row.runs),
      `${Math.round(row.passRate * 100)}%`,
      String(row.medianTurns),
      String(row.medianToolCalls),
      row.averageCostUsd.toFixed(4),
      '|',
    ].join(' | '))
  }

  return lines.join('\n')
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- src/benchmark/__tests__/report.test.ts src/benchmark/__tests__/store.test.ts src/benchmark/__tests__/types.test.ts
```

预期：PASS，所有 benchmark report 测试通过。

- [ ] **步骤 5：Commit**

```bash
git add src/benchmark/report.ts src/benchmark/__tests__/report.test.ts
git commit -m "feat: add capability matrix report"
```

---

## 任务 4：Task suite loader and R1 task definitions

**文件：**
- 创建：`src/benchmark/task-suite.ts`
- 创建：`src/benchmark/__tests__/task-suite.test.ts`
- 创建：`benchmark/tasks/r1-local-coding-smoke.json`
- 创建：`benchmark/tasks/provider-conformance.json`

- [ ] **步骤 1：编写失败的测试**

创建 `src/benchmark/__tests__/task-suite.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTaskSuite } from '../task-suite.js'

test('loadTaskSuite parses a JSON task array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-suite-'))
  try {
    const file = join(dir, 'suite.json')
    writeFileSync(file, JSON.stringify([
      {
        id: 'inspect-project-entry',
        title: 'Inspect the project entrypoint',
        category: 'repo_inspection',
        prompt: 'Find the CLI entrypoint and summarize the execution path.',
        setupCommands: [],
        successCommands: ['npm run typecheck'],
        timeoutMs: 60000,
        tags: ['r1', 'inspection'],
      },
    ]))

    const suite = loadTaskSuite(file)
    assert.equal(suite.length, 1)
    assert.equal(suite[0].id, 'inspect-project-entry')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- src/benchmark/__tests__/task-suite.test.ts
```

预期：FAIL，报错包含 `Cannot find module '../task-suite.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/benchmark/task-suite.ts`：

```ts
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { taskDefinitionSchema, type TaskDefinition } from './types.js'

const taskSuiteSchema = z.array(taskDefinitionSchema).min(1)

export function loadTaskSuite(filePath: string): TaskDefinition[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  return taskSuiteSchema.parse(raw)
}
```

创建 `benchmark/tasks/r1-local-coding-smoke.json`：

```json
[
  {
    "id": "inspect-project-entry",
    "title": "Inspect the project entrypoint",
    "category": "repo_inspection",
    "prompt": "Find the CLI entrypoint, identify the AgentLoop construction path, and report the files involved without editing code.",
    "setupCommands": [],
    "successCommands": ["npm run typecheck"],
    "timeoutMs": 60000,
    "tags": ["r1", "inspection", "no-edit"]
  },
  {
    "id": "read-targeted-file",
    "title": "Read a targeted file range",
    "category": "repo_inspection",
    "prompt": "Read src/agent/loop.ts around the tool execution branch and summarize how tool results are recorded.",
    "setupCommands": [],
    "successCommands": ["npm run typecheck"],
    "timeoutMs": 60000,
    "tags": ["r1", "read"]
  },
  {
    "id": "edit-single-helper",
    "title": "Edit one pure helper",
    "category": "code_edit",
    "prompt": "Make a minimal safe change to a pure helper under src/benchmark in a prepared workspace and run its focused test.",
    "setupCommands": ["npm run typecheck"],
    "successCommands": ["npm test -- src/benchmark/__tests__/types.test.ts"],
    "timeoutMs": 120000,
    "tags": ["r1", "edit", "focused-test"]
  },
  {
    "id": "fix-type-error",
    "title": "Fix a TypeScript type error",
    "category": "test_repair",
    "prompt": "Given a prepared branch with one TypeScript type error, identify the failing file and fix it with the smallest code change.",
    "setupCommands": ["npm run typecheck"],
    "successCommands": ["npm run typecheck"],
    "timeoutMs": 180000,
    "tags": ["r1", "typecheck", "repair"]
  },
  {
    "id": "add-unit-test",
    "title": "Add a focused unit test",
    "category": "code_edit",
    "prompt": "Add one node:test case for an existing pure helper and run only the new test file.",
    "setupCommands": [],
    "successCommands": ["npm test -- src/benchmark/__tests__/report.test.ts"],
    "timeoutMs": 120000,
    "tags": ["r1", "test"]
  },
  {
    "id": "multi-file-refactor",
    "title": "Perform a two-file refactor",
    "category": "multi_file_refactor",
    "prompt": "Move one pure utility into a focused module, update one caller, and keep the focused tests green.",
    "setupCommands": ["npm test -- src/benchmark/__tests__/report.test.ts"],
    "successCommands": ["npm test -- src/benchmark/__tests__/report.test.ts", "npm run typecheck"],
    "timeoutMs": 240000,
    "tags": ["r1", "refactor", "two-file"]
  },
  {
    "id": "repair-failing-test",
    "title": "Repair one failing test",
    "category": "test_repair",
    "prompt": "Given a prepared failing node:test assertion, diagnose whether the test or implementation is wrong and make the focused test pass.",
    "setupCommands": ["npm test -- src/benchmark/__tests__/store.test.ts"],
    "successCommands": ["npm test -- src/benchmark/__tests__/store.test.ts"],
    "timeoutMs": 180000,
    "tags": ["r1", "repair"]
  },
  {
    "id": "session-resume-check",
    "title": "Inspect session resume safety",
    "category": "session_recovery",
    "prompt": "Inspect the session resume path and report how unsafe transcripts are repaired or rolled back. Do not edit code.",
    "setupCommands": [],
    "successCommands": ["npm test -- src/agent/__tests__/session-persist.test.ts"],
    "timeoutMs": 120000,
    "tags": ["r1", "session", "no-edit"]
  },
  {
    "id": "mcp-timeout-check",
    "title": "Inspect MCP timeout degradation",
    "category": "repo_inspection",
    "prompt": "Inspect the MCP manager timeout and degraded-state path. Report the function names and tests that cover it. Do not edit code.",
    "setupCommands": [],
    "successCommands": ["npm run typecheck"],
    "timeoutMs": 120000,
    "tags": ["r1", "mcp", "no-edit"]
  },
  {
    "id": "cache-boundary-check",
    "title": "Inspect DeepSeek prefix cache boundaries",
    "category": "repo_inspection",
    "prompt": "Inspect prompt engine context layers and report which layers are cache-sensitive. Do not edit code.",
    "setupCommands": [],
    "successCommands": ["npm test -- src/prompt/__tests__/fingerprint.test.ts"],
    "timeoutMs": 120000,
    "tags": ["r1", "cache", "no-edit"]
  }
]
```

创建 `benchmark/tasks/provider-conformance.json`：

```json
[
  {
    "id": "provider-capabilities-registry",
    "title": "Provider capabilities registry coverage",
    "category": "provider_conformance",
    "prompt": "Validate that every configured provider has capabilities, cache strategy, thinking format, and effort format metadata.",
    "setupCommands": [],
    "successCommands": ["npm test -- src/api/__tests__/provider-registry.test.ts"],
    "timeoutMs": 60000,
    "tags": ["r4", "provider", "registry"]
  },
  {
    "id": "provider-scorecard-gaps",
    "title": "Provider conformance scorecard gaps",
    "category": "provider_conformance",
    "prompt": "Generate a local conformance scorecard and report missing provider metadata without calling external APIs.",
    "setupCommands": [],
    "successCommands": ["npm test -- src/api/__tests__/conformance-scorecard.test.ts"],
    "timeoutMs": 60000,
    "tags": ["r4", "provider", "scorecard"]
  }
]
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- src/benchmark/__tests__/task-suite.test.ts
```

预期：PASS，task suite loader 测试通过。

- [ ] **步骤 5：Commit**

```bash
git add src/benchmark/task-suite.ts src/benchmark/__tests__/task-suite.test.ts benchmark/tasks/r1-local-coding-smoke.json benchmark/tasks/provider-conformance.json
git commit -m "feat: add benchmark task suites"
```

---

## 任务 5：Benchmark dry-run runner and package script

**文件：**
- 创建：`src/benchmark/runner.ts`
- 创建：`src/benchmark/__tests__/runner.test.ts`
- 创建：`scripts/run-benchmark.ts`
- 修改：`package.json:35-41`

- [ ] **步骤 1：编写失败的测试**

创建 `src/benchmark/__tests__/runner.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBenchmarkDryRun } from '../runner.js'


test('runBenchmarkDryRun emits blocked records for loaded tasks without model calls', () => {
  const runs = runBenchmarkDryRun({
    suiteId: 'local-suite',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    tasks: [
      {
        id: 'inspect-project-entry',
        title: 'Inspect project entry',
        category: 'repo_inspection',
        prompt: 'Inspect only.',
        setupCommands: [],
        successCommands: ['npm run typecheck'],
        timeoutMs: 60000,
        tags: ['r1'],
      },
    ],
    now: () => '2026-05-17T12:00:00.000Z',
  })

  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'blocked')
  assert.equal(runs[0].failures[0].class, 'dry_run')
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- src/benchmark/__tests__/runner.test.ts
```

预期：FAIL，报错包含 `Cannot find module '../runner.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/benchmark/runner.ts`：

```ts
import { join } from 'node:path'
import { appendBenchmarkRun } from './store.js'
import { loadTaskSuite } from './task-suite.js'
import type { BenchmarkRun, TaskDefinition } from './types.js'

export interface BenchmarkDryRunInput {
  suiteId: string
  provider: string
  model: string
  tasks: TaskDefinition[]
  now?: () => string
}

export function runBenchmarkDryRun(input: BenchmarkDryRunInput): BenchmarkRun[] {
  const now = input.now ?? (() => new Date().toISOString())
  return input.tasks.map(task => {
    const timestamp = now()
    return {
      runId: `${input.suiteId}:${task.id}:${timestamp}`,
      suiteId: input.suiteId,
      taskId: task.id,
      provider: input.provider,
      model: input.model,
      status: 'blocked',
      startedAt: timestamp,
      endedAt: timestamp,
      metrics: { turns: 0, toolCalls: 0, retries: 0 },
      failures: [
        {
          class: 'dry_run',
          message: 'Dry run validates task loading and report plumbing without model execution.',
        },
      ],
    }
  })
}

export interface BenchmarkCliInput {
  suitePath: string
  suiteId: string
  provider: string
  model: string
  outputPath: string
  dryRun: boolean
}

export function runBenchmarkCli(input: BenchmarkCliInput): BenchmarkRun[] {
  const tasks = loadTaskSuite(input.suitePath)
  if (!input.dryRun) {
    throw new Error('Only dry-run mode is supported in this implementation slice.')
  }

  const runs = runBenchmarkDryRun({
    suiteId: input.suiteId,
    provider: input.provider,
    model: input.model,
    tasks,
  })

  for (const run of runs) appendBenchmarkRun(input.outputPath, run)
  return runs
}

export function defaultBenchmarkOutputPath(cwd: string): string {
  return join(cwd, 'docs', 'benchmark', 'run-records.jsonl')
}
```

创建 `scripts/run-benchmark.ts`：

```ts
import { resolve } from 'node:path'
import { defaultBenchmarkOutputPath, runBenchmarkCli } from '../src/benchmark/runner.js'

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const cwd = process.cwd()
const suitePath = resolve(cwd, argValue('--suite', 'benchmark/tasks/r1-local-coding-smoke.json'))
const suiteId = argValue('--suite-id', 'r1-local-coding-smoke')
const provider = argValue('--provider', 'deepseek')
const model = argValue('--model', 'deepseek-v4-pro')
const outputPath = resolve(cwd, argValue('--output', defaultBenchmarkOutputPath(cwd)))
const dryRun = process.argv.includes('--dry-run')

const runs = runBenchmarkCli({ suitePath, suiteId, provider, model, outputPath, dryRun })
console.log(`Recorded ${runs.length} benchmark run(s) to ${outputPath}`)
```

修改 `package.json` 的 `scripts`：

```json
{
  "scripts": {
    "dev": "tsup --watch",
    "build": "tsup",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "tsx --test src/**/__tests__/*.test.ts",
    "benchmark": "tsx scripts/run-benchmark.ts --dry-run"
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- src/benchmark/__tests__/runner.test.ts
npm run benchmark -- --suite benchmark/tasks/r1-local-coding-smoke.json --suite-id r1-local-coding-smoke --provider deepseek --model deepseek-v4-pro --dry-run
```

预期：

```text
PASS src/benchmark/__tests__/runner.test.ts
Recorded 10 benchmark run(s) to .../docs/benchmark/run-records.jsonl
```

- [ ] **步骤 5：Commit**

```bash
git add src/benchmark/runner.ts src/benchmark/__tests__/runner.test.ts scripts/run-benchmark.ts package.json
git commit -m "feat: add benchmark dry-run runner"
```

---

## 任务 6：Trace and evidence export

**文件：**
- 修改：`src/agent/trace-store.ts:1-96`
- 修改：`src/agent/evidence.ts:1-131`
- 测试：`src/agent/__tests__/trace-store.test.ts`
- 测试：`src/agent/__tests__/loop-evidence.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/trace-store.test.ts` 增加：

```ts
import { exportTraceReport } from '../trace-store.js'

test('exportTraceReport summarizes events and tool fingerprints', () => {
  let store = createTraceStore(10)
  store = recordTraceEvent(store, {
    id: 'tool-1',
    turn: 1,
    kind: 'tool',
    name: 'read_file',
    status: 'passed',
    startedAt: 100,
    endedAt: 150,
    durationMs: 50,
  })
  store = recordToolFingerprint(store, 'abc123')

  const report = exportTraceReport(store)
  assert.equal(report.eventCount, 1)
  assert.equal(report.eventsByKind.tool, 1)
  assert.equal(report.eventsByStatus.passed, 1)
  assert.deepEqual(report.recentToolFingerprints, ['abc123'])
})
```

在 `src/agent/__tests__/loop-evidence.test.ts` 增加纯 `EvidenceTracker` 测试：

```ts
import { EvidenceTracker, serializeEvidenceState } from '../evidence.js'

test('serializeEvidenceState converts sets into stable arrays', () => {
  const tracker = new EvidenceTracker()
  tracker.trackFileRead('src/a.ts')
  tracker.trackFileModified('src/b.ts')
  tracker.trackImpact(['src/c.ts'], ['src/c.test.ts'])

  const serialized = serializeEvidenceState(tracker.getState())
  assert.deepEqual(serialized.filesRead, ['src/a.ts'])
  assert.deepEqual(serialized.filesModified, ['src/b.ts'])
  assert.deepEqual(serialized.impactedFiles, ['src/c.ts'])
  assert.deepEqual(serialized.impactedTests, ['src/c.test.ts'])
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- src/agent/__tests__/trace-store.test.ts src/agent/__tests__/loop-evidence.test.ts
```

预期：FAIL，报错包含 `exportTraceReport` 或 `serializeEvidenceState` 未导出。

- [ ] **步骤 3：编写最少实现代码**

在 `src/agent/trace-store.ts` 追加：

```ts
export interface TraceReport {
  eventCount: number
  eventsByKind: Record<TraceEventKind, number>
  eventsByStatus: Record<TraceEventStatus, number>
  doomLoopLevel: DoomLoopLevel
  recentToolFingerprints: string[]
}

export function exportTraceReport(store: TraceStore): TraceReport {
  const eventsByKind: Record<TraceEventKind, number> = {
    model: 0,
    tool: 0,
    verification: 0,
    checkpoint: 0,
    cache: 0,
  }
  const eventsByStatus: Record<TraceEventStatus, number> = {
    running: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
  }

  for (const event of store.events) {
    eventsByKind[event.kind] += 1
    eventsByStatus[event.status] += 1
  }

  return {
    eventCount: store.events.length,
    eventsByKind,
    eventsByStatus,
    doomLoopLevel: getDoomLoopLevel(store.toolFingerprints),
    recentToolFingerprints: [...store.toolFingerprints],
  }
}
```

在 `src/agent/evidence.ts` 追加：

```ts
export interface SerializedEvidenceState {
  filesRead: string[]
  filesModified: string[]
  verifications: VerificationMetadata[]
  deliveryStatus: DeliveryVerificationStatus
  impactedFiles: string[]
  impactedTests: string[]
}

export function serializeEvidenceState(state: EvidenceState): SerializedEvidenceState {
  return {
    filesRead: [...state.filesRead].sort(),
    filesModified: [...state.filesModified].sort(),
    verifications: [...state.verifications],
    deliveryStatus: state.deliveryStatus,
    impactedFiles: [...state.impactedFiles].sort(),
    impactedTests: [...state.impactedTests].sort(),
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- src/agent/__tests__/trace-store.test.ts src/agent/__tests__/loop-evidence.test.ts
```

预期：PASS，新增 trace/evidence export 测试通过。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/trace-store.ts src/agent/evidence.ts src/agent/__tests__/trace-store.test.ts src/agent/__tests__/loop-evidence.test.ts
git commit -m "feat: export trace and evidence reports"
```

---

## 任务 7：LSP diagnostics seam hardening

**文件：**
- 修改：`src/lsp/client.ts:1-28`
- 修改：`src/agent/tool-pipeline.ts:277-290`
- 测试：`src/lsp/__tests__/client.test.ts`
- 测试：`src/agent/__tests__/tool-pipeline.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建或扩展 `src/lsp/__tests__/client.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTypeCheckInvocation, shouldRunDiagnostics } from '../client.js'

test('buildTypeCheckInvocation uses argv instead of a shell string', () => {
  const invocation = buildTypeCheckInvocation()
  assert.equal(invocation.command, 'npx')
  assert.deepEqual(invocation.args, ['tsc', '--noEmit', '--pretty', 'false'])
})

test('shouldRunDiagnostics only runs for edit and write code files', () => {
  assert.equal(shouldRunDiagnostics('edit_file', 'src/a.ts'), true)
  assert.equal(shouldRunDiagnostics('write_file', 'src/a.tsx'), true)
  assert.equal(shouldRunDiagnostics('read_file', 'src/a.ts'), false)
  assert.equal(shouldRunDiagnostics('edit_file', 'README.md'), false)
})
```

在 `src/agent/__tests__/tool-pipeline.test.ts` 增加断言：

```ts
test('tool pipeline preserves LSP diagnostics after successful edit output truncation', async () => {
  // Use the existing executeToolUse test harness in this file.
  // Configure lspEnabled true and a successful edit_file result with long content.
  // Assert final onToolResult content contains [LSP Diagnostics].
})
```

实现该测试时，复用文件内现有 mock registry/callbacks 结构，不新增全局 mock 系统。

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- src/lsp/__tests__/client.test.ts src/agent/__tests__/tool-pipeline.test.ts
```

预期：FAIL，报错包含 `buildTypeCheckInvocation` 未导出，tool-pipeline 诊断保留测试失败。

- [ ] **步骤 3：编写最少实现代码**

修改 `src/lsp/client.ts`：

```ts
import { spawnSync } from 'node:child_process'
import { parseDiagnosticOutput, formatDiagnostics, type Diagnostic } from './diagnostics.js'

export interface LspCheckResult {
  diagnostics: Diagnostic[]
  formatted: string
}

export interface TypeCheckInvocation {
  command: string
  args: string[]
}

export function buildTypeCheckInvocation(): TypeCheckInvocation {
  return { command: 'npx', args: ['tsc', '--noEmit', '--pretty', 'false'] }
}

export function runTypeCheck(cwd: string, filePath: string): LspCheckResult {
  const invocation = buildTypeCheckInvocation()
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: 'pipe',
  })

  if (result.status === 0) return { diagnostics: [], formatted: '' }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const diagnostics = parseDiagnosticOutput(output, 'typescript').filter(
    d => d.file.includes(filePath) || filePath === '*',
  )
  return { diagnostics, formatted: formatDiagnostics(diagnostics) }
}

export function shouldRunDiagnostics(toolName: string, filePath?: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false
  if (!filePath) return false
  return /\.(ts|tsx|js|jsx)$/.test(filePath)
}
```

修改 `src/agent/tool-pipeline.ts:277-290` 为先截断成功工具输出，再追加 LSP diagnostics：

```ts
let lspDiagnostics = ''
if (deps.config.lspEnabled && !harnessResult.isError && shouldRunDiagnostics(tu.name, tu.input.file_path as string | undefined)) {
  const check = runTypeCheck(deps.cwd, tu.input.file_path as string)
  if (check.formatted) {
    lspDiagnostics = `\n\n[LSP Diagnostics]\n${check.formatted}`
  }
}

if (!harnessResult.isError) {
  finalContent = truncateSuccessfulToolResult(finalContent, deps.config.contextWindow)
}

finalContent = finalContent + lspDiagnostics
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- src/lsp/__tests__/client.test.ts src/agent/__tests__/tool-pipeline.test.ts
npm run typecheck
```

预期：PASS，typecheck 0 errors。

- [ ] **步骤 5：Commit**

```bash
git add src/lsp/client.ts src/lsp/__tests__/client.test.ts src/agent/tool-pipeline.ts src/agent/__tests__/tool-pipeline.test.ts
git commit -m "fix: preserve scoped diagnostics after edits"
```

---

## 任务 8：Completion guard helper

**文件：**
- 创建：`src/agent/completion-guard.ts`
- 创建：`src/agent/__tests__/completion-guard.test.ts`
- 修改：`src/agent/turn-end.ts:27-76`

- [ ] **步骤 1：编写失败的测试**

创建 `src/agent/__tests__/completion-guard.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCompletionGuardMessage, looksLikeCompletionClaim } from '../completion-guard.js'
import type { DeliveryGateResult } from '../delivery-gate.js'

test('looksLikeCompletionClaim detects common final-answer claims', () => {
  assert.equal(looksLikeCompletionClaim('Done. Tests pass.'), true)
  assert.equal(looksLikeCompletionClaim('已完成，测试通过。'), true)
  assert.equal(looksLikeCompletionClaim('Next I will run tests.'), false)
})

test('buildCompletionGuardMessage returns null when delivery gate allows completion', () => {
  const gate: DeliveryGateResult = {
    status: 'verified',
    severity: 'ok',
    canClaimComplete: true,
    message: 'Modified files have passing verification evidence.',
  }

  assert.equal(buildCompletionGuardMessage('Done.', gate), null)
})

test('buildCompletionGuardMessage blocks completion claim without verification', () => {
  const gate: DeliveryGateResult = {
    status: 'unverified',
    severity: 'warn',
    canClaimComplete: false,
    message: 'Unverified changes: src/a.ts.',
    blockingReason: 'Files were modified without passing verification evidence.',
    nextAction: 'Run relevant targeted tests, typecheck, or build before claiming completion.',
  }

  const message = buildCompletionGuardMessage('Done.', gate)
  assert.match(message ?? '', /Delivery gate blocked completion claim/)
  assert.match(message ?? '', /Run relevant targeted tests/)
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- src/agent/__tests__/completion-guard.test.ts
```

预期：FAIL，报错包含 `Cannot find module '../completion-guard.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/agent/completion-guard.ts`：

```ts
import type { DeliveryGateResult } from './delivery-gate.js'

const COMPLETION_PATTERNS = [
  /\bdone\b/i,
  /\bcompleted\b/i,
  /\bfinished\b/i,
  /tests? pass(?:ed)?/i,
  /已完成/,
  /完成了/,
  /测试通过/,
]

export function looksLikeCompletionClaim(text: string): boolean {
  return COMPLETION_PATTERNS.some(pattern => pattern.test(text))
}

export function buildCompletionGuardMessage(text: string, gate: DeliveryGateResult): string | null {
  if (gate.canClaimComplete) return null
  if (!looksLikeCompletionClaim(text)) return null

  return [
    'Delivery gate blocked completion claim.',
    `Reason: ${gate.blockingReason ?? gate.message}`,
    gate.nextAction ? `Next action: ${gate.nextAction}` : undefined,
  ].filter(Boolean).join('\n')
}
```

修改 `src/agent/turn-end.ts`，在 evidence badge 生成后调用 helper。实现方式：

```ts
import { buildDeliveryGate } from './delivery-gate.js'
import { buildCompletionGuardMessage } from './completion-guard.js'

// inside processTurnEnd after evidence badge construction:
const gate = buildDeliveryGate(evidence.getState())
const guard = buildCompletionGuardMessage(assistantText, gate)
if (guard) {
  parts.push('---')
  parts.push(guard)
}
```

如果 `processTurnEnd()` 当前没有 `assistantText` 参数，扩展参数对象，调用点从 `AgentLoop.run()` 传入当前 assistant text。保持默认空字符串，避免影响测试 fixture。

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- src/agent/__tests__/completion-guard.test.ts src/agent/__tests__/turn-end.test.ts src/agent/__tests__/loop-evidence.test.ts
npm run typecheck
```

预期：PASS，completion guard、turn-end、evidence 相关测试通过。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/completion-guard.ts src/agent/__tests__/completion-guard.test.ts src/agent/turn-end.ts src/agent/__tests__/turn-end.test.ts src/agent/__tests__/loop-evidence.test.ts
git commit -m "feat: guard unverified completion claims"
```

---

## 任务 9：Provider registry and conformance scorecard

**文件：**
- 创建：`src/api/provider-registry.ts`
- 创建：`src/api/conformance-scorecard.ts`
- 创建：`src/api/__tests__/provider-registry.test.ts`
- 创建：`src/api/__tests__/conformance-scorecard.test.ts`
- 修改：`src/api/provider.ts:47-160`

- [ ] **步骤 1：编写失败的测试**

创建 `src/api/__tests__/provider-registry.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getProviderMetadata, listProviderMetadata } from '../provider-registry.js'

test('provider registry includes deepseek cache strategy and thinking metadata', () => {
  const deepseek = getProviderMetadata('deepseek')
  assert.equal(deepseek.capabilities.supportsThinking, true)
  assert.equal(deepseek.capabilities.prefixCacheStrategy, 'deepseek-native')
  assert.equal(deepseek.defaultModels.includes('deepseek-v4-pro'), true)
})

test('listProviderMetadata returns stable provider names', () => {
  const names = listProviderMetadata().map(provider => provider.name)
  assert.deepEqual(names, [...names].sort())
  assert.equal(names.includes('openai'), true)
})
```

创建 `src/api/__tests__/conformance-scorecard.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProviderConformanceScorecard } from '../conformance-scorecard.js'

test('buildProviderConformanceScorecard reports no gaps for deepseek defaults', () => {
  const rows = buildProviderConformanceScorecard(['deepseek'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].provider, 'deepseek')
  assert.equal(rows[0].gaps.length, 0)
})

test('buildProviderConformanceScorecard reports unknown providers', () => {
  const rows = buildProviderConformanceScorecard(['missing-provider'])
  assert.equal(rows[0].status, 'missing')
  assert.match(rows[0].gaps[0], /No provider metadata/)
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npm test -- src/api/__tests__/provider-registry.test.ts src/api/__tests__/conformance-scorecard.test.ts
```

预期：FAIL，报错包含 `Cannot find module '../provider-registry.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/api/provider-registry.ts`：

```ts
import type { ProviderCapabilities } from './provider.js'
import { DEEPSEEK_CAPABILITIES, DEFAULT_CAPABILITIES } from './provider.js'

export interface ProviderMetadata {
  name: string
  capabilities: ProviderCapabilities
  defaultModels: string[]
}

const PROVIDERS: ProviderMetadata[] = [
  { name: 'deepseek', capabilities: DEEPSEEK_CAPABILITIES, defaultModels: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
  {
    name: 'glm',
    capabilities: { ...DEFAULT_CAPABILITIES, supportsThinking: true, thinkingFormat: 'anthropic', supportsCacheControl: false, effortFormat: 'reasoning_effort', stripParams: ['top_k', 'metadata', 'service_tier'] },
    defaultModels: ['glm-4.6'],
  },
  {
    name: 'kimi',
    capabilities: { ...DEFAULT_CAPABILITIES, supportsThinking: true, thinkingFormat: 'anthropic', supportsCacheControl: false, effortFormat: 'reasoning_effort', stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'] },
    defaultModels: ['kimi-k2'],
  },
  {
    name: 'minimax',
    capabilities: { ...DEFAULT_CAPABILITIES, supportsThinking: true, thinkingFormat: 'openai', supportsCacheControl: false, stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'] },
    defaultModels: ['minimax-m2'],
  },
  {
    name: 'mimo',
    capabilities: { ...DEFAULT_CAPABILITIES, supportsThinking: true, thinkingFormat: 'openai', supportsCacheControl: false, stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'] },
    defaultModels: ['mimo-vl'],
  },
  {
    name: 'opencode-go',
    capabilities: { ...DEFAULT_CAPABILITIES, supportsThinking: true, thinkingFormat: 'openai', supportsCacheControl: false, stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'] },
    defaultModels: ['opencode-go'],
  },
  {
    name: 'openai',
    capabilities: { ...DEFAULT_CAPABILITIES, supportsThinking: true, thinkingFormat: 'openai', supportsCacheControl: true, effortFormat: 'reasoning_effort' },
    defaultModels: ['gpt-5.2'],
  },
]

export function listProviderMetadata(): ProviderMetadata[] {
  return [...PROVIDERS].sort((a, b) => a.name.localeCompare(b.name))
}

export function getProviderMetadata(name: string): ProviderMetadata {
  const provider = PROVIDERS.find(item => item.name === name)
  if (!provider) return { name, capabilities: structuredClone(DEFAULT_CAPABILITIES), defaultModels: [] }
  return provider
}

export function getWellKnownProviderDefaults(): Record<string, ProviderCapabilities> {
  return Object.fromEntries(listProviderMetadata().map(provider => [provider.name, provider.capabilities]))
}
```

创建 `src/api/conformance-scorecard.ts`：

```ts
import { getProviderMetadata } from './provider-registry.js'

export interface ProviderConformanceRow {
  provider: string
  status: 'ok' | 'missing' | 'incomplete'
  gaps: string[]
}

export function buildProviderConformanceScorecard(providerNames: string[]): ProviderConformanceRow[] {
  return providerNames.map(providerName => {
    const metadata = getProviderMetadata(providerName)
    const gaps: string[] = []

    if (metadata.defaultModels.length === 0) gaps.push(`No provider metadata found for ${providerName}.`)
    if (!metadata.capabilities.thinkingFormat) gaps.push('Missing thinking format.')
    if (!metadata.capabilities.effortFormat) gaps.push('Missing effort format.')
    if (!metadata.capabilities.prefixCacheStrategy) gaps.push('Missing prefix cache strategy.')

    return {
      provider: providerName,
      status: metadata.defaultModels.length === 0 ? 'missing' : gaps.length > 0 ? 'incomplete' : 'ok',
      gaps,
    }
  })
}
```

修改 `src/api/provider.ts`：

```ts
// keep ProviderCapabilities, mapDeepSeekUsage, DEEPSEEK_CAPABILITIES, DEFAULT_CAPABILITIES here
// replace literal WELL_KNOWN_DEFAULTS with a registry-backed value:
import { getWellKnownProviderDefaults } from './provider-registry.js'

export const WELL_KNOWN_DEFAULTS: Record<string, ProviderCapabilities> = getWellKnownProviderDefaults()
```

如果循环 import 出现，移动 `ProviderCapabilities`、`DEEPSEEK_CAPABILITIES`、`DEFAULT_CAPABILITIES` 到 `provider-capabilities.ts`，再让 `provider.ts` 和 `provider-registry.ts` 同时从该文件导入。这个拆分只做在循环 import 确认发生时。

- [ ] **步骤 4：运行测试验证通过**

```bash
npm test -- src/api/__tests__/provider-registry.test.ts src/api/__tests__/conformance-scorecard.test.ts src/api/__tests__/provider.test.ts
npm run typecheck
```

预期：PASS，Provider registry 与既有 provider tests 全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/api/provider-registry.ts src/api/conformance-scorecard.ts src/api/__tests__/provider-registry.test.ts src/api/__tests__/conformance-scorecard.test.ts src/api/provider.ts
git commit -m "feat: add provider conformance registry"
```

---

## 任务 10：Docs and capability matrix output

**文件：**
- 创建：`docs/benchmark/README.md`
- 创建：`docs/benchmark/capability-matrix.md`
- 修改：`README.md`

- [ ] **步骤 1：编写文档内容**

创建 `docs/benchmark/README.md`：

```markdown
# Rivet Benchmark

Rivet benchmark runs are local JSONL records used to compare provider/model behavior across repeatable coding-agent tasks.

## Run the smoke suite

```bash
npm run benchmark -- --suite benchmark/tasks/r1-local-coding-smoke.json --suite-id r1-local-coding-smoke --provider deepseek --model deepseek-v4-pro --dry-run
```

The first implementation slice runs in dry-run mode. It validates task loading, run storage, and report generation without calling an external model.

## Files

- `benchmark/tasks/r1-local-coding-smoke.json`: 10 local coding-agent tasks.
- `benchmark/tasks/provider-conformance.json`: provider metadata and conformance checks.
- `docs/benchmark/run-records.jsonl`: local append-only run records.
- `docs/benchmark/capability-matrix.md`: markdown report format.

## Result fields

Each run records provider, model, suite, task, status, turns, tool calls, retries, cache hit rate, cost, and failure classes.

## Add a task

Add a JSON object with `id`, `title`, `category`, `prompt`, `setupCommands`, `successCommands`, `timeoutMs`, and `tags`. Run `npm test -- src/benchmark/__tests__/task-suite.test.ts` to validate the schema.
```

创建 `docs/benchmark/capability-matrix.md`：

```markdown
# Rivet Capability Matrix

This matrix is generated from local benchmark run records.

| Provider | Model | Suite | Runs | Pass rate | Median turns | Median tools | Avg cost USD |
|---|---|---|---:|---:|---:|---:|---:|
| deepseek | deepseek-v4-pro | r1-local-coding-smoke | 0 | 0% | 0 | 0 | 0.0000 |

## Interpretation

- Pass rate measures task success under the suite's success commands.
- Median turns and tool calls measure execution efficiency.
- Average cost is optional and appears as `0.0000` when no provider usage data is present.
- Dry-run entries are blocked by design and should not be used as capability claims.
```

在 `README.md` 的 Features 或 Development 附近加入：

```markdown
### Benchmark smoke suite

Rivet includes a local benchmark harness for provider/model capability tracking:

```bash
npm run benchmark -- --suite benchmark/tasks/r1-local-coding-smoke.json --suite-id r1-local-coding-smoke --provider deepseek --model deepseek-v4-pro --dry-run
```

Dry-run mode validates task definitions, run storage, and report plumbing without calling external providers. Full model execution is intentionally kept out of the first slice so capability scoring starts from a deterministic baseline.
```

- [ ] **步骤 2：运行文档相关验证**

```bash
npm run benchmark -- --suite benchmark/tasks/r1-local-coding-smoke.json --suite-id r1-local-coding-smoke --provider deepseek --model deepseek-v4-pro --dry-run
npm run typecheck
npm test -- src/benchmark/__tests__/types.test.ts src/benchmark/__tests__/store.test.ts src/benchmark/__tests__/report.test.ts src/benchmark/__tests__/task-suite.test.ts src/benchmark/__tests__/runner.test.ts
```

预期：benchmark dry-run 记录 10 条，typecheck 通过，benchmark 单元测试通过。

- [ ] **步骤 3：Commit**

```bash
git add docs/benchmark/README.md docs/benchmark/capability-matrix.md README.md
git commit -m "docs: add benchmark capability matrix guide"
```

---

## 任务 11：Full validation and code review

**文件：**
- 修改：无新增实现文件。只运行验证并修复前面任务引入的错误。

- [ ] **步骤 1：运行 focused benchmark tests**

```bash
npm test -- src/benchmark/__tests__/types.test.ts src/benchmark/__tests__/store.test.ts src/benchmark/__tests__/report.test.ts src/benchmark/__tests__/task-suite.test.ts src/benchmark/__tests__/runner.test.ts
```

预期：PASS，benchmark 相关测试全部通过。

- [ ] **步骤 2：运行 API/agent focused tests**

```bash
npm test -- src/api/__tests__/provider-registry.test.ts src/api/__tests__/conformance-scorecard.test.ts src/api/__tests__/provider.test.ts src/agent/__tests__/completion-guard.test.ts src/agent/__tests__/trace-store.test.ts src/agent/__tests__/loop-evidence.test.ts
```

预期：PASS，API registry、completion guard、trace/evidence 测试通过。

- [ ] **步骤 3：运行 typecheck**

```bash
npm run typecheck
```

预期：0 errors。

- [ ] **步骤 4：运行 full test suite**

```bash
npm test
```

预期：全部测试通过。当前 README 状态显示主线曾达到 1248 tests passing，本计划实施后测试数会增加。

- [ ] **步骤 5：运行 build**

```bash
npm run build
```

预期：tsup build success。

- [ ] **步骤 6：代码审查**

使用 code review agent 或 `/review` 检查：

- 是否破坏 DeepSeek prefix cache boundary。
- 是否引入 shell injection。
- Provider registry 是否产生循环 import。
- Benchmark dry-run 是否误报为真实能力分数。
- LSP diagnostics 是否在大输出下仍保留。

- [ ] **步骤 7：Commit validation fixes**

如果步骤 1-6 修复了代码：

```bash
git add <changed-files>
git commit -m "fix: address agent parity validation findings"
```

---

## R3 子计划边界：Trust Recovery UX

R3 应单独成计划，建议文件名：`docs/superpowers/plans/2026-05-17-rivet-trust-recovery-ux.md`。

R3 输入来自探查结果：

- `src/tui/app.tsx` 已经超过 1000 行，panic recovery 不应直接塞进 `handleSubmit`。
- `src/tui/error-boundary.tsx` 只能显示文本，没有 retry/rollback/resume 操作。
- `src/tui/cockpit/safety-panel.tsx` 和 `cockpit/rail.tsx` 目前偏只读，交互回调没有真正接上。
- `src/agent/checkpoint.ts` 已有 checkpoint/rollback 基础，但 timeline UI 不完整。

R3 第一版应包含：

1. 提取 recovery state model。
2. 新增 panic recovery panel。
3. checkpoint timeline view。
4. approval risk card action callbacks。
5. session resume status indicator。
6. TUI tests and one manual terminal QA run。

## R4 子计划边界：Open Model Lab

R4 应单独成计划，建议文件名：`docs/superpowers/plans/2026-05-17-rivet-open-model-lab.md`。

R4 输入来自本计划产物：

- `src/benchmark/*` runtime scorecard。
- `benchmark/tasks/provider-conformance.json`。
- `docs/benchmark/capability-matrix.md`。
- `src/api/conformance-scorecard.ts`。

R4 第一版应包含：

1. non-dry-run headless benchmark execution。
2. provider conformance API smoke tests with opt-in env keys。
3. cost/cache/success report aggregation。
4. public README matrix generation。
5. recorded demo runs for DeepSeek V4 Pro and at least one OpenAI-compatible provider。

## 风险控制

- Cache boundary risk：不要在本计划中改 `src/prompt/engine.ts` 的 request shape。
- Provider drift risk：新增 registry 后必须让 `provider.test.ts` 继续覆盖原有 defaults。
- Benchmark false claim risk：dry-run status 必须是 `blocked`，不能写成 `passed`。
- Shell injection risk：LSP 改造必须使用 `spawnSync(command, args)`，不能继续使用 shell string。
- TUI blast radius risk：R3 不在本计划中修改 `app.tsx`。

## 成功标准

- `npm test` 通过。
- `npm run typecheck` 通过。
- `npm run build` 通过。
- `npm run benchmark -- --suite benchmark/tasks/r1-local-coding-smoke.json --suite-id r1-local-coding-smoke --provider deepseek --model deepseek-v4-pro --dry-run` 生成 10 条 blocked dry-run records。
- `docs/benchmark/README.md` 明确 dry-run 不是能力声明。
- Trace/evidence 可以序列化，后续 benchmark runner 能读取执行指标。
- Provider registry 有测试，新增 provider 不再需要维护三份 metadata。

## 执行方式建议

推荐：子代理驱动。

- 子代理 1：任务 1-5，benchmark foundation。
- 子代理 2：任务 6-8，execution closure foundation。
- 子代理 3：任务 9，provider registry and scorecard。
- 主会话：任务 10-11，docs、validation、review。

每个子代理完成后先跑 focused tests，再由主会话跑 full suite。不要让多个子代理同时编辑 `package.json`、`README.md` 或 `src/agent/tool-pipeline.ts`。这些文件由主会话或单一子代理串行处理。

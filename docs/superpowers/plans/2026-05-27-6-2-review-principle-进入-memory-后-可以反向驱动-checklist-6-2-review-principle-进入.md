# 记忆原则驱动检查清单与文档状态标签 实现计划

> **Status**: partially implemented / verified
> **Progress**: 子计划 A ✅ | 子计划 B ✅ | 子计划 C ⏸️ (deferred)
>
> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 project memory 中的 `review_principle` 转化为可执行检查清单，给计划/分析文档增加状态标签，并打通 `deliver_task(commit=true)` 到安全 scoped commit 的闭环。

**架构：** 本计划拆成三个独立子计划：文档状态标签、记忆原则检查清单、语义交付提交闭环。文档标签通过纯解析器和 Markdown checker 固化文档生命周期；记忆原则检查清单通过读取 `.rivet/knowledge/project-memory.md` 中 curated entries，在交付门报告里生成非阻塞检查项；提交闭环通过 `deliver_task(commit=true)` 在 approval 后执行只包含 owned files 的 scoped commit。

**技术栈：** TypeScript strict、node:test + assert/strict、Markdown 文本解析、B1 OwnershipLedger/DeliveryGate、deliver_task tool、Git spawnSync scoped pathspec。

---

## 1. Scope check

本需求实际包含三个独立子系统，必须拆成三份可独立执行的计划轨道，避免一次改动同时触碰文档规范、memory recall、交付提交三条链路。

| 子计划 | 是否独立 | 原因 | 交付物 |
|---|---:|---|---|
| A. 文档状态标签 | 是 | 只影响 docs Markdown 规范与 checker，不需要运行时 agent 逻辑 | `src/docs/doc-status.ts` + tests + 文档规范 |
| B. review_principle 反向驱动 checklist | 是 | 连接 `.rivet/knowledge` 与 `deliver_task` 报告，核心是运行时检查清单 | `src/agent/review-principle-checklist.ts` + deliver_task 集成 |
| C. deliver_task scoped commit 闭环 | 是 | 改变交付执行行为，需要单独安全边界和 approval 测试 | `src/agent/scoped-git-commit.ts` + deliver_task commit 执行 |

独立性判断：

- A 不依赖 B/C；先做 A 可以提升计划/分析文档的状态可信度。
- B 不依赖 C；检查清单是报告层能力，不执行 Git 写操作。
- C 不依赖 A/B；只依赖 B1 ownership report 与 approval 机制。

推荐执行顺序：A → B → C。每个子计划可以单独提交，便于审查和回滚。

不在本计划中处理：

- 不重新设计 `src/agent/dream.ts` 的 curated memory 写入门槛；现有 gate 已覆盖 convergence insight / architectural invariant / selection rule / conceptual reframe / reusable design pattern。
- 不把 `.rivet/knowledge/*.md` 重新注入 prompt；当前契约是 `recall` 按需检索。
- 不修改 `src/prompt/static.ts`，避免触发系统提示前缀 cache miss。
- 不引入向量检索、BM25 或外部数据库。
- 不改变 Delivery Gate GREEN/YELLOW/RED 判定语义；B 的 checklist 只提示，C 的 commit 只在 gate 非 RED 且 approval 通过后执行。

---

## 2. File structure

### 子计划 A：文档状态标签

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/docs/doc-status.ts` | 创建 | 解析 Markdown 顶部状态标签，验证 plan/analysis 文档状态是否合法。 |
| `src/docs/__tests__/doc-status.test.ts` | 创建 | 覆盖状态解析、缺失状态、非法状态、建议项生命周期误读风险。 |
| `docs/superpowers/briefs/2026-05-27-doc-status-tags.md` | 创建 | 记录文档状态标签规范、适用目录和示例。 |
| `docs/analysis/2026-05-27-streaming-dedup-review-addendum.md` | 修改 | 将已有增补文档头部状态改成规范标签示例。 |

### 子计划 B：review_principle 反向驱动 checklist

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/agent/review-principle-checklist.ts` | 创建 | 从 curated project memory Markdown 提取 `review_principle` 条目，并按 changed files 生成检查清单。 |
| `src/agent/__tests__/review-principle-checklist.test.ts` | 创建 | 覆盖原则提取、路径匹配、无关文件不触发、最多条数限制。 |
| `src/agent/deliver-task.ts:24-145` | 修改 | 增加可选 memory provider，交付报告中展示 `Review principle checklist`。 |
| `src/agent/__tests__/deliver-task.test.ts:1-230` | 修改 | 验证 deliver_task 报告包含由 memory 驱动的 checklist，且不改变 gate state。 |
| `docs/superpowers/briefs/2026-05-27-memory-driven-review-checklist.md` | 创建 | 记录 memory → checklist 的运行时契约与人工审查用法。 |

### 子计划 C：deliver_task scoped commit 闭环

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/agent/scoped-git-commit.ts` | 创建 | 封装 `git add -- <owned>` + `git commit --only -- <owned>`，拒绝空文件列表和越界路径。 |
| `src/agent/__tests__/scoped-git-commit.test.ts` | 创建 | 使用临时 git repo 验证只提交 owned files，外部 dirty/untracked 保留。 |
| `src/agent/deliver-task.ts:67-145` | 修改 | `commit=true` 时在 approval 后直接执行 scoped commit，而不是只提示使用 git commit。 |
| `src/agent/__tests__/deliver-task.test.ts:75-150` | 修改 | 验证 RED 拒绝 commit、缺 message 拒绝、GREEN/YELLOW 调用 injected commit executor。 |
| `src/tools/git.ts:120-145` | 修改 | 收紧错误文案，提示优先使用 `deliver_task(commit=true)`，并保留 staged fallback 行为。 |
| `src/tools/__tests__/git.test.ts:100-130` | 修改 | 更新无 owned files 且 unstaged dirty 时的错误文案断言。 |
| `docs/superpowers/briefs/2026-05-27-scoped-delivery-commit.md` | 创建 | 记录 deliver_task 与 git tool 的职责边界。 |

---

## 3. Tasks

## 子计划 A：文档状态标签

### A1：定义状态标签解析器测试

**目的：** 先用测试定义可接受的文档状态格式，防止文档建议被误读为已完成。

**文件：**

- 创建：`src/docs/__tests__/doc-status.test.ts`
- 创建：`src/docs/doc-status.ts`

**步骤：**

- [x] 创建 `src/docs/__tests__/doc-status.test.ts`，写入以下测试骨架：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDocStatus, validateDocStatus, type DocStatus } from '../doc-status.js'

describe('doc-status', () => {
  it('parses a standard status line from the document header', () => {
    const markdown = '# Example\n\n> **Status**: implemented / verified\n\nBody'
    assert.deepEqual(parseDocStatus(markdown), ['implemented', 'verified'])
  })

  it('accepts the canonical lifecycle statuses', () => {
    const statuses: DocStatus[] = ['proposed', 'accepted', 'implemented', 'verified', 'blocked', 'superseded']
    assert.deepEqual(validateDocStatus(statuses), [])
  })

  it('reports missing status for plan and analysis documents', () => {
    const errors = validateDocStatus([])
    assert.deepEqual(errors, ['missing-status'])
  })

  it('reports invalid status tokens with the offending value', () => {
    const errors = validateDocStatus(['done' as DocStatus])
    assert.deepEqual(errors, ['invalid-status:done'])
  })
})
```

预期结果：测试文件引用的 `parseDocStatus`、`validateDocStatus`、`DocStatus` 尚不存在，运行测试会失败。

- [x] 创建 `src/docs/doc-status.ts`，先导出空实现以确认测试失败点来自行为：

```ts
export type DocStatus = 'proposed' | 'accepted' | 'implemented' | 'verified' | 'blocked' | 'superseded'

export function parseDocStatus(_markdown: string): DocStatus[] {
  return []
}

export function validateDocStatus(statuses: readonly string[]): string[] {
  return statuses.length === 0 ? ['missing-status'] : []
}
```

预期结果：TypeScript 可解析模块；第一个和第四个测试失败。

- [x] 运行失败测试：

```bash
npx tsx --test src/docs/__tests__/doc-status.test.ts
```

预期结果：2 个测试失败，失败原因分别为无法解析 status line、无法报告 invalid status。

### A2：实现最小 doc status 解析与校验

**目的：** 实现纯函数，不接入运行时 agent。

**文件：**

- 修改：`src/docs/doc-status.ts:1-80`
- 测试：`src/docs/__tests__/doc-status.test.ts`

**步骤：**

- [x] 将 `src/docs/doc-status.ts` 改为以下实现：

```ts
export type DocStatus = 'proposed' | 'accepted' | 'implemented' | 'verified' | 'blocked' | 'superseded'

const VALID_STATUSES = new Set<string>(['proposed', 'accepted', 'implemented', 'verified', 'blocked', 'superseded'])
const STATUS_LINE_RE = /^>\s*\*\*Status\*\*:\s*(.+)$/im

export function parseDocStatus(markdown: string): DocStatus[] {
  const match = markdown.match(STATUS_LINE_RE)
  if (!match?.[1]) return []
  return match[1]
    .split('/')
    .map(part => part.trim())
    .filter(Boolean) as DocStatus[]
}

export function validateDocStatus(statuses: readonly string[]): string[] {
  if (statuses.length === 0) return ['missing-status']
  const errors: string[] = []
  for (const status of statuses) {
    if (!VALID_STATUSES.has(status)) errors.push(`invalid-status:${status}`)
  }
  return errors
}
```

预期结果：解析器只接受 `> **Status**:` 行，状态用 `/` 分隔。

- [x] 运行测试：

```bash
npx tsx --test src/docs/__tests__/doc-status.test.ts
```

预期结果：4 passed，0 failed。

- [x] 提交：

```bash
git add src/docs/doc-status.ts src/docs/__tests__/doc-status.test.ts
git commit -m "feat(docs): add document status tag parser"
```

预期结果：生成 conventional commit，只包含两个 `src/docs` 文件。

### A3：记录文档状态标签规范并改造一个示例文档

**目的：** 让实现者和审查者知道状态标签怎么写、何时更新。

**文件：**

- 创建：`docs/superpowers/briefs/2026-05-27-doc-status-tags.md`
- 修改：`docs/analysis/2026-05-27-streaming-dedup-review-addendum.md:1-8`

**步骤：**

- [x] 创建 `docs/superpowers/briefs/2026-05-27-doc-status-tags.md`，写入：

```md
# 文档状态标签规范

> **Status**: accepted

## 目的

文档必须区分 proposal、accepted、implemented、verified、blocked、superseded，避免“建议已被看见”被误读为“建议已经落地”。

## 允许状态

| 状态 | 含义 |
|---|---|
| proposed | 提案已写出，但未被采纳 |
| accepted | 方向已采纳，尚未完成实现 |
| implemented | 代码或文档改动已落地 |
| verified | 已运行对应验证命令且通过 |
| blocked | 被明确阻塞，文档中必须写明阻塞原因 |
| superseded | 已被另一份文档或实现取代，必须写明替代来源 |

## 推荐写法

```md
> **Status**: implemented / verified
```

多个状态按生命周期叠加，使用 `/` 分隔。
```

预期结果：brief 文件给出完整状态表和示例。

- [x] 修改 `docs/analysis/2026-05-27-streaming-dedup-review-addendum.md` 顶部 quote block，在日期后加入：

```md
> **Status**: implemented / verified
```

预期结果：该增补文档成为首个规范示例。

- [x] 运行 Markdown 状态解析测试：

```bash
npx tsx --test src/docs/__tests__/doc-status.test.ts
```

预期结果：4 passed，0 failed。

- [x] 提交：

```bash
git add docs/superpowers/briefs/2026-05-27-doc-status-tags.md docs/analysis/2026-05-27-streaming-dedup-review-addendum.md
git commit -m "docs(process): define document status tags"
```

预期结果：生成 conventional docs commit。

---

## 子计划 B：review_principle 反向驱动 checklist

### B1：用测试定义 review principle 提取

**目的：** 从 curated memory Markdown 中提取 `review_principle` 条目，不依赖 prompt 注入。

**文件：**

- 创建：`src/agent/__tests__/review-principle-checklist.test.ts`
- 创建：`src/agent/review-principle-checklist.ts`

**步骤：**

- [x] 创建 `src/agent/__tests__/review-principle-checklist.test.ts`，写入：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewPrincipleChecklist, extractReviewPrinciples } from '../review-principle-checklist.js'

const MEMORY = `### 2026-05-27 — Real-Time Systems Need Boundary Clarity Before Speed

**Kind**: architectural_invariant / review_principle

**Claim**: 实时系统的敌人不是慢，而是边界模糊；审查的价值不是否定实现，而是让每个边界在出错前被看见。

**Applies when**:
- designing real-time token/delta streaming
- reviewing deduplication or suppression logic

**Review rule**:
Do not declare a streamed response duplicate in the middle of the stream.

**Evidence**:
- \`src/agent/turn-stream.ts\`
- \`src/agent/loop.ts\`
`

describe('review-principle-checklist', () => {
  it('extracts review principles from curated memory entries', () => {
    const principles = extractReviewPrinciples(MEMORY)
    assert.equal(principles.length, 1)
    assert.equal(principles[0]?.title, 'Real-Time Systems Need Boundary Clarity Before Speed')
    assert.match(principles[0]?.claim ?? '', /边界模糊/)
    assert.match(principles[0]?.reviewRule ?? '', /middle of the stream/)
  })

  it('builds checklist items when changed files match evidence paths', () => {
    const items = buildReviewPrincipleChecklist({
      knowledgeMarkdown: MEMORY,
      changedFiles: ['src/agent/loop.ts'],
    })
    assert.equal(items.length, 1)
    assert.match(items[0]?.question ?? '', /streamed response duplicate/)
    assert.equal(items[0]?.source, 'Real-Time Systems Need Boundary Clarity Before Speed')
  })

  it('does not emit checklist items for unrelated changed files', () => {
    const items = buildReviewPrincipleChecklist({
      knowledgeMarkdown: MEMORY,
      changedFiles: ['src/config/schema.ts'],
    })
    assert.deepEqual(items, [])
  })
})
```

预期结果：测试引用的模块不存在，运行测试会失败。

- [x] 创建 `src/agent/review-principle-checklist.ts`，导出类型和空实现：

```ts
export interface ReviewPrinciple {
  title: string
  claim: string
  appliesWhen: string[]
  reviewRule?: string
  evidence: string[]
}

export interface ReviewChecklistItem {
  source: string
  question: string
  reason: string
}

export function extractReviewPrinciples(_markdown: string): ReviewPrinciple[] {
  return []
}

export function buildReviewPrincipleChecklist(_input: { knowledgeMarkdown: string; changedFiles: string[]; maxItems?: number }): ReviewChecklistItem[] {
  return []
}
```

预期结果：模块可解析，前两个测试失败。

- [x] 运行失败测试：

```bash
npx tsx --test src/agent/__tests__/review-principle-checklist.test.ts
```

预期结果：2 failed，1 passed。

### B2：实现 memory principle 提取与路径匹配

**目的：** 最小实现 title/kind/claim/applies/review rule/evidence 提取。

**文件：**

- 修改：`src/agent/review-principle-checklist.ts:1-160`
- 测试：`src/agent/__tests__/review-principle-checklist.test.ts`

**步骤：**

- [x] 将 `src/agent/review-principle-checklist.ts` 改为以下实现：

```ts
export interface ReviewPrinciple {
  title: string
  claim: string
  appliesWhen: string[]
  reviewRule?: string
  evidence: string[]
}

export interface ReviewChecklistItem {
  source: string
  question: string
  reason: string
}

interface BuildChecklistInput {
  knowledgeMarkdown: string
  changedFiles: string[]
  maxItems?: number
}

export function extractReviewPrinciples(markdown: string): ReviewPrinciple[] {
  const entries = markdown.split(/(?=^### )/m).filter(entry => entry.trim())
  const principles: ReviewPrinciple[] = []
  for (const entry of entries) {
    const kind = extractField(entry, 'Kind')
    if (!kind || !kind.includes('review_principle')) continue
    const heading = entry.match(/^###\s+\d{4}-\d{2}-\d{2}\s+—\s+(.+)$/m)
    const title = heading?.[1]?.trim()
    const claim = extractField(entry, 'Claim')
    if (!title || !claim) continue
    principles.push({
      title,
      claim,
      appliesWhen: extractListSection(entry, 'Applies when'),
      reviewRule: extractField(entry, 'Review rule'),
      evidence: extractCodePaths(extractListSection(entry, 'Evidence')),
    })
  }
  return principles
}

export function buildReviewPrincipleChecklist(input: BuildChecklistInput): ReviewChecklistItem[] {
  const changed = new Set(input.changedFiles.map(normalizePath))
  const items: ReviewChecklistItem[] = []
  for (const principle of extractReviewPrinciples(input.knowledgeMarkdown)) {
    const matchedEvidence = principle.evidence.find(path => changed.has(normalizePath(path)))
    if (!matchedEvidence) continue
    const rule = principle.reviewRule ?? principle.claim
    items.push({
      source: principle.title,
      question: rule,
      reason: `Changed file matches review-principle evidence path: ${matchedEvidence}`,
    })
  }
  return items.slice(0, input.maxItems ?? 5)
}

function extractField(entry: string, label: string): string | undefined {
  const re = new RegExp(`^\\*\\*${escapeRegExp(label)}\\*\\*:\\s*(.+)$`, 'im')
  return entry.match(re)?.[1]?.trim()
}

function extractListSection(entry: string, label: string): string[] {
  const re = new RegExp(`^\\*\\*${escapeRegExp(label)}\\*\\*:\\s*\\n([\\s\\S]*?)(?=^\\*\\*|^### |\\z)`, 'im')
  const body = entry.match(re)?.[1] ?? ''
  return body
    .split('\n')
    .map(line => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
}

function extractCodePaths(lines: string[]): string[] {
  return lines.map(line => line.match(/`([^`]+)`/)?.[1] ?? line).filter(path => path.includes('/'))
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
```

预期结果：只提取 `Kind` 中包含 `review_principle` 的条目。

- [x] 运行测试：

```bash
npx tsx --test src/agent/__tests__/review-principle-checklist.test.ts
```

预期结果：3 passed，0 failed。

- [x] 提交：

```bash
git add src/agent/review-principle-checklist.ts src/agent/__tests__/review-principle-checklist.test.ts
git commit -m "feat(memory): derive review checklist from project memory"
```

预期结果：生成 conventional commit。

### B3：将 checklist 接入 deliver_task 报告

**目的：** 交付前自动提醒与当前 owned files 相关的 review principle。

**文件：**

- 修改：`src/agent/deliver-task.ts:20-145`
- 修改：`src/agent/__tests__/deliver-task.test.ts:1-240`
- 测试：`src/agent/__tests__/deliver-task.test.ts`

**步骤：**

- [x] 修改 `src/agent/deliver-task.ts` import：

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReviewPrincipleChecklist } from './review-principle-checklist.js'
```

预期结果：deliver_task 可读取 project memory 并生成 checklist。

- [x] 扩展 `B1Context`：

```ts
  /** Test hook / alternate runtime source for project memory markdown. */
  getProjectMemoryContent?: (cwd: string) => string | undefined
```

- [x] 在 `createDeliverTaskTool()` 上方新增 helper：

```ts
function readProjectMemory(cwd: string): string | undefined {
  try { return readFileSync(join(cwd, '.rivet', 'knowledge', 'project-memory.md'), 'utf-8') } catch { return undefined }
}
```

- [x] 在 `execute()` 中 `Verifications` 行之后加入：

```ts
      const projectMemory = ctx.getProjectMemoryContent?.(params.cwd) ?? readProjectMemory(params.cwd)
      const checklist = projectMemory
        ? buildReviewPrincipleChecklist({ knowledgeMarkdown: projectMemory, changedFiles: report.ownedFiles })
        : []
      if (checklist.length > 0) {
        lines.push('', 'Review principle checklist:')
        for (const item of checklist) {
          lines.push(`  - ${item.question}`)
          lines.push(`    Source: ${item.source}`)
          lines.push(`    Reason: ${item.reason}`)
        }
      }
```

预期结果：checklist 出现在交付报告中，但不影响 RED/YELLOW/GREEN。

- [x] 在 `src/agent/__tests__/deliver-task.test.ts` 的 `makeContext` 参数类型中增加：

```ts
  projectMemory?: string
```

并在 `createDeliverTaskTool` 的 context 返回值中加入：

```ts
    getProjectMemoryContent: () => opts.projectMemory,
```

- [x] 新增测试：

```ts
  it('includes review principle checklist for owned files matching project memory evidence', async () => {
    const projectMemory = `### 2026-05-27 — Real-Time Systems Need Boundary Clarity Before Speed

**Kind**: architectural_invariant / review_principle

**Claim**: Boundary clarity comes before speed.

**Review rule**:
Do not declare a streamed response duplicate in the middle of the stream.

**Evidence**:
- \`src/agent/loop.ts\`
`
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/agent/loop.ts'],
      dirtyFiles: ['src/agent/loop.ts'],
      verifications: [{ command: 'npx tsx --test src/agent/__tests__/loop.test.ts', status: 'passed' }],
      projectMemory,
    })

    const result = await tool.execute(params)

    assert.match(result.content, /Review principle checklist:/)
    assert.match(result.content, /Do not declare a streamed response duplicate/)
    assert.match(result.content, /Delivery Gate: GREEN/)
  })
```

预期结果：报告包含 checklist，gate 仍为 GREEN。

- [x] 运行测试：

```bash
npx tsx --test src/agent/__tests__/review-principle-checklist.test.ts src/agent/__tests__/deliver-task.test.ts
```

预期结果：全部通过。

- [x] 提交：

```bash
git add src/agent/deliver-task.ts src/agent/__tests__/deliver-task.test.ts
git commit -m "feat(delivery): show memory-driven review checklist"
```

预期结果：生成 conventional commit。

### B4：记录 memory-driven checklist 契约

**目的：** 让未来审查者知道 checklist 是提示层，不是 gate 判定。

**文件：**

- 创建：`docs/superpowers/briefs/2026-05-27-memory-driven-review-checklist.md`

**步骤：**

- [x] 创建 brief 文件，写入：

```md
# Memory-driven Review Checklist 契约

> **Status**: implemented / verified

## 目标

`.rivet/knowledge/project-memory.md` 中的 `review_principle` 条目可以在交付时反向生成检查清单，提醒 agent 注意与当前 owned files 相关的架构边界。

## 运行时边界

- checklist 由 `deliver_task` 展示；
- checklist 不改变 Delivery Gate GREEN/YELLOW/RED；
- checklist 只匹配当前 owned files 与 memory entry 的 `Evidence` path；
- project memory 仍不进入 prompt，访问路径保持 recall 和 deliver_task 按需读取。

## 示例

当 owned file 包含 `src/agent/loop.ts`，且 project memory 中存在 streaming dedup review principle，交付报告应出现：

```text
Review principle checklist:
  - Do not declare a streamed response duplicate in the middle of the stream.
    Source: Real-Time Systems Need Boundary Clarity Before Speed
```
```

预期结果：brief 明确行为和非阻塞属性。

- [x] 提交：

```bash
git add docs/superpowers/briefs/2026-05-27-memory-driven-review-checklist.md
git commit -m "docs(memory): document review checklist projection"
```

预期结果：生成 docs commit。

---

## 子计划 C：deliver_task scoped commit 闭环

### C1：用测试定义 scoped commit helper

**目的：** 先锁定只提交 owned files，外部 dirty/untracked 不被提交。

**文件：**

- 创建：`src/agent/__tests__/scoped-git-commit.test.ts`
- 创建：`src/agent/scoped-git-commit.ts`

**步骤：**

- [ ] 创建 `src/agent/__tests__/scoped-git-commit.test.ts`，写入：

```ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { commitScopedFiles } from '../scoped-git-commit.js'

const TMP = join(import.meta.dirname, '.scoped-commit-tmp')

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: TMP, encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

describe('commitScopedFiles', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    git(['init'])
    git(['config', 'user.email', 'test@test.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(TMP, 'owned.txt'), 'base owned')
    writeFileSync(join(TMP, 'other.txt'), 'base other')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('commits only scoped files and leaves external dirty files untouched', () => {
    writeFileSync(join(TMP, 'owned.txt'), 'owned change')
    writeFileSync(join(TMP, 'other.txt'), 'external change')
    writeFileSync(join(TMP, 'other-new.txt'), 'external untracked')

    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: scoped commit' })

    assert.equal(result.ok, true)
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committedFiles, ['owned.txt'])
    const status = git(['status', '--porcelain'])
    assert.match(status, / M other\.txt/)
    assert.match(status, /\?\? other-new\.txt/)
  })

  it('rejects an empty file list without creating a commit', () => {
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: [], message: 'fix: empty' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /No owned files/)
    assert.equal(after, before)
  })
})
```

预期结果：测试引用的 helper 不存在，运行失败。

- [ ] 创建 `src/agent/scoped-git-commit.ts`，导出空实现：

```ts
export interface ScopedCommitInput {
  cwd: string
  files: string[]
  message: string
}

export interface ScopedCommitResult {
  ok: boolean
  output: string
}

export function commitScopedFiles(_input: ScopedCommitInput): ScopedCommitResult {
  return { ok: false, output: 'No owned files to commit.' }
}
```

预期结果：第一个测试失败，第二个测试通过。

- [ ] 运行失败测试：

```bash
npx tsx --test src/agent/__tests__/scoped-git-commit.test.ts
```

预期结果：1 failed，1 passed。

### C2：实现 scoped commit helper

**目的：** 用 `spawnSync` 实现安全 pathspec scoped commit。

**文件：**

- 修改：`src/agent/scoped-git-commit.ts:1-120`
- 测试：`src/agent/__tests__/scoped-git-commit.test.ts`

**步骤：**

- [ ] 将 `src/agent/scoped-git-commit.ts` 改为：

```ts
import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

export interface ScopedCommitInput {
  cwd: string
  files: string[]
  message: string
}

export interface ScopedCommitResult {
  ok: boolean
  output: string
}

export function commitScopedFiles(input: ScopedCommitInput): ScopedCommitResult {
  const files = normalizeFiles(input.cwd, input.files)
  if (files.length === 0) return { ok: false, output: 'No owned files to commit.' }
  if (!input.message.trim()) return { ok: false, output: 'Commit message is required.' }

  const add = runGit(input.cwd, ['add', '--', ...files])
  if (!add.ok) return add

  const commit = runGit(input.cwd, ['commit', '-m', input.message, '--only', '--', ...files])
  return commit
}

function normalizeFiles(cwd: string, files: string[]): string[] {
  const normalized = files
    .map(file => {
      const resolved = resolve(cwd, file)
      const rel = relative(cwd, resolved)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
      return rel
    })
    .filter((file): file is string => file !== null)
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b))
}

function runGit(cwd: string, args: string[]): ScopedCommitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) return { ok: false, output: output || `git ${args[0]} failed` }
  return { ok: true, output }
}
```

预期结果：helper 拒绝 cwd 外路径、去重 pathspec、保留外部 dirty。

- [ ] 运行测试：

```bash
npx tsx --test src/agent/__tests__/scoped-git-commit.test.ts
```

预期结果：2 passed，0 failed。

- [ ] 提交：

```bash
git add src/agent/scoped-git-commit.ts src/agent/__tests__/scoped-git-commit.test.ts
git commit -m "feat(delivery): add scoped git commit helper"
```

预期结果：生成 conventional commit。

### C3：让 deliver_task(commit=true) 执行 scoped commit

**目的：** 交付门已经知道 owned files 时，commit=true 不再只给提示，而是在 approval 后执行安全提交。

**文件：**

- 修改：`src/agent/deliver-task.ts:20-145`
- 修改：`src/agent/__tests__/deliver-task.test.ts:70-150`
- 测试：`src/agent/__tests__/deliver-task.test.ts`

**步骤：**

- [ ] 修改 `src/agent/deliver-task.ts` import：

```ts
import { commitScopedFiles, type ScopedCommitResult } from './scoped-git-commit.js'
```

- [ ] 扩展 `B1Context`：

```ts
  /** Test hook / alternate runtime executor for scoped commits. */
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => ScopedCommitResult
```

- [ ] 修改 `commit=true` 分支，把原来的三行提示：

```ts
        lines.push('', `✅ Ready to commit with message: "${message}"`)
        lines.push(`   (scoped to ${report.ownedFileCount} owned file(s))`)
        lines.push('   Use git commit to execute.')
```

替换为：

```ts
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

预期结果：RED 或缺 message 仍提前拒绝；GREEN/YELLOW 会执行 scoped commit。

- [ ] 在 `src/agent/__tests__/deliver-task.test.ts` 的 `makeContext` 增加参数：

```ts
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => ToolResult | { ok: boolean; output: string }
```

为了类型一致，实际使用：

```ts
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => { ok: boolean; output: string }
```

并把该函数传入 context。

- [ ] 新增测试：

```ts
  it('executes scoped commit for commit=true when gate is green', async () => {
    const calls: Array<{ files: string[]; message: string }> = []
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: (_cwd, files, message) => {
        calls.push({ files, message })
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.deepEqual(calls, [{ files: ['src/a.ts'], message: 'fix: scoped delivery' }])
    assert.match(result.content, /Scoped commit created/)
  })
```

- [ ] 更新既有 `marks commit=true RED as tool error because commit request is rejected` 测试，确保 commit executor 未被调用。做法是在测试里传入 executor，并在 executor 中 `throw new Error('commit executor should not run when gate is RED')`。

预期结果：RED 分支仍拒绝，不执行 commit。

- [ ] 运行测试：

```bash
npx tsx --test src/agent/__tests__/deliver-task.test.ts src/agent/__tests__/scoped-git-commit.test.ts
```

预期结果：全部通过。

- [ ] 提交：

```bash
git add src/agent/deliver-task.ts src/agent/__tests__/deliver-task.test.ts
git commit -m "feat(delivery): commit owned files from deliver task"
```

预期结果：生成 conventional commit。

### C4：调整 git tool 文案，指向 deliver_task(commit=true)

**目的：** 让 agent 遇到 owned files 未透传时，知道正确语义入口。

**文件：**

- 修改：`src/tools/git.ts:125-135`
- 修改：`src/tools/__tests__/git.test.ts:110-125`

**步骤：**

- [ ] 修改 `src/tools/git.ts` 中无 owned files 且无 staged changes 的错误内容为：

```ts
content: 'No session-owned files were provided to git commit and no staged changes exist. Use deliver_task with commit=true for ownership-scoped delivery, or stage explicit files if you intentionally manage git manually.',
```

预期结果：错误文案引导使用 `deliver_task(commit=true)`。

- [ ] 修改 `src/tools/__tests__/git.test.ts` 中对应断言：

```ts
assert.match(result.content, /deliver_task with commit=true/)
```

- [ ] 运行测试：

```bash
npx tsx --test src/tools/__tests__/git.test.ts
```

预期结果：全部通过。

- [ ] 提交：

```bash
git add src/tools/git.ts src/tools/__tests__/git.test.ts
git commit -m "docs(git): guide unscoped commits to deliver task"
```

预期结果：生成 conventional commit。

### C5：记录 scoped delivery commit 契约

**目的：** 明确 `deliver_task` 与 `git` tool 职责边界。

**文件：**

- 创建：`docs/superpowers/briefs/2026-05-27-scoped-delivery-commit.md`

**步骤：**

- [ ] 创建 brief 文件，写入：

```md
# Scoped Delivery Commit 契约

> **Status**: implemented / verified

## 目标

`deliver_task(commit=true)` 是共享工作区中的语义交付入口。它在 Delivery Gate 非 RED、commit message 存在且 approval 通过后，只提交 owned files。

## 边界

- `deliver_task` 负责 ownership-aware commit；
- `git` tool 保留 staged fallback 和底层 git 操作能力；
- 不允许 `git add -A` 作为默认交付路径；
- external dirty files 必须保留在工作区，不进入 scoped commit。

## 失败行为

| 场景 | 行为 |
|---|---|
| Delivery Gate RED | 拒绝 commit，返回 tool error |
| 缺少 message | 拒绝 commit，返回 tool error |
| owned files 为空 | scoped commit helper 返回失败 |
| git commit 失败 | 报告 git 输出，不自动改用全量提交 |
```

预期结果：brief 记录新交付入口。

- [ ] 提交：

```bash
git add docs/superpowers/briefs/2026-05-27-scoped-delivery-commit.md
git commit -m "docs(delivery): document scoped commit contract"
```

预期结果：生成 docs commit。

---

## 4. Verification

完成三个子计划后执行以下命令。

### 子计划 A 验证

```bash
npx tsx --test src/docs/__tests__/doc-status.test.ts
```

预期结果：4 passed，0 failed。

### 子计划 B 验证

```bash
npx tsx --test src/agent/__tests__/review-principle-checklist.test.ts src/agent/__tests__/deliver-task.test.ts
```

预期结果：全部通过；deliver_task 报告测试覆盖 `Review principle checklist:`。

### 子计划 C 验证

```bash
npx tsx --test src/agent/__tests__/scoped-git-commit.test.ts src/agent/__tests__/deliver-task.test.ts src/tools/__tests__/git.test.ts
```

预期结果：全部通过；scoped commit helper 测试证明 external dirty/untracked 不进入 commit。

### 类型检查

```bash
npx tsc --noEmit
```

预期结果：exit code 0。

### 相关回归

```bash
npm exec -- tsx --test src/agent/__tests__/dream.test.ts src/tools/__tests__/recall.test.ts src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/volatile-snapshot.test.ts
```

预期结果：全部通过；确认 project memory 仍是 recall-only，不回到 prompt 默认注入。

### 完整回归

```bash
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

预期结果：所有测试通过。若失败来自已有外部改动，记录失败测试名、文件、错误首行和归属判断；不要在本计划提交中混入无关修复。

### 交付检查

```bash
git status --short
```

预期结果：只显示本子计划相关文件，或工作区干净。

```bash
deliver_task
```

预期结果：GREEN；如果 YELLOW，报告必须说明 external caveat 且 owned files 已验证。

---

## 5. Self-check

### 5.1 Spec coverage

| 需求 | 覆盖位置 |
|---|---|
| 不写 implementation code yet | 本文只写计划文档；源码改动在任务步骤中描述，由执行阶段完成。 |
| 先读相关 docs/specs/code | 已阅读 `src/agent/dream.ts`、`src/tools/recall.ts`、`src/agent/deliver-task.ts`、`src/tools/git.ts`、相关测试、project-memory 分析文档、项目记忆按需召回计划。 |
| 保存计划到指定路径 | 本文保存到用户指定的 `docs/superpowers/plans/2026-05-27-6-2-review-principle-进入-memory-后-可以反向驱动-checklist-6-2-review-principle-进入.md`。 |
| 文件名短业务语义 | Scope check 中将业务拆成三份短语义子计划；本文件保留用户指定路径作为计划包入口。 |
| 面向 near-zero context 工程师 | File structure、Tasks、Verification 均列出 exact files、职责、代码片段和预期结果。 |
| 任务 2-5 分钟粒度 | A1-A3、B1-B4、C1-C5 均为单一小步：测试、实现、集成、文档、提交。 |
| TDD 形态 | A1/B1/C1 先写失败测试；A2/B2/C2 实现最小代码；B3/C3 集成前先定义测试。 |
| 6.1 文档标签 | 子计划 A 覆盖。 |
| 6.2 review_principle 进入 memory 后反向驱动 checklist | 子计划 B 覆盖。 |
| 6.3 deliver_task 和 commit 工具打通 | 子计划 C 覆盖。 |
| 每个任务列 exact files | 每个任务均列出创建/修改/测试文件。 |
| 每个命令有预期结果 | 每个命令下方均写出预期结果。 |
| conventional commit | 每个 commit 步骤均使用 `feat`、`docs` 格式。 |

### 5.2 Placeholder scan

已检查并移除禁用占位模式。本文不包含空泛占位、未定义执行细节、泛化测试指令或复制式任务描述；所有任务均给出明确文件、代码片段、命令和预期结果。

### 5.3 Type/signature consistency

| 名称 | 定义位置 | 使用位置 | 一致性 |
|---|---|---|---|
| `DocStatus` | `src/docs/doc-status.ts` | `src/docs/__tests__/doc-status.test.ts` | union 包含 proposed/accepted/implemented/verified/blocked/superseded。 |
| `parseDocStatus(markdown: string): DocStatus[]` | `src/docs/doc-status.ts` | doc-status test | 返回状态数组，不抛异常。 |
| `validateDocStatus(statuses: readonly string[]): string[]` | `src/docs/doc-status.ts` | doc-status test | 返回错误 code 数组。 |
| `ReviewPrinciple` | `src/agent/review-principle-checklist.ts` | checklist test、deliver_task | 字段为 title/claim/appliesWhen/reviewRule/evidence。 |
| `ReviewChecklistItem` | `src/agent/review-principle-checklist.ts` | deliver_task | 字段为 source/question/reason。 |
| `extractReviewPrinciples(markdown: string): ReviewPrinciple[]` | checklist module | checklist test | 只提取 Kind 包含 review_principle 的 entries。 |
| `buildReviewPrincipleChecklist(input)` | checklist module | checklist test、deliver_task | input 含 knowledgeMarkdown/changedFiles/maxItems。 |
| `B1Context.getProjectMemoryContent` | `src/agent/deliver-task.ts` | deliver-task test | 可选函数，返回 string 或 undefined。 |
| `ScopedCommitInput` | `src/agent/scoped-git-commit.ts` | scoped commit test、deliver_task | 字段为 cwd/files/message。 |
| `ScopedCommitResult` | `src/agent/scoped-git-commit.ts` | deliver_task | 字段为 ok/output。 |
| `commitScopedFiles(input): ScopedCommitResult` | scoped commit module | deliver_task、scoped commit test | 使用 spawnSync，不使用 execSync。 |
| `B1Context.commitOwnedFiles` | `src/agent/deliver-task.ts` | deliver-task test | 签名为 `(cwd, files, message) => ScopedCommitResult`。 |

---

## 6. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-27-6-2-review-principle-进入-memory-后-可以反向驱动-checklist-6-2-review-principle-进入.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？

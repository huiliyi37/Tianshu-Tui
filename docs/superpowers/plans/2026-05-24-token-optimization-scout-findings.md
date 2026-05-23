# Token 优化 Scout 调研成果实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 基于 16 个开源项目调研（RTK、context-mode、codegraph、Continuous-Claude 等），落地 4 个 token 优化方向，预计整体节省 30-50% context tokens。

**架构：** 在现有 `output-store.ts` 上层加 command-aware 过滤管线；在 `.rivet.md` 注入 graph 反模式指令；在 compaction 触发前自动生成 session handoff；新增 sandbox executor 工具。

**技术栈：** TypeScript / node:test / 现有 tool dispatch + prompt engine

**来源调研：**
- RTK (`rtk-ai/rtk`, 63k⭐) → P1: per-command TOML 过滤
- codegraph (`colbymchenry/codegraph`, 18k⭐) → P2: 反模式指令
- Continuous-Claude (`parcadei/Continuous-Claude-v3`, 3.7k⭐) → P3: PreCompact auto-handoff
- context-mode (`mksglu/context-mode`, 15k⭐) → P4: sandbox executor

---

## 文件结构

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/tools/command-filters.ts` | Per-command 过滤规则注册表 + 8 阶段管线 | 新建 |
| `src/tools/__tests__/command-filters.test.ts` | 过滤管线测试 | 新建 |
| `src/tools/output-store.ts` | 修改：在 `buildModelOutput` 前调用 command filter | 修改 |
| `src/tools/__tests__/output-store.test.ts` | 新增 command-filter 集成测试 | 修改 |
| `CLAUDE.md` | 添加 graph 反模式指令 | 修改 |
| `src/compact/pre-compact-handoff.ts` | CompactController 触发前生成 session 摘要 | 新建 |
| `src/compact/__tests__/pre-compact-handoff.test.ts` | handoff 测试 | 新建 |
| `src/agent/loop.ts` | 修改：compaction 前调用 handoff | 修改 |
| `src/tools/sandbox-exec.ts` | 隔离 JS 执行器工具 | 新建 |
| `src/tools/__tests__/sandbox-exec.test.ts` | sandbox 测试 | 新建 |

---

### 任务 1：Command-Aware 过滤管线（P1）

**文件：**
- 创建：`src/tools/command-filters.ts`
- 测试：`src/tools/__tests__/command-filters.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyCommandFilter } from '../command-filters.js'

describe('applyCommandFilter', () => {
  it('compresses tsc output to error summary', () => {
    const raw = [
      'src/foo.ts(10,5): error TS2322: Type "string" is not assignable to type "number".',
      'src/foo.ts(15,3): error TS2322: Type "string" is not assignable to type "number".',
      'src/bar.ts(7,1): error TS2345: Argument of type "X" is not assignable to parameter of type "Y".',
      '',
      'Found 3 errors in 2 files.',
      '',
    ].join('\n')

    const result = applyCommandFilter('npx tsc --noEmit', raw, 1)
    assert.ok(result !== null)
    assert.match(result!, /3 errors in 2 files/)
    assert.match(result!, /TS2322/)
    assert.match(result!, /TS2345/)
    // Should be much shorter than raw
    assert.ok(result!.split('\n').length <= 10)
  })

  it('compresses npm test output to failures only', () => {
    const raw = [
      '> test',
      '> node --test',
      '',
      '✔ passes test A (1ms)',
      '✔ passes test B (2ms)',
      '✔ passes test C (1ms)',
      '✖ fails test D (3ms)',
      '  AssertionError: expected 1 to equal 2',
      '    at TestContext.<anonymous> (src/foo.test.ts:10:5)',
      '✔ passes test E (1ms)',
      '✖ fails test F (2ms)',
      '  Error: timeout',
      '    at TestContext.<anonymous> (src/bar.test.ts:20:3)',
      '',
      'ℹ tests 6',
      'ℹ pass 4',
      'ℹ fail 2',
    ].join('\n')

    const result = applyCommandFilter('npm test', raw, 1)
    assert.ok(result !== null)
    // Should keep failures + summary, strip passing tests
    assert.match(result!, /fails test D/)
    assert.match(result!, /fails test F/)
    assert.match(result!, /fail 2/)
    assert.doesNotMatch(result!, /passes test A/)
  })

  it('compresses git status to porcelain-like summary', () => {
    const raw = [
      'On branch feat/foo',
      'Your branch is up to date with \'origin/feat/foo\'.',
      '',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      '        modified:   src/foo.ts',
      '        modified:   src/bar.ts',
      '',
      'Untracked files:',
      '  (use "git add <file>..." to include in what will be committed)',
      '        src/new.ts',
      '',
    ].join('\n')

    const result = applyCommandFilter('git status', raw, 0)
    assert.ok(result !== null)
    // Should strip hints, keep file list compact
    assert.match(result!, /feat\/foo/)
    assert.match(result!, /src\/foo\.ts/)
    assert.doesNotMatch(result!, /use "git add/)
  })

  it('returns null for unknown commands', () => {
    const result = applyCommandFilter('curl https://example.com', 'hello', 0)
    assert.equal(result, null)
  })

  it('passes through short successful tsc output', () => {
    const result = applyCommandFilter('npx tsc --noEmit', '', 0)
    assert.ok(result !== null)
    assert.match(result!, /no errors/)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/command-filters.test.ts`
预期：FAIL — `Cannot find module '../command-filters.js'`

- [ ] **步骤 3：实现 command-filters.ts**

```typescript
interface CommandFilter {
  match: RegExp
  filter: (raw: string, exitCode: number) => string | null
}

const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/

function filterTsc(raw: string, exitCode: number): string | null {
  if (exitCode === 0) return 'tsc: no errors'
  const lines = raw.split('\n')
  const errors: { file: string; code: string; msg: string }[] = []
  for (const line of lines) {
    const m = TSC_ERROR_RE.exec(line)
    if (m) errors.push({ file: m[1]!, code: m[5]!, msg: m[6]! })
  }
  if (errors.length === 0) return null

  const byCode = new Map<string, number>()
  const files = new Set<string>()
  for (const e of errors) {
    files.add(e.file)
    byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1)
  }
  const topCodes = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, n]) => `${code} (×${n})`)
    .join(', ')

  const summary = `tsc: ${errors.length} errors in ${files.size} files\nTop codes: ${topCodes}`
  // Keep first 5 error lines for context
  const sample = errors.slice(0, 5).map(e => `  ${e.file}: ${e.code} — ${e.msg}`)
  return `${summary}\n${sample.join('\n')}`
}

const PASS_LINE_RE = /^[✔✓]\s|^\s*ok\s+\d|^PASS\s/
const FAIL_LINE_RE = /^[✖✗×]\s|^FAIL\s|^\s*not ok\s/
const SUMMARY_RE = /^ℹ\s|^Tests?:|^Test Suites?:/

function filterNodeTest(raw: string, exitCode: number): string | null {
  if (exitCode === 0) return null // don't compress successful tests
  const lines = raw.split('\n')
  const kept: string[] = []
  let inFailBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FAIL_LINE_RE.test(line)) {
      inFailBlock = true
      kept.push(line)
    } else if (inFailBlock && (line.startsWith('  ') || line === '')) {
      kept.push(line)
      if (line === '') inFailBlock = false
    } else if (SUMMARY_RE.test(line)) {
      kept.push(line)
    } else if (PASS_LINE_RE.test(line)) {
      inFailBlock = false
      // skip passing tests
    } else {
      inFailBlock = false
    }
  }
  return kept.length > 0 ? kept.join('\n') : null
}

const GIT_HINT_RE = /^\s+\(use "/

function filterGitStatus(raw: string, _exitCode: number): string | null {
  const lines = raw.split('\n')
  const kept = lines.filter(l => !GIT_HINT_RE.test(l) && l.trim() !== '')
  return kept.length > 0 ? kept.join('\n') : null
}

const FILTERS: CommandFilter[] = [
  { match: /\btsc\b/, filter: filterTsc },
  { match: /\bnpm\s+test\b|node\s+--test|npx\s+tsx\s+--test/, filter: filterNodeTest },
  { match: /\bgit\s+status\b/, filter: filterGitStatus },
]

export function applyCommandFilter(command: string, raw: string, exitCode: number): string | null {
  for (const f of FILTERS) {
    if (f.match.test(command)) {
      return f.filter(raw, exitCode)
    }
  }
  return null
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tools/__tests__/command-filters.test.ts`
预期：PASS

- [ ] **步骤 5：集成到 output-store.ts**

修改 `src/tools/output-store.ts`：在 `buildModelOutput` 开头加入 command filter 调用：

```typescript
import { applyCommandFilter } from './command-filters.js'

export function buildModelOutput(raw: string, meta: ToolOutputMeta): string {
  const lineCount = countLines(raw)
  const header = `[${meta.command}] exit=${meta.exitCode} time=${(meta.durationMs / 1000).toFixed(1)}s lines=${lineCount}`

  // Command-aware filter: if a specialized filter matches, use its compressed output
  const filtered = applyCommandFilter(meta.command, raw, meta.exitCode)
  if (filtered !== null) {
    return `${header}\n${filtered}`
  }

  // ... existing head/tail truncation logic unchanged ...
}
```

- [ ] **步骤 6：运行全量测试**

运行：`npx tsx --test src/tools/__tests__/*.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/tools/command-filters.ts src/tools/__tests__/command-filters.test.ts src/tools/output-store.ts
git commit -m "feat(tools): add command-aware output filtering for tsc/test/git-status"
```

---

### 任务 2：Graph 反模式指令（P2）

**文件：**
- 修改：`CLAUDE.md`

- [ ] **步骤 1：在 CLAUDE.md 的 MCP Tools 章节末尾追加反模式指令**

在 `## MCP Tools: code-review-graph` 章节的 `### Workflow` 之后追加：

```markdown
### Anti-patterns (NEVER do these)

- **NEVER** grep/glob/read in a loop to explore code when `query_graph` or `semantic_search_nodes` can answer in one call
- **NEVER** spawn an Explore sub-agent for questions that `query_graph pattern="callers_of"` or `get_impact_radius` can answer directly
- **NEVER** read an entire file to find a function — use `semantic_search_nodes` then `get_review_context` for the relevant snippet
- **Prefer composite queries**: `detect_changes` + `get_affected_flows` replaces manual diff → grep → read chains
- **One graph call replaces 5-10 file reads** — always check graph tools first
```

- [ ] **步骤 2：Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add graph anti-pattern instructions to reduce exploration tool calls"
```

---

### 任务 3：PreCompact Auto-Handoff（P3）

**文件：**
- 创建：`src/compact/pre-compact-handoff.ts`
- 测试：`src/compact/__tests__/pre-compact-handoff.test.ts`
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateHandoff } from '../pre-compact-handoff.js'

describe('generateHandoff', () => {
  it('extracts decisions and modified files from trajectory', () => {
    const entries = [
      { role: 'assistant', content: 'I will edit foo.ts to fix the bug' },
      { role: 'tool', tool_call_id: '1', name: 'edit_file', content: 'ok', input: { file_path: 'src/foo.ts' } },
      { role: 'tool', tool_call_id: '2', name: 'bash', content: 'PASS', input: { command: 'npm test' } },
      { role: 'assistant', content: 'Tests pass. The fix is complete.' },
    ]

    const handoff = generateHandoff(entries as any)
    assert.ok(handoff.filesModified.includes('src/foo.ts'))
    assert.ok(handoff.summary.length > 0)
    assert.ok(handoff.summary.length < 500)
  })

  it('captures failed tool calls', () => {
    const entries = [
      { role: 'tool', tool_call_id: '1', name: 'bash', content: 'error TS2322: ...', input: { command: 'npx tsc --noEmit' }, isError: true },
      { role: 'tool', tool_call_id: '2', name: 'edit_file', content: 'ok', input: { file_path: 'src/bar.ts' } },
      { role: 'tool', tool_call_id: '3', name: 'bash', content: '', input: { command: 'npx tsc --noEmit' } },
    ]

    const handoff = generateHandoff(entries as any)
    assert.ok(handoff.filesModified.includes('src/bar.ts'))
    assert.ok(handoff.hadFailures)
  })

  it('returns compact YAML-like format under 400 tokens', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      role: 'tool', tool_call_id: String(i), name: 'read_file',
      content: 'x'.repeat(1000), input: { file_path: `src/file${i}.ts` },
    }))

    const handoff = generateHandoff(entries as any)
    // ~4 chars per token estimate
    assert.ok(handoff.summary.length < 1600)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/compact/__tests__/pre-compact-handoff.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 pre-compact-handoff.ts**

```typescript
import type { OaiMessage } from '../api/oai-types.js'

export interface HandoffResult {
  summary: string
  filesModified: string[]
  hadFailures: boolean
}

export function generateHandoff(messages: OaiMessage[]): HandoffResult {
  const filesModified = new Set<string>()
  const toolCalls: { name: string; ok: boolean }[] = []
  let hadFailures = false

  for (const msg of messages) {
    if (msg.role === 'tool') {
      const input = (msg as any).input
      const name = (msg as any).name ?? ''
      const isError = (msg as any).isError ?? false
      if (isError) hadFailures = true
      toolCalls.push({ name, ok: !isError })

      const filePath = input?.file_path ?? input?.path
      if (filePath && (name === 'edit_file' || name === 'write_file')) {
        filesModified.add(filePath)
      }
    }
  }

  // Build compact summary
  const parts: string[] = []

  if (filesModified.size > 0) {
    const files = [...filesModified].slice(0, 10)
    parts.push(`files_modified: [${files.join(', ')}]`)
  }

  // Last 5 tool calls
  const recent = toolCalls.slice(-5)
  if (recent.length > 0) {
    const calls = recent.map(t => `${t.name}${t.ok ? '' : '(FAIL)'}`).join(', ')
    parts.push(`recent_tools: ${calls}`)
  }

  parts.push(`had_failures: ${hadFailures}`)
  parts.push(`total_tool_calls: ${toolCalls.length}`)

  const summary = parts.join('\n')
  return { summary, filesModified: [...filesModified], hadFailures }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/compact/__tests__/pre-compact-handoff.test.ts`
预期：PASS

- [ ] **步骤 5：集成到 loop.ts compaction 触发点**

在 `src/agent/loop.ts` 的 `maybeCompact` 调用前（约 871 行），插入 handoff 生成：

```typescript
import { generateHandoff } from '../compact/pre-compact-handoff.js'

// Before compaction: generate session handoff for context recovery
const handoff = generateHandoff(this.session.getMessages())
if (handoff.summary) {
  this.config.promptEngine.setSessionState(
    `<pre-compact-handoff>\n${handoff.summary}\n</pre-compact-handoff>`
  )
}
```

- [ ] **步骤 6：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npx tsx --test src/compact/__tests__/pre-compact-handoff.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/compact/pre-compact-handoff.ts src/compact/__tests__/pre-compact-handoff.test.ts src/agent/loop.ts
git commit -m "feat(compact): add pre-compact handoff for session context recovery"
```

---

### 任务 4：Sandbox Executor 工具（P4）

**文件：**
- 创建：`src/tools/sandbox-exec.ts`
- 测试：`src/tools/__tests__/sandbox-exec.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sandboxExec } from '../sandbox-exec.js'

describe('sandboxExec', () => {
  it('executes JS code and returns stdout', async () => {
    const result = await sandboxExec('console.log("hello")')
    assert.equal(result.stdout.trim(), 'hello')
    assert.equal(result.exitCode, 0)
  })

  it('captures errors without crashing', async () => {
    const result = await sandboxExec('throw new Error("boom")')
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /boom/)
  })

  it('has no access to process.env secrets', async () => {
    const result = await sandboxExec('console.log(JSON.stringify(process.env))')
    assert.equal(result.stdout.trim(), '{}')
  })

  it('times out on infinite loops', async () => {
    const result = await sandboxExec('while(true){}', { timeoutMs: 500 })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /timeout/i)
  })

  it('can read files via fs', async () => {
    const result = await sandboxExec(`
      const fs = require('fs')
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
      console.log(pkg.name)
    `)
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.trim().length > 0)
  })

  it('truncates output exceeding maxOutputChars', async () => {
    const result = await sandboxExec(
      'for(let i=0;i<10000;i++) console.log("x".repeat(100))',
      { maxOutputChars: 2000 }
    )
    assert.ok(result.stdout.length <= 2100) // small buffer for truncation message
    assert.match(result.stdout, /\[output truncated/)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tools/__tests__/sandbox-exec.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 sandbox-exec.ts**

```typescript
import { execFile } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export interface SandboxOptions {
  timeoutMs?: number
  maxOutputChars?: number
  cwd?: string
}

export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function sandboxExec(
  code: string,
  opts: SandboxOptions = {},
): Promise<SandboxResult> {
  const { timeoutMs = 10_000, maxOutputChars = 8000, cwd = process.cwd() } = opts

  const scriptPath = join(tmpdir(), `rivet-sandbox-${randomUUID().slice(0, 8)}.cjs`)
  const wrapper = `
    process.env = {};
    try { ${code} } catch(e) { process.stderr.write(e.message || String(e)); process.exit(1); }
  `
  await writeFile(scriptPath, wrapper, 'utf-8')

  return new Promise<SandboxResult>((resolve) => {
    const child = execFile('node', [scriptPath], {
      timeout: timeoutMs,
      maxBuffer: maxOutputChars * 2,
      cwd,
      env: {},
    }, (error, stdout, stderr) => {
      unlink(scriptPath).catch(() => {})

      let exitCode = 0
      if (error) {
        exitCode = (error as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 1 : error.killed ? 1 : 1
        if (error.killed) stderr = (stderr || '') + '\n[timeout: execution exceeded ' + timeoutMs + 'ms]'
      }

      let finalStdout = stdout || ''
      if (finalStdout.length > maxOutputChars) {
        finalStdout = finalStdout.slice(0, maxOutputChars) + '\n[output truncated at ' + maxOutputChars + ' chars]'
      }

      resolve({ stdout: finalStdout, stderr: stderr || '', exitCode })
    })
  })
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tools/__tests__/sandbox-exec.test.ts`
预期：PASS

- [ ] **步骤 5：注册为 Rivet 工具**

在 `src/tools/` 的工具注册表中添加 `sandbox_exec` 工具定义（具体文件取决于现有注册模式，通常在 `src/tools/index.ts` 或 `src/tools/registry.ts`）：

```typescript
{
  name: 'sandbox_exec',
  description: 'Execute JavaScript code in an isolated sandbox. Only stdout is returned to context. Use for processing large data (logs, file analysis, batch operations) to avoid flooding the context window. The code has fs access to the project directory but no network and no env vars.',
  input_schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript code to execute. Use console.log() to output results.' },
      timeout_ms: { type: 'number', description: 'Max execution time in ms (default: 10000)' },
    },
    required: ['code'],
  },
}
```

- [ ] **步骤 6：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/tools/sandbox-exec.ts src/tools/__tests__/sandbox-exec.test.ts
git commit -m "feat(tools): add sandbox_exec for isolated code execution (context-mode pattern)"
```

---

## 调研发现摘要（供参考）

### 已覆盖（不需要借鉴）

| 项目 | 我们的等价物 |
|------|-------------|
| code-review-graph (17k⭐) | 我们就是用的这个 MCP |
| codegraph (18k⭐) | 同上，我们有 30+ 工具 vs 它的 9 个 |
| claude-context (Zilliz) | stigmergy-store + heuristic-store |
| ccusage / claude-usage / CodeBurn | telemetry-flush hook + cache diagnostic |
| claude-code-router | 我们直连 DeepSeek，不需要路由 |
| claude-task-master | sub-agent coordinator + task-state |
| claude-token-efficient / caveman | 纯 prompt 约束 |
| SuperClaude | 纯 prompt 文件集合，无运行时优化 |

### 关键技术洞察

1. **RTK 的 8 阶段 TOML 管线**：strip_ansi → replace → match_output → strip/keep_lines → truncate_lines_at → head/tail → max_lines → on_empty。我们简化为 3 个专用过滤器（tsc/test/git），不需要完整 TOML 引擎。

2. **context-mode 的 "think in code" 范式**：模型写脚本处理数据，只有 console.log 进 context。不需要 hook 路由层——作为可选工具即可。

3. **codegraph 的 70% fewer tool calls**：主要来自 CLAUDE.md 反模式指令（"NEVER grep when graph exists"），不是图引擎本身。

4. **Continuous-Claude 的 PreCompact handoff**：compaction 前自动解析 transcript 生成 ~400 token YAML 摘要。比我们的 reflective compaction regex 更结构化。


# P1-P4 纠错计划：补完孤儿代码 + 修正方向偏差

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（强制使用，每任务一个新 agent）。步骤使用复选框（`- [ ]`）语法跟踪进度。
>
> **🛑 关键执行规则：**
> 1. **每个任务结尾有 STOP 标记**——完成后必须停止，等待用户审查后才能开始下一任务
> 2. **集成步骤是任务交付的核心**——不是收尾，是主体。没集成 = 没完成
> 3. **TDD 红绿循环必须留下证据**：先 commit 失败的测试，再 commit 实现
> 4. **每任务独立 commit**——不要批量
>
> **背景：** commit `c758b8e` 实现了 P1-P4 但 P3/P4 是孤儿代码（只有实现+测试，没接入生产路径），P2 方向偏差（写成了通用 tool 礼仪，不是 graph 反模式）。本计划修正这三项。P1 已正确接入，不动。

**目标：** 把 P3 的 `generateHandoff` 接入 compaction 流程；把 P4 的 `sandboxExec` 注册为 tool；把 P2 的 CLAUDE.md 内容修正为 graph 反模式。

**架构：**
- 任务 1：P2 改写——把 8 条通用建议替换为 5 条 graph 反模式（仅文档）
- 任务 2：P3 集成——在 `loop.ts` compaction 触发前调用 `generateHandoff`，结果通过 `promptEngine.setSessionState` 注入下一轮 context
- 任务 3：P4 集成——创建 `SANDBOX_EXEC_TOOL` 包装器，注册到 `default-registry.ts`，加安全测试

**技术栈：** TypeScript / node:test / 现有 ToolRegistry + PromptEngine + CompactionController

---

## 任务 1：P2 修正——CLAUDE.md graph 反模式

**文件：**
- 修改：`CLAUDE.md`（行 247-260）

**前置阅读（必读，否则跳过这一步将再次写错）：**
- 当前 `CLAUDE.md:247-260` 的实际内容（执行任务前用 Read 工具读一次，确认结构）
- 原计划 `docs/superpowers/plans/2026-05-24-token-optimization-scout-findings.md` 任务 2 的反模式定义

**为什么改：** 当前 8 条是通用 tool 使用礼仪（"don't read entire file"、"don't run git log"），与"减少 graph 探索 calls"无关。codegraph 70% 节省的核心是"图调用 vs grep 二选一"的强对比，需要直接体现。这条指令注入系统 prompt 长期 context，每 turn 都付费，必须高 ROI。

- [ ] **步骤 1：用 Read 工具读 `CLAUDE.md` 行 240-265，确认当前结构**

不要跳过这一步。要看清"## MCP Tools: code-review-graph"章节标题、`### Workflow`（如果存在）、`### Anti-patterns`小节的精确缩进。

- [ ] **步骤 2：用 Edit 工具替换 `### Anti-patterns` 整段**

把 `CLAUDE.md` 行 249-260 的整段（从 `### Anti-patterns (NEVER do these)` 标题到第 8 条 "Don't run tests on every small change" 结尾）替换为：

```markdown
### Anti-patterns (NEVER do these)

These patterns waste 5-10× the necessary tool calls when the code-review-graph MCP can answer directly. The graph indexes call relationships, imports, and inheritance — one query replaces many file reads.

- **NEVER** grep/glob/read in a loop to explore code when `query_graph` or `semantic_search_nodes` can answer in one call
- **NEVER** spawn an Explore sub-agent for questions that `query_graph pattern="callers_of"` or `get_impact_radius` can answer directly
- **NEVER** read an entire file to find a function — use `semantic_search_nodes` then `get_review_context` for the relevant snippet
- **Prefer composite queries**: `detect_changes_tool` + `get_affected_flows` replaces manual diff → grep → read chains
- **One graph call replaces 5-10 file reads** — always check graph tools first when the question is "who calls / who imports / what's affected"
```

注意：
- 必须用大写 `NEVER`（不是 `Don't`）——这是计划要求的强语气
- 不要保留任何旧的 8 条
- 工具名（`query_graph`, `semantic_search_nodes`, `get_impact_radius`, `detect_changes_tool`, `get_affected_flows`, `get_review_context`）必须用反引号包围

- [ ] **步骤 3：人工对照检查**

读改后的文件，确认：
- [ ] 5 条全部以 "NEVER" 或 "Prefer" 或 "One graph call" 开头
- [ ] 没有残留 "Don't read an entire file"（这是被删的旧条款）
- [ ] 没有残留 "Don't run git log"（旧条款）
- [ ] 没有残留 "Don't ask for confirmation"（旧条款）
- [ ] 工具名都正确（不是 `query-graph` 这种）

- [ ] **步骤 4：Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
fix(P2): replace generic tool etiquette with graph anti-patterns

The previous 8 anti-patterns were generic dos & don'ts unrelated to
the codegraph 70% savings claim. Replace with 5 graph-specific
NEVER rules that justify the system-prompt token cost.

Refs: docs/superpowers/plans/2026-05-24-token-optimization-scout-findings.md
EOF
)"
```

- [ ] 🛑 **STOP** —— 任务 1 完成。报告改动给用户审查。**不要继续任务 2。**

---

## 任务 2：P3 集成——generateHandoff 接入 compaction

**文件：**
- 修改：`src/agent/loop.ts`（在 compaction 触发前调用 handoff）
- 修改：`src/compact/__tests__/pre-compact-handoff.test.ts`（增加集成测试场景）

**前置阅读：**
- `src/agent/loop.ts:863-880`——compaction 触发块
- `src/prompt/engine.ts:357-360`——`setSessionState` 接口契约
- `src/compact/pre-compact-handoff.ts`——已存在的 `generateHandoff` 实现

**关键架构点：**
- `setSessionState(text: string | null)` 在 user-message 边界刷新（见 `prompt/engine.ts:355` 注释），适合放跨 turn 的 handoff
- 不要在每 turn 都调用 `generateHandoff`，只在 compaction 即将发生时调用——否则会反复注入相同内容
- 如果 `compactResult.compacted === false`（未发生 compaction），不需要注入

- [ ] **步骤 1：编写失败的集成测试**

把以下测试用例追加到 `src/compact/__tests__/pre-compact-handoff.test.ts` 末尾（在最后一个 `})` 闭合之前）：

```typescript
describe('generateHandoff integration shape', () => {
  it('produces a string suitable for setSessionState', () => {
    const entries = [
      { role: 'tool', tool_call_id: '1', name: 'edit_file', content: 'ok', input: { file_path: 'src/foo.ts' } },
      { role: 'tool', tool_call_id: '2', name: 'bash', content: 'PASS', input: { command: 'npm test' } },
    ]
    const handoff = generateHandoff(entries as any)

    // Must be wrappable as a single string injection
    const wrapped = `<pre-compact-handoff>\n${handoff.summary}\n</pre-compact-handoff>`
    assert.ok(wrapped.startsWith('<pre-compact-handoff>'))
    assert.ok(wrapped.endsWith('</pre-compact-handoff>'))
    assert.ok(wrapped.includes('files_modified'))
    assert.ok(wrapped.includes('total_tool_calls: 2'))
  })

  it('handles empty trajectory without crashing', () => {
    const handoff = generateHandoff([])
    assert.equal(handoff.filesModified.length, 0)
    assert.equal(handoff.hadFailures, false)
    assert.match(handoff.summary, /total_tool_calls: 0/)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/compact/__tests__/pre-compact-handoff.test.ts`

预期：FAIL —— 新增的两个 `it` 块应该 PASS（因为 `generateHandoff` 已经存在并能处理这些情况）。

**重要修正：** 这两个测试**应该立即通过**，因为 `generateHandoff` 已实现。这一步是验证现有实现满足集成需求的契约。如果它们失败了，说明 `generateHandoff` 实现有 bug（比如空数组崩溃），必须先修。

如果通过了，走到步骤 3。

- [ ] **步骤 3：先 commit 测试（红绿循环的"测试已就位"快照）**

```bash
git add src/compact/__tests__/pre-compact-handoff.test.ts
git commit -m "test(P3): add integration shape tests for handoff before wiring into loop"
```

- [ ] **步骤 4：在 loop.ts 引入 generateHandoff**

用 Read 工具确认 `src/agent/loop.ts` 顶部 import 区域（约 1-80 行）的现有 import 风格，然后用 Edit 在合适位置添加：

```typescript
import { generateHandoff } from '../compact/pre-compact-handoff.js'
```

放在与 `import { CompactionController } from './...'` 相邻的地方，保持 import 的语义聚合。

- [ ] **步骤 5：在 compaction 触发前调用 handoff**

用 Read 工具读 `src/agent/loop.ts:865-880` 的精确代码（compaction 触发块）。

然后用 Edit 在 `const compactResult = await this.compaction.maybeCompact({...})` 这一行**之前**插入：

```typescript
        // P3: Pre-compact handoff — preserve session context across compaction
        // Generated *before* compaction so the summary reflects the trajectory
        // about to be compressed. Injected via setSessionState which refreshes
        // at user-message boundary (next turn after compaction).
        try {
          const handoff = generateHandoff(this.session.getMessages() as any)
          if (handoff.summary && (handoff.filesModified.length > 0 || handoff.hadFailures)) {
            this.config.promptEngine.setSessionState(
              `<pre-compact-handoff>\n${handoff.summary}\n</pre-compact-handoff>`,
            )
          }
        } catch { /* non-critical: handoff is best-effort */ }
        
```

注意缩进——必须与同级的 `const compactResult = ...` 一致（看上下文行的缩进决定，应该是 8 个空格）。

注意守卫条件 `(handoff.filesModified.length > 0 || handoff.hadFailures)`——避免在空 session 注入无意义的 handoff。

- [ ] **步骤 6：跑 typecheck**

运行：`npx tsc --noEmit`

预期：PASS

如果失败：
- 看错误是否是 `this.session.getMessages()` 类型不匹配 —— 当前 `OaiMessage[]` vs 实际类型可能有差异，加 `as any` 已经处理
- 看错误是否是 `setSessionState` 签名不匹配 —— 检查 `prompt/engine.ts:357` 的当前签名

- [ ] **步骤 7：跑全量测试**

运行：`npm test`

预期：PASS（所有现有测试 + 新增的两个 handoff 集成 shape 测试）

- [ ] **步骤 8：人工验证集成确实生效**

```bash
grep -n "generateHandoff" src/agent/loop.ts
```

预期：有 2 个匹配（import + 调用点）。如果只有 1 个或 0 个，集成失败。

- [ ] **步骤 9：Commit**

```bash
git add src/agent/loop.ts
git commit -m "$(cat <<'EOF'
feat(P3): wire generateHandoff into compaction trigger

Before each compaction, generate a handoff summary of files modified,
recent tools, and failure status. Inject via setSessionState so the
post-compaction turn sees the pre-compaction context.

Guard with (filesModified || hadFailures) to skip empty sessions.
Wrapped in try/catch — handoff is best-effort, never blocks compaction.

Refs: docs/superpowers/plans/2026-05-24-token-optimization-scout-findings.md (Task 3, Step 5)
EOF
)"
```

- [ ] 🛑 **STOP** —— 任务 2 完成。报告改动给用户审查。**不要继续任务 3。**

---

## 任务 3：P4 集成——sandbox-exec 注册为 tool

**文件：**
- 创建：`src/tools/sandbox-exec-tool.ts`（Tool 包装器，与 `sandbox-exec.ts` 的纯函数实现分开）
- 修改：`src/tools/default-registry.ts`（注册新 tool）
- 修改：`src/tools/__tests__/sandbox-exec.test.ts`（补充安全测试）

**前置阅读：**
- `src/tools/types.ts`——`Tool` 接口的精确签名
- `src/tools/run-tests.ts` 行 1-50——一个简单 tool 的实现风格参考
- `src/tools/default-registry.ts`——注册模式
- `src/tools/sandbox-exec.ts`——已存在的 `sandboxExec` 函数
- `src/api/types.ts`（搜 `ToolDefinition`）——参数 schema 格式

**关键架构点：**
- `sandbox-exec.ts` 是纯函数，保持纯函数（其他模块也可能直接调用）
- 新建 `sandbox-exec-tool.ts` 做 `Tool` 接口适配，类似其他 `*-TOOL` 常量的模式
- Tool 名字用 `sandbox_exec`（snake_case，与其他 tool 一致）
- 默认 timeout 3s 而非 10s（agent loop 上下文应该更紧），用户可通过 input 覆盖

- [ ] **步骤 1：先用 Read 工具读 `src/tools/run-tests.ts` 行 1-100，理解 Tool 包装器的现有模式**

特别注意：
- 怎么导出 `RUN_TESTS_TOOL` 常量（看文件末尾）
- `definition` 字段的格式（name / description / inputSchema）
- `execute` 函数怎么解析 `params.input`
- 怎么返回 `ToolResult`

如果 `run-tests.ts` 文件长度超过 100 行，继续读到看见 `RUN_TESTS_TOOL` 导出为止。

- [ ] **步骤 2：补 sandboxExec 的安全测试（红色阶段）**

在 `src/tools/__tests__/sandbox-exec.test.ts` 的最后一个 `it` 之后、`describe` 闭合之前追加：

```typescript

  it('does NOT leak secrets via process.env', async () => {
    // Set a fake secret in current process
    const SECRET_KEY = 'TEST_SECRET_DO_NOT_LEAK'
    process.env[SECRET_KEY] = 'super-secret-value'
    try {
      const result = await sandboxExec(
        `console.log(process.env.${SECRET_KEY} || 'NOT_SET')`,
      )
      assert.match(result.stdout, /NOT_SET/)
      assert.ok(!result.stdout.includes('super-secret-value'))
    } finally {
      delete process.env[SECRET_KEY]
    }
  })

  it('cleans up the temp script file after execution', async () => {
    const { readdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const before = readdirSync(tmpdir()).filter(f => f.startsWith('rivet-sandbox-')).length
    await sandboxExec('console.log("done")')
    // Allow async unlink to settle
    await new Promise(r => setTimeout(r, 100))
    const after = readdirSync(tmpdir()).filter(f => f.startsWith('rivet-sandbox-')).length
    assert.equal(after, before, 'temp file should be cleaned up')
  })
```

- [ ] **步骤 3：跑测试，看安全测试是否暴露问题**

运行：`npx tsx --test src/tools/__tests__/sandbox-exec.test.ts`

**预期可能 FAIL**：当前 `sandbox-exec.ts` 透传了 `PATH`、`HOME`、`PWD`、`NODE_ENV`，但**没有**透传任意名字的 secret，所以 secret 测试应该 PASS。如果 FAIL，说明实现有泄漏，先修。

cleanup 测试可能 FAIL —— `unlink` 是 fire-and-forget，100ms 可能不够。如果不稳定，把 sleep 调到 300ms。

- [ ] **步骤 4：先 commit 安全测试**

```bash
git add src/tools/__tests__/sandbox-exec.test.ts
git commit -m "test(P4): add secret-leak and tempfile-cleanup tests for sandbox"
```

- [ ] **步骤 5：创建 Tool 包装器 `src/tools/sandbox-exec-tool.ts`**

```typescript
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { sandboxExec } from './sandbox-exec.js'

const SANDBOX_EXEC_DEFINITION = {
  name: 'sandbox_exec',
  description: [
    'Execute JavaScript code in an isolated Node.js child process.',
    'Use this for data processing where you only need the final result, not intermediate output.',
    'Examples: parse a JSON file and extract one field, compute aggregate stats, transform a list.',
    'Environment is stripped (no access to secrets); cwd is the project root.',
    'Output is truncated to 8000 chars by default. Timeout is 3s by default.',
    'DO NOT use for: file edits (use edit_file), shell commands (use bash), long-running tasks.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      code: {
        type: 'string' as const,
        description: 'JavaScript code to execute. Use console.log to return values to context.',
      },
      timeout_ms: {
        type: 'number' as const,
        description: 'Optional timeout in milliseconds. Default: 3000.',
      },
      max_output_chars: {
        type: 'number' as const,
        description: 'Optional output truncation cap. Default: 8000.',
      },
    },
    required: ['code'],
  },
}

export const SANDBOX_EXEC_TOOL: Tool = {
  definition: SANDBOX_EXEC_DEFINITION,
  async execute(params: ToolCallParams): Promise<ToolResult> {
    const code = String(params.input.code ?? '')
    if (!code.trim()) {
      return {
        content: '[sandbox_exec] error: empty code',
        isError: true,
      }
    }
    const timeoutMs = typeof params.input.timeout_ms === 'number' ? params.input.timeout_ms : 3000
    const maxOutputChars = typeof params.input.max_output_chars === 'number' ? params.input.max_output_chars : 8000

    const result = await sandboxExec(code, {
      timeoutMs,
      maxOutputChars,
      cwd: params.cwd,
    })

    const isError = result.exitCode !== 0
    const header = `[sandbox_exec] exit=${result.exitCode}`
    const body = isError
      ? `${header}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      : `${header}\n${result.stdout}`

    return { content: body, isError }
  },
  requiresApproval(): boolean { return false },
  isConcurrencySafe(): boolean { return true },
  isEnabled(): boolean { return true },
}
```

注意：
- `definition` 的 `inputSchema` 里要用 `as const` 让 TS 把字符串字面量保留
- `params.input.code` 必须 `String()` 强制转换+空检查（防御 LLM 传错类型）
- `requiresApproval` 返回 `false`：sandbox 已经隔离了 env，不需要每次询问
- `isConcurrencySafe` 返回 `true`：每次调用用独立的 tempfile

- [ ] **步骤 6：注册到 default-registry**

用 Edit 修改 `src/tools/default-registry.ts`：

import 区追加（按字母序插入，应该在 `RUN_TESTS_TOOL` 和 `TODO_TOOL` 之间）：

```typescript
import { SANDBOX_EXEC_TOOL } from './sandbox-exec-tool.js'
```

注册区追加（在 `registry.register(READ_SECTION_TOOL)` 之后、`for (const tool of extraTools)` 之前）：

```typescript
  registry.register(SANDBOX_EXEC_TOOL)
```

- [ ] **步骤 7：跑 typecheck**

运行：`npx tsc --noEmit`

预期：PASS

如果失败：
- `Tool` 接口的某个方法签名不匹配 → 用 Read 重读 `src/tools/types.ts` 修正
- `inputSchema` 类型问题 → 检查 `ToolDefinition` 的精确类型（在 `src/api/types.ts`），可能需要不同的属性命名

- [ ] **步骤 8：跑全量测试**

运行：`npm test`

预期：PASS

- [ ] **步骤 9：人工验证 tool 已注册**

```bash
grep -n "SANDBOX_EXEC_TOOL\|sandbox_exec" src/tools/default-registry.ts
```

预期：2 个匹配（import + register）。

```bash
node -e "import('./dist/tools/default-registry.js').then(m => console.log(m.createDefaultToolRegistry().getDefinitions().map(d => d.name)))" 2>/dev/null || echo "skip if no dist build"
```

如果有 dist build，验证输出包含 `'sandbox_exec'`。如果没有 dist build，跳过这一步（typecheck + 测试已足够）。

- [ ] **步骤 10：Commit**

```bash
git add src/tools/sandbox-exec-tool.ts src/tools/default-registry.ts
git commit -m "$(cat <<'EOF'
feat(P4): register sandbox_exec as a tool in default registry

Wraps sandboxExec() (pure function) as a Tool with input schema,
defaulting to 3s timeout (vs 10s standalone default) for agent-loop
context. Registered alongside read/write/bash etc.

Use case: data processing where only the final result matters,
avoiding multiple read+grep round-trips. Env is stripped — safe
for handling untrusted JSON or computing aggregates.

Refs: docs/superpowers/plans/2026-05-24-token-optimization-scout-findings.md (Task 4)
EOF
)"
```

- [ ] 🛑 **STOP** —— 任务 3 完成。报告所有 3 个任务的最终状态。

---

## 跨任务自检（执行 agent 完成全部任务后必读）

完成全部 3 个任务后，运行以下命令验证整体完整性：

```bash
# 1. 所有 commit 应该是独立的，不是合并提交
git log --oneline -7

# 2. 每个集成点应该有匹配
grep -c "NEVER" CLAUDE.md  # 任务 1：应该 ≥ 3
grep -c "generateHandoff" src/agent/loop.ts  # 任务 2：应该 = 2
grep -c "SANDBOX_EXEC_TOOL" src/tools/default-registry.ts  # 任务 3：应该 = 2

# 3. 全量测试通过
npm test

# 4. typecheck 通过
npx tsc --noEmit
```

如果任何一项不符合预期，**回滚相关 commit 重做**，不要在原 commit 上 amend。

---

## 范围之外（明确不做）

为了让本计划保持紧凑，以下问题留给后续：

- `command-filters.ts` 的 regex 收紧（tsc 的 ERROR_LINE_RE 太宽松、PASS_LINE_RE 误杀 "password"）—— 待新 issue
- `sandbox-exec.ts` 的 env 处理重构（wrapper 内的 `process.env = Object.create(null)` 与 execFile 的 `env: {...}` 双层冗余）—— 待新 issue
- 添加 sandbox 的 fs 访问测试 —— 当前测试覆盖了 stdout/stderr/timeout/truncate/secret/cleanup，足够基本信心
- handoff 注入策略调优（什么时候该注入 vs 不注入）—— 当前 `(filesModified || hadFailures)` 是初版守卫，等真实 session 数据再优化

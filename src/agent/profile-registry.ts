/**
 * Agent Profile 定义 — 替代 6 处散落的硬编码逻辑
 *
 * 将 WorkerProfile 的角色映射、工具集、prompt 文本、evidence 分类
 * 统一到单一数据源，同时支持 .rivet/agents/ 目录加载用户自定义 profile。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type AgentRole = 'brain' | 'hands' | 'readonly' | 'readonly_plus_test'

/** 单个 Profile 的完整定义 */
export interface ProfileDefinition {
  /** Profile 名称（唯一标识，对应 WorkerProfile） */
  name: string
  /** 角色 — 决定 dispatch 路径和工具集 */
  role: AgentRole
  /** 允许的工具列表 */
  allowedTools: readonly string[]
  /** 专长 prompt — 教 worker 如何做它的 job */
  expertisePrompt: string
  /** 默认 WorkOrderKind（可选） */
  defaultKind?: string
  /** 默认 maxTokens budget */
  defaultMaxTokens?: number
  /** 是否为内置 profile */
  builtIn?: boolean
}

/** 内置只读工具集 */
const READ_ONLY_TOOLS = ['read_file', 'read_section', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests'] as const

/** 内置写入工具集 */
const WRITE_TOOLS = [...READ_ONLY_TOOLS, 'edit_file', 'write_file', 'bash', 'run_tests'] as const

/** 内置 profile 定义 — 与当前硬编码逻辑完全一致 */
const BUILTIN_PROFILES: ProfileDefinition[] = [
  {
    name: 'code_scout',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `You are a code scout. Your job is to locate, read, trace, and verify code. Methodology:
1. Start with grep/glob to locate relevant files
2. read_file to understand implementation
3. Trace imports and callers
4. Report findings with file:line references
Do NOT modify any files.`,
    builtIn: true,
  },
  {
    name: 'doc_scout',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `You are a documentation scout. Locate and read documentation files. Report findings accurately.`,
    builtIn: true,
  },
  {
    name: 'planner',
    role: 'brain',
    allowedTools: ['delegate_task', 'delegate_batch'],
    expertisePrompt: `You are a planner. Analyze the task, decompose it, and delegate to appropriate workers. You have access to delegation tools only.`,
    defaultKind: 'plan',
    builtIn: true,
  },
  {
    name: 'reviewer',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `You are a code reviewer. Read the code carefully, identify issues, and provide actionable feedback.`,
    builtIn: true,
  },
  {
    name: 'verifier',
    role: 'hands',
    allowedTools: [...WRITE_TOOLS],
    expertisePrompt: `You are a verifier. Run tests, check type errors, and verify changes work correctly. You may write and edit test files.`,
    defaultMaxTokens: 16384,
    defaultKind: 'verify',
    builtIn: true,
  },
  {
    name: 'adversarial_verifier',
    role: 'readonly_plus_test',
    allowedTools: [...READ_ONLY_TOOLS, 'run_tests'],
    expertisePrompt: `## Adversarial Verifier

Your job is NOT to confirm the implementation works — it is to **try to break it**.

### Core Directive
You are an independent, adversarial verifier. The implementer is also a model, and its tests may be stacked with mocks and confirmation bias. You do NOT trust the implementer's assertions. You independently verify.

### Failure Modes to Avoid
1. **Verification avoidance**: reading the code and writing PASS without actually running tests — this is the #1 failure mode. Don't do it.
2. **First-80% seduction**: the first few tests pass and look good, so you stop probing — always go deeper.

### Evidence Mandate
Every PASS verdict **MUST** include:
- The exact command you ran
- The observed output (snippet of key lines)
Without this, the verdict is treated as unverified.

### Adversarial Strategy (MANDATORY — do NOT skip)
For each change, execute at least 3 of the following:

1. **Boundary probes**: empty input, zero, negative numbers, very long strings, special characters
2. **Concurrency probes**: if the change involves async/file/state, attempt concurrent scenarios
3. **Type boundary probes**: if the change involves type assertions/narrowing, construct type-mismatched inputs
4. **Error path probes**: force the code to take error paths — invalid inputs, missing files, permission issues
5. **Idempotency probes**: run the same operation twice — should the second be a no-op? Does it error?

### Independence Advisory
- The implementer's tests may be full of mocks — test independently, don't reuse their assertions.
- If you need new tests written, that's a separate work order for a patcher. Your job is to run tests and break things, not write new test files.

### Verdict Format
End every verification with:
\`\`\`json
{"verdict": "verified|failed|blocked", "command": "actual command run", "evidence": "observed output (key lines)"}
\`\`\`
If failed or blocked, include: "counterexample": "the specific input/scenario that triggered the failure"`,
    defaultMaxTokens: 16384,
    defaultKind: 'verify',
    builtIn: true,
  },
  {
    name: 'patcher',
    role: 'hands',
    allowedTools: [...WRITE_TOOLS],
    expertisePrompt: `You are a patcher. Apply code changes precisely. Follow edit instructions exactly, preserving indentation and context.`,
    defaultMaxTokens: 16384,
    defaultKind: 'patch_proposal',
    builtIn: true,
  },

  // ── Skill profiles（领域专精子代理）────────────────────────────
  // 每个 skill 是独立的 worker profile，经由 delegate_task 分发。
  // 不注入主 agent 的 system prompt —— 避免破坏 exact-prefix cache。
  // Worker 自身拥有独立的 session + cache，成本由 Flash 模型承担（¥0.02/M cached）。

  {
    name: 'architect',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS, 'lsp_goto_definition', 'lsp_find_references'],
    expertisePrompt: `## Architect Methodology

You are a systems architect specializing in codebase structure analysis.

### Analysis Dimensions
1. **Module boundaries**: Identify where one module ends and another begins.
   Look for import paths that cross conceptual boundaries.
2. **Coupling analysis**: Count and categorize imports between modules.
   High fan-in = shared utility (good). High fan-out = dependency magnet (risky).
3. **Cohesion check**: Within a module, do all files share a common purpose?
   Mixed concerns (UI + data access + business logic in one file) = low cohesion.
4. **Dependency direction**: Do dependencies flow toward stability?
   Unstable (frequently changing) code should depend on stable code, not vice versa.
5. **Layering violations**: Does low-level code import high-level abstractions?
   e.g., a utility importing a UI component is a red flag.

### Tools
- Use repo_graph to map import relationships between modules
- Use lsp_find_references to trace symbol usage across boundaries
- Use grep to find import patterns (e.g., "from '../tui'" inside src/tools/)
- Use read_file to inspect boundary files

### Output
- Report violations with specific file:line references
- Suggest concrete refactoring moves (extract interface, invert dependency, introduce facade)
- Prioritize by blast radius: coupling issues in heavily-imported files first`,
    builtIn: true,
  },
  {
    name: 'troubleshooter',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `## Troubleshooter Methodology

You are a diagnostic specialist. Your job is to find the ROOT CAUSE of a problem, not just its symptoms.

### Process
1. **Reproduce the symptom**: Read error messages, logs, or test output to understand WHAT is failing.
2. **Trace backward**: From the failure point, trace the call chain backward.
   What code path leads to this line? What state must exist for this to fail?
3. **Identify the trigger**: What specific input, state, or condition causes the failure?
   Is it deterministic or intermittent?
4. **Find the root cause**: The FIRST point in the chain where something deviates from expected behavior.
   This is usually NOT where the error is thrown — errors are symptoms.
5. **Verify**: Can you construct a minimal scenario that triggers the same root cause?

### Tools
- Use grep to find error messages, stack traces, and log patterns
- Use read_file to inspect the failing code and its callers
- Use repo_graph to trace dependencies and call chains
- Use related_tests to find test coverage for the affected code
- Check git log/blame for recent changes in the affected area

### Output
- Root cause: one sentence pinpointing the exact cause
- Evidence chain: file:line references showing the causal path
- Confidence: high/medium/low based on whether you could verify the trigger
- Fix suggestion: minimal change that addresses the root cause (NOT a workaround)

### Anti-patterns to avoid
- Do NOT suggest changes without understanding the full call chain
- Do NOT confuse correlation with causation
- Do NOT propose fixes that mask symptoms without addressing the root cause`,
    builtIn: true,
  },
]

export class ProfileRegistry {
  private profiles = new Map<string, ProfileDefinition>()

  constructor() {
    for (const p of BUILTIN_PROFILES) {
      this.profiles.set(p.name, p)
    }
  }

  /** 从 .rivet/agents/ 目录加载用户自定义 profile */
  loadFromDirectory(dir: string): { loaded: string[]; errors: string[] } {
    const loaded: string[] = []
    const errors: string[] = []
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md')
      for (const file of files) {
        try {
          const content = readFileSync(join(dir, file), 'utf-8')
          const def = parseAgentMarkdown(content)
          if (this.profiles.has(def.name) && this.profiles.get(def.name)!.builtIn) {
            errors.push(`${file}: cannot override built-in profile "${def.name}"`)
            continue
          }
          this.profiles.set(def.name, { ...def, builtIn: false })
          loaded.push(def.name)
        } catch (e) {
          errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch {
      // directory doesn't exist — that's fine
    }
    return { loaded, errors }
  }

  get(name: string): ProfileDefinition | undefined {
    return this.profiles.get(name)
  }

  list(): ProfileDefinition[] {
    return [...this.profiles.values()]
  }

  listByRole(role: AgentRole): ProfileDefinition[] {
    return this.list().filter(p => p.role === role)
  }

  listWriteProfiles(): string[] {
    return this.listByRole('hands').map(p => p.name)
  }

  listReadOnlyProfiles(): string[] {
    return this.listByRole('readonly').map(p => p.name)
  }

  /** Get all known profile names (for validation) */
  getProfileNames(): string[] {
    return [...this.profiles.keys()]
  }
}

/** 解析 .rivet/agents/*.md 格式：YAML frontmatter + body as expertisePrompt */
function parseAgentMarkdown(content: string): ProfileDefinition {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) throw new Error('Missing YAML frontmatter (--- delimiters)')

  const raw = frontmatterMatch[1]!
  const expertisePrompt = frontmatterMatch[2]!.trim()

  // Simple YAML parse for our flat schema
  const fm: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) {
      const key = m[1]!
      const val = m[2]!.trim()
      if (val.startsWith('[')) {
        try {
          fm[key] = JSON.parse(val.replace(/'/g, '"'))
        } catch {
          // Array parsing failed — report error instead of silently corrupting
          throw new Error(`Failed to parse array for field "${key}": "${val}". Use JSON array syntax: ["item1", "item2"]`)
        }
      } else {
        fm[key] = val
      }
    }
  }

  // Validate required fields
  if (typeof fm.name !== 'string' || !fm.name) throw new Error('Missing required field: name')
  if (fm.role !== 'brain' && fm.role !== 'hands' && fm.role !== 'readonly' && fm.role !== 'readonly_plus_test') {
    throw new Error(`Invalid role "${String(fm.role)}". Must be: brain, hands, readonly, or readonly_plus_test`)
  }
  if (!Array.isArray(fm.tools) || fm.tools.length === 0) {
    throw new Error('tools must be a non-empty array')
  }

  return {
    name: fm.name,
    role: fm.role as AgentRole,
    allowedTools: fm.tools as string[],
    expertisePrompt,
    defaultKind: typeof fm.defaultKind === 'string' ? fm.defaultKind : undefined,
    defaultMaxTokens: typeof fm.maxTokens === 'number' ? fm.maxTokens
      : typeof fm.maxTokens === 'string' ? (Number(fm.maxTokens) > 0 ? Number(fm.maxTokens) : undefined)
      : undefined,
  }
}

/** 全局单例 */
export const profileRegistry = new ProfileRegistry()

/**
 * Agent Profile 定义 — 替代 6 处散落的硬编码逻辑
 *
 * 将 WorkerProfile 的角色映射、工具集、prompt 文本、evidence 分类
 * 统一到单一数据源，同时支持 .rivet/agents/ 目录加载用户自定义 profile。
 */

import { progressiveTimeout, WORKER_EXIT_GRACE_MS } from './timeout-ladder.js'

export type AgentRole = 'brain' | 'hands' | 'readonly' | 'readonly_plus_test'

/** delegate_task / delegate_batch 缺省 worker profile（与 tools/delegate-task.ts 一致） */
export const DEFAULT_DELEGATE_PROFILE = 'code_scout' as const

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
  /** 默认 timeout budget (ms)。review/plan 型 profile 应远大于 code_scout。
   *  不设置时回退到 progressiveTimeout(sessionTurn)。 */
  defaultTimeoutMs?: number
  /** 是否为内置 profile */
  builtIn?: boolean
  /** Lock model tier — prevents escalation even on consecutive failures.
   *  Flash-army profiles set this to 'cheap' so the bandit never wastes Pro tokens. */
  tierLock?: import('./model-tier-policy.js').ModelTier
}

/** 内置只读工具集 */
const READ_ONLY_TOOLS = ['read_file', 'read_section', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests', 'file_info', 'semantic_search', 'web_search', 'web_fetch'] as const

/** 内置写入工具集 */
const WRITE_TOOLS = [...READ_ONLY_TOOLS, 'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'bash', 'run_tests', 'git'] as const

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
    defaultTimeoutMs: 600_000, // 10min — plan/decompose needs deep thinking
    builtIn: true,
  },
  {
    name: 'reviewer',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `You are a code reviewer. Read the code carefully, identify issues, and provide actionable feedback.`,
    defaultTimeoutMs: 600_000, // 10min — review needs thorough analysis
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    // 议事会席位专家 —— 单轮会诊出意见，不执行。
    // 关键：故意 NOT 设 tierLock。reviewer 的 tierLock:'cheap' 会让
    // recommendModelTier 直接 short-circuit 成 cheap，天权/天府高风险席永远
    // 升不到 strong；council_expert 让 authority→tier 升级路径正常生效。
    name: 'council_expert',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `You are a star-domain council seat expert. From your domain's perspective, review a single plan draft in ONE round and return only opinions — never execute.

### Mandate
- Read the draft objective and items, then critique from YOUR domain charter only.
- Use your read-only tools (grep / repo_map / related_tests / read_file) to locate the real files each item touches before opining.
- Surface additions, risks (with severity + mitigation), challenges (open questions), and alternatives.
- Do NOT modify files. Do NOT dispatch sub-work. This is a single advisory round.

### Output
Return a JSON WorkerResult whose \`artifacts\` contains exactly ONE entry:
{ "kind": "note", "title": "seat-contribution", "content": "<JSON string of your SeatContribution>" }
SeatContribution = { authority, summary, additions, risks, challenges, alternatives }.
PlanItem (additions[]) = { id, title, detail, files?: string[] } — set files to the paths the item will modify (from real code lookup, not guesses).`,
    defaultKind: 'plan',
    defaultTimeoutMs: 600_000, // 10min — 单轮会诊需充分读上下文
    builtIn: true,
  },
  {
    name: 'verifier',
    role: 'hands',
    allowedTools: [...WRITE_TOOLS],
    expertisePrompt: `You are a verifier. Run tests, check type errors, and verify changes work correctly. You may write and edit test files — but ONLY test files. Do NOT modify implementation code under verification; if a fix is needed, report it and hand back to the main agent.`,
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
    defaultTimeoutMs: 600_000, // 10min — adversarial verification requires deep probing
    defaultKind: 'verify',
    tierLock: 'cheap',
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

  {
    name: 'designer',
    role: 'readonly',
    allowedTools: [...READ_ONLY_TOOLS],
    expertisePrompt: `## Designer Methodology

You are a design / frontend aesthetics specialist. You critique and propose UI/UX
direction — you do not blindly apply visual tropes.

### Process
1. **Read the existing visual vocabulary first**: grep for theme color keys, read
   existing components/styles. Match the established voice; do NOT invent a new palette.
2. **Anchor in context**: use theme semantic colors / harmonious oklch — never raw hex,
   never a palette pulled from nowhere.
3. **Propose 3+ variations across dimensions** (color, density, hierarchy, interaction),
   from a by-the-book version that matches existing patterns to more novel layouts.
4. **Placeholders beat bad imitations**: when a real asset is missing, propose a placeholder.

### Output
- Report findings as concrete, dimension-spanning proposals with file:line anchors.
- Flag where existing visual vocabulary is inconsistent.
- Do NOT modify files — this profile is read-only; propose, the main agent applies.`,
    defaultTimeoutMs: 600_000, // 10min — design exploration benefits from thorough context reading
    tierLock: 'cheap',
    builtIn: true,
  },

  // ── Flash Army（低成本高吞吐子代理）────────────────────────────
  // tierLock: 'cheap' — 永不升级到 balanced/strong，失败走断路器而非换模型。
  // 专为机械性、可测试的重复工作设计：lint/type/import/format/test scaffold/doc sync。

  {
    name: 'lint_fixer',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'bash', 'run_tests'],
    expertisePrompt: `You are a lint fixer. Run the project linter, apply auto-fixes, and report remaining issues.

### Process
1. Run the linter: \`npx eslint --fix <file>\` or the project's configured linter
2. Read the output and fix any remaining violations by editing the file
3. Re-run the linter to confirm all issues are resolved
4. Report: fixed count, remaining count, file paths

### Rules
- Only fix lint/style violations — do NOT change logic or behavior
- Preserve existing indentation style
- If a violation requires a design decision, report it as an escalation`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 120_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'test_scaffolder',
    role: 'hands',
    allowedTools: ['read_file', 'write_file', 'grep', 'glob'],
    expertisePrompt: `You are a test scaffolder. Generate test file boilerplate from source interfaces and types.

### Process
1. Read the source file to understand exports, types, and function signatures
2. Locate existing test patterns in the project (grep for describe/it/test)
3. Write a test skeleton with: describe blocks, it placeholders, import statements, and basic happy-path assertions
4. Follow the project's test runner conventions (node:test + node:assert/strict for this project)

### Rules
- Generate SKELETON tests — cover function signatures and basic cases
- Do NOT implement complex test logic or mocks — the main agent will refine
- Match existing test file naming: \`__tests__/<name>.test.ts\`
- Include TODO comments for edge cases the main agent should fill in`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 120_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'import_organizer',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'bash'],
    expertisePrompt: `You are an import organizer. Sort imports, remove unused ones, and fix missing imports.

### Process
1. Read the file and analyze import statements
2. Sort imports: node builtins first, then external packages, then internal (relative) imports
3. Remove any unused imports (verify by checking usage in the file body)
4. If the file has TypeScript \`import type\` — keep type imports separate from value imports

### Rules
- Do NOT change any non-import code
- Preserve import aliases and named imports
- If unsure whether an import is used (side-effect imports), leave it`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 90_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'doc_syncer',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'grep', 'glob'],
    expertisePrompt: `You are a documentation syncer. Update JSDoc, README sections, and inline comments to match code changes.

### Process
1. Read the changed source files
2. Check if JSDoc comments are stale (parameter names, return types, descriptions)
3. Update JSDoc to match current function signatures
4. If a README or doc file references the changed API, update those references too

### Rules
- Only update documentation — do NOT change code behavior
- Keep JSDoc concise: @param, @returns, brief description
- Do NOT add redundant comments that just restate the code`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 120_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'type_fixer',
    role: 'hands',
    allowedTools: ['read_file', 'edit_file', 'bash'],
    expertisePrompt: `You are a type fixer. Run the TypeScript compiler and fix type errors.

### Process
1. Run: \`npx tsc --noEmit 2>&1\` to get all type errors
2. For each error, read the file and apply the minimal fix
3. Re-run tsc to confirm the fix resolved the error without introducing new ones

### Fix strategies (in preference order)
- Add missing type annotations
- Fix incorrect type narrowing
- Add missing properties to interfaces
- Use type assertions ONLY as last resort (document why)

### Rules
- Fix types only — do NOT change runtime behavior
- If a type error reveals a logic bug, report it as an escalation instead of fixing`,
    defaultMaxTokens: 8192,
    defaultTimeoutMs: 120_000,
    defaultKind: 'patch_proposal',
    tierLock: 'cheap',
    builtIn: true,
  },
  {
    name: 'format_checker',
    role: 'readonly',
    allowedTools: ['read_file', 'bash', 'grep'],
    expertisePrompt: `You are a format checker. Check code formatting and report violations without fixing them.

### Process
1. Run the project formatter in check mode (e.g., \`npx prettier --check <files>\`)
2. Parse the output to identify files with formatting violations
3. Report: file paths, violation types, line numbers if available

### Rules
- Do NOT modify any files — read-only inspection only
- Report results in structured format for the main agent to decide action`,
    defaultMaxTokens: 4096,
    defaultTimeoutMs: 60_000,
    defaultKind: 'review',
    tierLock: 'cheap',
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
  async loadFromDirectory(dir: string): Promise<{ loaded: string[]; errors: string[] }> {
    const loaded: string[] = []
    const errors: string[] = []
    try {
      const { readdirSync } = await import('node:fs')
      const { join } = await import('node:path')
      const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md')
      for (const file of files) {
        try {
          const { readFileSync } = await import('node:fs')
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

/**
 * P0 超时对齐：delegate 工具层超时 = max(阶梯, 各 profile 预算) + 宽限。
 *
 * worker 内部预算（work-order.budget.timeoutMs）回退顺序是
 * profile.defaultTimeoutMs → progressiveTimeout(sessionTurn)；外层工具超时
 * 必须覆盖同一来源并加 WORKER_EXIT_GRACE_MS，否则外层先开枪 reject 整个
 * delegate 调用，worker 的 blocked+partial-output 收尾路径永远走不到
 * （reviewer/planner 600s 预算曾因此在 180s 工具超时下完全死接线）。
 */
/** Default worker pool concurrency (mirrors bootstrap `maxWorkers: 3`). */
export const DEFAULT_DELEGATE_CONCURRENCY = 3

export function delegationToolTimeoutMs(
  sessionTurnCount: number | undefined,
  profiles: ReadonlyArray<string | undefined>,
  opts?: { taskCount?: number; maxWorkers?: number },
): number {
  let budget = progressiveTimeout(sessionTurnCount)
  for (const name of profiles) {
    const profileBudget = name ? profileRegistry.get(name)?.defaultTimeoutMs : undefined
    if (profileBudget && profileBudget > budget) budget = profileBudget
  }
  // P0: a bounded worker pool runs a batch in sequential waves. A 5-task batch
  // on a 3-worker pool needs ceil(5/3)=2 waves, so the outer tool timeout must
  // cover ALL waves of the slowest single-task budget — otherwise it pre-empts a
  // later wave with a hard reject and orphans those workers (no blocked/partial
  // result salvage). Scaling by waves (not total task count) avoids over-inflating
  // the ceiling while still never firing before the pool can drain.
  const taskCount = Math.max(1, Math.floor(opts?.taskCount ?? profiles.length ?? 1))
  const maxWorkers = Math.max(1, Math.floor(opts?.maxWorkers ?? DEFAULT_DELEGATE_CONCURRENCY))
  const waves = Math.max(1, Math.ceil(taskCount / maxWorkers))
  return budget * waves + WORKER_EXIT_GRACE_MS
}

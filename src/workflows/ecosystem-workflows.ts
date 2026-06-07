export interface WritingPlanPromptOptions {
  feature: string
  date?: Date
  planPath?: string
}

export interface PlanClosePromptOptions {
  filePath: string
  tasks: string
  apply: boolean
  verifiedCommands: string[]
  deliveryState?: 'GREEN' | 'YELLOW' | 'RED'
  note?: string
}

export interface WorkflowResolveResult {
  command: string
  prompt: string
}

export interface TeamWorkflowPromptOptions {
  mode: 'standard' | 'max'
  objective: string
}

const WRITING_PLAN_COMMANDS = new Set(['/plan', '/write-plan'])
const PLAN_CLOSE_COMMANDS = new Set(['/plan-close'])
const TEAM_COMMANDS = new Set(['/team'])

export function isWritingPlanCommand(command: string): boolean {
  return WRITING_PLAN_COMMANDS.has(command.toLowerCase())
}

export function parseSlashInput(input: string): { command: string; args: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^(\/\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return {
    command: match[1]!.toLowerCase(),
    args: (match[2] ?? '').trim(),
  }
}

export function slugifyFeatureName(feature: string): string {
  const slug = feature
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'implementation-plan'
}

const MAX_PLAN_SLUG_BYTES = 96

export function semanticPlanSlug(feature: string): string {
  const normalized = feature.trim()
  if (!normalized) return 'implementation-plan'

  const lower = normalized.toLowerCase()
  const longNarrative = normalized.length > 48 || Buffer.byteLength(normalized, 'utf8') > MAX_PLAN_SLUG_BYTES

  if (longNarrative) {
    if ((lower.includes('多会话') || lower.includes('多个会话') || lower.includes('单会话'))
      && (lower.includes('设计文档') || lower.includes('背景说明'))) {
      return '多会话并行开发设计文档'
    }
    if (lower.includes('plan') && (lower.includes('命名') || lower.includes('文件名'))) {
      return 'plan中文语义命名规则修复'
    }
  }

  return truncateSlugByUtf8Bytes(slugifyFeatureName(normalized), MAX_PLAN_SLUG_BYTES)
}

function truncateSlugByUtf8Bytes(slug: string, maxBytes: number): string {
  if (Buffer.byteLength(slug, 'utf8') <= maxBytes) return slug

  let result = ''
  for (const char of slug) {
    const next = `${result}${char}`
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break
    result = next
  }

  return result.replace(/-+$/g, '') || 'implementation-plan'
}

export function formatPlanDate(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function defaultPlanPath(feature: string, date: Date = new Date()): string {
  return `docs/superpowers/plans/${formatPlanDate(date)}-${semanticPlanSlug(feature)}.md`
}

export function buildWritingPlanPrompt(options: WritingPlanPromptOptions): string {
  const feature = options.feature.trim()
  const path = options.planPath ?? defaultPlanPath(feature, options.date)

  return `我正在使用 writing-plans 技能创建实现计划。加载 /skill writing-plans 查看完整方法论。

Create a comprehensive implementation plan for: ${feature}

Requirements:
- Do not write implementation code yet.
- Read relevant code deeply before proposing tasks — understand why each function to modify exists.
- For functions to delete or change behavior: grep callers, read commit messages, confirm edge cases are covered.
- Save the plan to \`${path}\` unless the user explicitly chooses another path.
- Plan filenames must be short business-semantic names. Do not mechanically use the entire \`/plan\` argument as the filename.
- Assume the implementing engineer has near-zero context about this codebase.
- Prefer DRY, YAGNI, TDD, small focused files, and frequent commits.

Required plan header:
\`\`\`markdown
# [功能名称] 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（\`- [ ]\`）语法来跟踪进度。

**目标：** [一句话描述要构建什么]

**架构：** [2-3 句话描述方案，关键设计决策及其理由]

**技术栈：** [关键技术/库]

---
\`\`\`

Required sections:
1. Scope check — if the feature spans independent subsystems, split into independent plans.
2. File structure — list every file to create or modify before defining tasks, with each file's responsibility.
3. Research endorsement（调研背书）— for each delete/behavior-change operation: list callers, existence reason, edge case risks.
4. Tasks — each task must be independently meaningful and testable, with precise file paths.
5. Verification — exact commands and expected results.
6. Self-check — spec coverage, placeholder scan, type/signature consistency.
7. Execution handoff — ask whether to execute via subagent-driven-development or inline executing-plans.

Task requirements:
- Each step should be one operation that takes roughly 2-5 minutes.
- Use TDD shape: write failing test → run and confirm failure → implement minimum code → run passing test → commit.
- Every task must list exact files:
  - 创建：\`exact/path/to/new-file.ts\`
  - 修改：\`exact/path/to/existing-file.ts:line-range\`
  - 测试：\`exact/path/to/test.test.ts\`
- Every code-changing step must include concrete code or an exact edit description precise enough to execute.
- Every command must include the expected result.
- Every commit step must use conventional commit format.
- No research endorsement on a delete operation → flagged as unverified assumption during execution.

Forbidden placeholders:
- TODO / TBD / 待定 / 后续实现 / 补充细节
- "添加适当的错误处理" without exact behavior
- "为上述代码编写测试" without concrete test code
- "类似任务 N"
- Any type, function, method, or property used before being defined somewhere in the plan

Before finishing, perform and report this self-check:
1. Spec coverage: map each requirement to one or more tasks; list and fix omissions.
2. Placeholder scan: remove every forbidden placeholder pattern.
3. Type consistency: verify names/signatures/paths are consistent across tasks.

End with this handoff:
"计划已完成并保存到 \`${path}\`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？"
`
}

const PLAN_CLOSE_FLAGS = new Set(['--apply', '--tasks', '--verified', '--delivery', '--note'])

function readUntilNextPlanCloseFlag(tokens: string[], start: number): { value: string; nextIndex: number } {
  const parts: string[] = []
  let i = start
  while (i < tokens.length && !PLAN_CLOSE_FLAGS.has(tokens[i]!)) {
    parts.push(tokens[i]!)
    i++
  }
  return { value: parts.join(' ').trim(), nextIndex: i }
}

export function parsePlanCloseArgs(args: string): PlanClosePromptOptions | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const filePath = tokens[0]
  if (!filePath || filePath.startsWith('--')) return null

  let tasks = ''
  let apply = false
  const verifiedCommands: string[] = []
  let deliveryState: PlanClosePromptOptions['deliveryState']
  let note: string | undefined

  let i = 1
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token === '--apply') {
      apply = true
      i++
      continue
    }
    if (token === '--tasks') {
      const value = tokens[i + 1]
      if (!value || value.startsWith('--')) return null
      tasks = value
      i += 2
      continue
    }
    if (token === '--verified') {
      const result = readUntilNextPlanCloseFlag(tokens, i + 1)
      if (!result.value) return null
      verifiedCommands.push(result.value)
      i = result.nextIndex
      continue
    }
    if (token === '--delivery') {
      const value = tokens[i + 1]
      if (value !== 'GREEN' && value !== 'YELLOW' && value !== 'RED') return null
      deliveryState = value
      i += 2
      continue
    }
    if (token === '--note') {
      const result = readUntilNextPlanCloseFlag(tokens, i + 1)
      if (!result.value) return null
      note = result.value
      i = result.nextIndex
      continue
    }
    return null
  }

  if (!tasks) return null
  return { filePath, tasks, apply, verifiedCommands, ...(deliveryState ? { deliveryState } : {}), ...(note ? { note } : {}) }
}

export function buildPlanClosePrompt(options: PlanClosePromptOptions): string {
  const lines = [
    'Use the plan_close tool to close an implementation plan.',
    '',
    'Tool call requirements:',
    `- file_path: ${options.filePath}`,
    `- tasks: ${options.tasks}`,
    `- apply: ${options.apply}`,
  ]

  if (options.verifiedCommands.length > 0) {
    lines.push('- verifiedCommands:')
    for (const command of options.verifiedCommands) lines.push(`  - ${command}`)
  }
  if (options.deliveryState) lines.push(`- deliveryState: ${options.deliveryState}`)
  if (options.note) lines.push(`- note: ${options.note}`)
  if (!options.apply) lines.push('', 'Preview only; do not write the file.')

  return lines.join('\n')
}

const PLAN_CLOSE_USAGE = 'Plan close usage: /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--apply] [--verified <command>] [--delivery GREEN|YELLOW|RED] [--note <text>]'

export const TEAM_USAGE = 'Team usage: /team <task|docs/superpowers/plans/file.md> or /team max <task>'

export function buildTeamWorkflowPrompt(options: TeamWorkflowPromptOptions): string {
  const objective = options.objective.trim()
  const modeLabel = options.mode === 'max' ? '/team max' : '/team'
  const planInstruction = options.mode === 'standard'
    ? '- If the input is a Markdown plan path, pass it as planPath to team_orchestrate and treat it as the task contract. Do not invent a new plan unless the file is missing or insufficient.'
    : '- Start with multi-perspective planning through team_orchestrate max mode: planner workers cover dependency analysis, risk audit, and adversarial blind-spot search before patcher execution.'

  return `我正在使用 ${modeLabel} 团队模式核心骨架执行任务。

User objective:
${objective}

Operating contract:
- User explicitly triggered team mode; do not ask whether to use it.
${planInstruction}
- Main controller (current session) owns integration, verification, and final deliver_task.
- MVP safety boundary: workers do NOT auto-commit/auto-merge. Treat worker output as patchSummary/diff evidence; integrate deliberately.
- patcher workers as 天梁 executors remain bounded helpers: objective must say "只执行本 task，不扩展范围，不重写计划".

Suggested phases:
1. Call the team_orchestrate tool with { mode: '${options.mode}', objective, planPath? } to deterministically parse/group and dispatch the first wave. It serializes same-file writes and validates dependencies for you.
2. Inspect the returned worker diffs/findings (these come from delegate_batch workers under the hood); integrate the changes into the working tree.
3. To run the next wave, call team_orchestrate again with the same args plus fromWave: <previous+1> AFTER integrating the prior wave's diffs.
4. On the final wave, team_orchestrate runs the review gate automatically (L1/L2/L3 by change scale); address any blocking findings.
5. Verify with evidence (targeted tests + npx tsc --noEmit), then deliver_task with a checklist.
`
}

export function parseTeamWorkflowArgs(args: string): TeamWorkflowPromptOptions | null {
  const trimmed = args.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower === 'max') return null
  if (lower.startsWith('max ')) {
    const objective = trimmed.slice(trimmed.match(/^max\s+/i)![0].length).trim()
    return objective ? { mode: 'max', objective } : null
  }
  return { mode: 'standard', objective: trimmed }
}

export function resolveEcosystemWorkflowInput(input: string, opts?: { date?: Date }): WorkflowResolveResult | null {
  const parsed = parseSlashInput(input)
  if (!parsed) return null

  if (TEAM_COMMANDS.has(parsed.command)) {
    const team = parseTeamWorkflowArgs(parsed.args)
    return { command: parsed.command, prompt: team ? buildTeamWorkflowPrompt(team) : TEAM_USAGE }
  }

  if (PLAN_CLOSE_COMMANDS.has(parsed.command)) {
    const planClose = parsePlanCloseArgs(parsed.args)
    return { command: parsed.command, prompt: planClose ? buildPlanClosePrompt(planClose) : PLAN_CLOSE_USAGE }
  }

  if (!isWritingPlanCommand(parsed.command)) return null
  if (!parsed.args) return null

  if (parsed.command === '/plan' && parsed.args.toLowerCase().startsWith('close ')) {
    const planClose = parsePlanCloseArgs(parsed.args.slice('close '.length))
    return { command: parsed.command, prompt: planClose ? buildPlanClosePrompt(planClose) : PLAN_CLOSE_USAGE }
  }

  return {
    command: parsed.command,
    prompt: buildWritingPlanPrompt({ feature: parsed.args, date: opts?.date }),
  }
}

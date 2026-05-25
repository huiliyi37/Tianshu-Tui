export interface WritingPlanPromptOptions {
  feature: string
  date?: Date
  planPath?: string
}

export interface WorkflowResolveResult {
  command: string
  prompt: string
}

const WRITING_PLAN_COMMANDS = new Set(['/plan', '/write-plan'])

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

  return `我正在使用 writing-plans 技能创建实现计划。

Create a comprehensive implementation plan for: ${feature}

Requirements:
- Do not write implementation code yet.
- Read relevant docs/specs/code first before proposing tasks.
- Save the plan to \`${path}\` unless the user explicitly chooses another path.
- Plan filenames must be short business-semantic names. Do not mechanically use the entire \`/plan\` argument as the filename. Summarize the business need into a concise Chinese or English title that stays within filesystem filename limits.
- Assume the implementing engineer has near-zero context about this codebase.
- Assume the engineer is experienced but may not design tests well.
- Prefer DRY, YAGNI, TDD, small focused files, and frequent commits.

Required plan header:
\`\`\`markdown
# [功能名称] 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（\`- [ ]\`）语法来跟踪进度。

**目标：** [一句话描述要构建什么]

**架构：** [2-3 句话描述方案]

**技术栈：** [关键技术/库]

---
\`\`\`

Required sections:
1. Scope check — if the feature spans independent subsystems, split it into independent plans.
2. File structure — list every file to create or modify before defining tasks, with each file's responsibility.
3. Tasks — each task must be independently meaningful and testable.
4. Verification — exact commands and expected results.
5. Self-check — spec coverage, placeholder scan, and type/signature consistency.
6. Execution handoff — ask whether to execute via subagent-driven development or inline executing-plans.

Task requirements:
- Each step should be one operation that takes roughly 2-5 minutes.
- Use TDD shape where applicable: write failing test → run it and confirm failure → implement minimum code → run passing test → commit.
- Every task must list exact files:
  - 创建：\`exact/path/to/new-file.ts\`
  - 修改：\`exact/path/to/existing-file.ts:line-range\`
  - 测试：\`exact/path/to/test.test.ts\`
- Every code-changing step must include concrete code or an exact edit description precise enough to execute.
- Every command must include the expected result.
- Every commit step must use conventional commit format.

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

export function resolveEcosystemWorkflowInput(input: string, opts?: { date?: Date }): WorkflowResolveResult | null {
  const parsed = parseSlashInput(input)
  if (!parsed) return null
  if (!isWritingPlanCommand(parsed.command)) return null
  if (!parsed.args) return null
  return {
    command: parsed.command,
    prompt: buildWritingPlanPrompt({ feature: parsed.args, date: opts?.date }),
  }
}

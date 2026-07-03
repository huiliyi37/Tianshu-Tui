import { classifyTaskDepth, type TaskContract } from '../context/task-contract.js'
import { DEFAULT_COUNCIL_SEATS } from '../agent/council/council-routing.js'

const BASE_TEMPLATE_PATH = 'docs/superpowers/plans/2026-06-28-plan-methodology-base.md'
const LIGHTWEIGHT_TEMPLATE_PATH = 'docs/superpowers/plans/2026-06-14-plan-methodology-lightweight.md'

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
  /**
   * prompt 指示模型直接调用、但位于 EXTENDED 层的工具。
   * 调用方（TUI 提交路径）负责在发起 run 前经 agent.enableTool() 挂载，
   * 保证 prompt 契约与工具可见性由同一个解析结果背书（会话 5158719d：
   * /council 指示调 council_convene 而门控把它摘了 → 模型被迫模拟议事会）。
   */
  requiredTools?: readonly string[]
}

export interface TeamWorkflowPromptOptions {
  mode: 'standard' | 'max'
  objective: string
}

export interface CouncilWorkflowPromptOptions {
  objective: string
  seats?: string[]
  rounds?: number
}

const WRITING_PLAN_COMMANDS = new Set(['/plan', '/write-plan'])
const PLAN_CLOSE_COMMANDS = new Set(['/plan-close'])
const TEAM_COMMANDS = new Set(['/team'])
const COUNCIL_COMMANDS = new Set(['/council'])

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

  // /plan 显式要求写实现计划，统一使用 Superpowers-based 基础模板。
  // 任务深度仅作为信息展示，不影响模板选择；安全/多 gate 任务由模型在基础模板上追加安全附录。
  const contract: TaskContract = {
    id: 'slash-plan',
    objective: feature,
    scope: { mentionedFiles: [] },
    constraints: [],
    successCriteria: [],
    status: 'planning',
    createdAtTurn: 0,
    updatedAtTurn: 0,
    isActionable: true,
  }
  const depth = classifyTaskDepth(contract)

  return `创建实现计划：${feature}

计划模板路由：任务深度 ${depth} → 基础模板（Superpowers writing-plans）
模板路径：${BASE_TEMPLATE_PATH}

本模板强制四条工程纪律，验收时必查：
1. **至少一张 Mermaid 图**：架构/数据流/状态图；若涉及安全/权限/沙箱/多 enforcement gate，追加安全附录并画双门对齐数据流图。
2. **TDD**：每个任务 RED → GREEN → 重构，测试断言行为而非 plumbing。
3. **探针先行**：写复杂实现/测试前先用 30 秒探针验证核心假设；临时探针交付前清理。
4. **瑶光反证**：用真实输入形状复现原问题（RED），再验证修复（GREEN）；不取信提交信息，取 exit code；方案 GREEN ≠ 落地 GREEN。

如果任务涉及安全/权限/沙箱/多 enforcement gate，在基础模板之上追加安全附录（安全不变量、触发路径清单、双门对齐数据流图）。
否则不需要写安全附录，按基础模板走完即可。

要求：
- 不要写实现代码。先深入读相关代码，理解每个要改的函数为什么存在。
- 对要删除或改行为的函数：grep 调用方、读 commit 记录、确认边界情况。
- 计划保存到 \`${path}\`，除非用户显式指定其他路径。
- 文件名用简短业务语义命名，不用 /plan 参数的全文做文件名。
- 假设执行工程师对此代码库零上下文。

计划头部格式：
\`\`\`markdown
# [功能名称] 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现。

**目标：** [一句话描述]

**架构：** [2-3 句话描述方案、关键决策及理由]

**技术栈：** [关键技术]

---
\`\`\`

任务要求：
- 每步应为一个独立可测的操作，约 2-5 分钟。
- TDD 形态：写失败测试 → 确认失败 → 最小实现 → 通过测试 → commit。
- 每个任务标注精确文件路径（创建/修改/测试）。
- 每个代码改动步骤提供具体代码或精确编辑描述。
- 每个命令标注预期结果，commit 用 conventional commit 格式。

禁用占位符：
- TODO / TBD / 待定 / 后续实现 / 补充细节
- "添加适当的错误处理"（无精确行为）
- "为上述代码编写测试"（无具体测试代码）
- 任何在计划中未定义的类型、函数、方法、属性

完成前自检：
1. 规格覆盖：每个需求映射到任务
2. 占位符扫描：移除全部禁用占位符
3. 类型一致性：名称/签名/路径跨任务一致

收尾：
"计划已完成并保存到 \`${path}\`。两种执行方式：
1. 子代理驱动（推荐）
2. 内联执行（使用 executing-plans）
选哪种方式？"
`
}

const PLAN_CLOSE_FLAGS = new Set(['--apply', '--preview', '--tasks', '--verified', '--delivery', '--note'])

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
  let apply = true
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
    if (token === '--preview') {
      apply = false
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

const PLAN_CLOSE_USAGE = 'Plan close usage: /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--preview] [--verified <command>] [--delivery GREEN|YELLOW|RED] [--note <text>]'

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
- Main controller (current session) owns the shared workspace, verification, and final deliver_task.
- Sharding rule (CORE): split the task HORIZONTALLY into orthogonal shards — like the S1-S16 / C1-C4 batches — where each shard is a complete, self-contained unit of work that ONE capable 天梁 flash owns end-to-end (implement + run tsc/lint/relevant tests to green in its own context). Do NOT split vertically by stage (no separate explore→patch→import→test→lint→type→verify role workers); a strong flash does the whole shard.
- Keep shards orthogonal: each shard touches a disjoint set of files/modules so they run in parallel. When two shards must touch the same file, set dependsOn so they serialize in order instead of racing. Aim for a few substantial shards, not many tiny工序碎片.
- Shared-worktree model: all flash workers write directly into the controller's single shared workspace (no per-worker worktree, no diff-merge step). The file-claim registry + same-file wave serialization prevent stomping. You review the AGGREGATE result with git diff/git status — you do NOT apply per-worker patches.
- patcher workers as 天梁 executors stay bounded: each shard objective must say "只执行本 task，不扩展范围，不重写计划".

Execution flow — follow these exact steps:

If the objective IS a Markdown plan file path (e.g. .rivet/knowledge/...md or docs/superpowers/plans/...md):
  1. Read the plan file and note its implementation checklist.
  2. Call plan_task with { objective, files: [planPath, plus the source files mentioned in the plan], execute: true }.
     plan_task auto-detects the plan file, turns its - [ ] checklist into self-contained patcher shards,
     and stores the plan so team_orchestrate can pick it up automatically.
  3. Workers write into the shared workspace. Review the aggregate changes (git diff/git status) — there is nothing to manually merge.
  4. If the output shows remaining waves, call team_orchestrate with { mode: 'standard', objective, fromWave: <next wave index> }.
     (No need to pass planJson — team_orchestrate reads it from the internal plan store.)

If the objective is a free-form task description (no plan file):
  1. Call plan_task with { objective, files: [the source files in scope], execute: true } to shard and dispatch the first wave.
     Listing scope files lets the planner cut orthogonal per-module shards instead of one monolith.
  2. Follow the same review-aggregate-then-continue pattern as above (team_orchestrate without planJson).

After ALL waves complete:
  1. Run targeted tests + npx tsc --noEmit.
  2. Call deliver_task with commit=true and a checklist covering each completed shard.
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

export const COUNCIL_USAGE = 'Council usage: /council <要会诊的计划/问题> [--seats id1,id2,...] [--rounds 1-2]'

export function parseCouncilWorkflowArgs(args: string): CouncilWorkflowPromptOptions | null {
  let objective = args.trim()
  if (!objective) return null

  // Parse --rounds flag first (before --seats truncates the objective).
  let rounds: number | undefined
  const roundsIdx = objective.search(/\s+--rounds\b/)
  if (roundsIdx >= 0) {
    const afterRounds = objective.slice(roundsIdx).replace(/^\s+--rounds\s*/, '')
    const tok = afterRounds.split(/[\s,]+/).find(s => s.length > 0)
    const n = tok ? Number.parseInt(tok, 10) : NaN
    objective = objective.slice(0, roundsIdx).trim()
    if (Number.isInteger(n) && n >= 1 && n <= 2) rounds = n
  }

  // Parse --seats flag: /council review the plan --seats tianquan,tianfu,tianji
  let seats: string[] | undefined
  const seatsIdx = objective.search(/\s+--seats\b/)
  if (seatsIdx >= 0) {
    const afterSeats = objective.slice(seatsIdx).replace(/^\s+--seats\s*/, '')
    // 过滤空 token：`--seats` 后仅空白/无值时不注入空 authority（否则 council_convene
    // 的 zod authority.min(1) 会拒整轮），降级回默认席。
    const seatTokens = afterSeats.split(/[\s,]+/).filter(s => s.length > 0 && !s.startsWith('--'))
    // 只要出现 --seats 就从 objective 剥离该段，避免噪音残留；有值才注入，无值降级默认席。
    objective = objective.slice(0, seatsIdx).trim()
    if (seatTokens.length > 0) seats = seatTokens
  }

  return objective ? { objective, ...(seats?.length ? { seats } : {}), ...(rounds ? { rounds } : {}) } : null
}

export function buildCouncilWorkflowPrompt(options: CouncilWorkflowPromptOptions): string {
  const objective = options.objective.trim()
  const hasCustomSeats = options.seats && options.seats.length > 0
  const defaultSeatsDesc = DEFAULT_COUNCIL_SEATS
    .map(s => `${s.authority} ${(s.charter ?? '').split('：')[0] || '顾问'}`)
    .join(' · ')
  const seatsNote = hasCustomSeats
    ? `席位用自定义配置: ${options.seats!.join(' · ')}`
    : `席位用默认配置(${defaultSeatsDesc}),无需自行指定 seats`
  const seatsParam = hasCustomSeats
    ? `, seats: [${options.seats!.map(s => `{ authority: "${s}" }`).join(', ')}]`
    : ''
  const roundsParam = options.rounds ? `, rounds: ${options.rounds}` : ''
  const roundDesc = options.rounds && options.rounds >= 2
    ? `这是多轮辩论(至多 ${options.rounds} 轮,仅在首轮出现冲突时才进第二轮反驳收敛)`
    : '这是单轮会诊'

  return `我正在使用 /council 发起星域议事会——多星域单轮对抗评审,只出计划不执行。

评审主题:
${objective}

执行契约:
- 用户已显式发起议事会;不要再问是否使用,直接调用 council_convene 工具。
- 调用 council_convene 工具,参数 { objective: "${objective}"${seatsParam}${roundsParam} };${seatsNote}。
- ${roundDesc}:扇出席位 → 确定性裁决 → 产出议事记录。绝不触发 team_orchestrate 或任何执行链。
- council_convene 返回的议事记录(席位贡献 / 裁决记录 / 冲突 / 最终任务表)直接原样呈现给用户,不要二次概括或改写。
- 返回的 content 末尾会内嵌一个 \`\`\`council-plan-json 代码块——由议事结论确定性生成的可执行 UnifiedPlan(含每项任务的 files 文件提示)。这是评审→执行的交接载体,不要展示给用户也不要改写其中任何字段。
- 议事会只负责出计划。产出议事记录后,主动询问用户是否执行(例如:"议事会评审完成。最终任务表有 N 项。需要执行吗?")。
- 用户确认执行后,提取 content 中 council-plan-json 块里的 JSON,原样作为 team_orchestrate 的 planJson 参数发起执行(模型交接,team 直接按 files 分波,无需重新解析)。用户不确认就此打住——议事会绝不自行触发 team_orchestrate。`
}

export function resolveEcosystemWorkflowInput(input: string, opts?: { date?: Date }): WorkflowResolveResult | null {
  const parsed = parseSlashInput(input)
  if (!parsed) return null

  if (TEAM_COMMANDS.has(parsed.command)) {
    const team = parseTeamWorkflowArgs(parsed.args)
    // team_orchestrate 在 EXTENDED 层——成功分支才声明（usage 无真实调用）。
    return team
      ? { command: parsed.command, prompt: buildTeamWorkflowPrompt(team), requiredTools: ['team_orchestrate'] }
      : { command: parsed.command, prompt: TEAM_USAGE }
  }

  if (COUNCIL_COMMANDS.has(parsed.command)) {
    const council = parseCouncilWorkflowArgs(parsed.args)
    // council_convene 出计划 + 用户确认后 team_orchestrate 交接执行（prompt L409 契约），
    // 两者都在 EXTENDED 层——成功分支才声明（usage 无真实调用）。
    return council
      ? { command: parsed.command, prompt: buildCouncilWorkflowPrompt(council), requiredTools: ['council_convene', 'team_orchestrate'] }
      : { command: parsed.command, prompt: COUNCIL_USAGE }
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

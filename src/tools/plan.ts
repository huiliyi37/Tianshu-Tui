/**
 * plan tool — unified plan lifecycle: submit for approval / close tasks.
 *
 * Merges the former plan_submit + plan_close into a single tool with a
 * discriminated action field. Reduces tool-count pressure on kernel budget
 * (≤25) and eliminates the "which plan tool do I use?" micro-decision.
 */

import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { writePlan, slugify, stripPlanStatusMarkers, insertPlanStatusMarker, insertPlanModelMarker, isDraftSlug, type PlanOption } from '../plan/plan-store.js'
import { checkPlanFactAnchors, formatAnchorDrifts, extractPlanAnchors } from '../plan/plan-fact-anchors.js'
import { inferModelTierFromName } from '../agent/model-tier-policy.js'
import { readFile, stat, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { relative } from 'node:path'
import { validatePath } from './path-validate.js'
import { closePlanMarkdown, type PlanCloseOptions, type PlanCloseResult } from '../plan/plan-close.js'

// ── plan_submit helpers ──

const warnedSlugs = new Set<string>()
// Fact-anchor gate: one-shot soft block per slug (mermaid-gate pattern). First
// submit with drifted anchors fails with the drift list; resubmitting the same
// title passes — the model judges false positives (illustrative paths) itself.
const anchorWarnedSlugs = new Set<string>()
// 规模门禁（层2）：大计划必须显式分波 + 每波验证命令。one-shot 软拦同款模式。
const scaleWarnedSlugs = new Set<string>()
// 瑶光反证门禁：计划必须带「反证/复现」章节——设计阶段发明的断言要在计划期
// 复现（回读代码、跑失败测试、派 adversarial_verifier），不是执行期才验。
// one-shot 软拦同款模式：首拦给出章节要求，同 title 重提交放行。
const falsificationWarnedSlugs = new Set<string>()
const FALSIFICATION_HEADING_RE = /^#{2,5}\s*.*(反证|复现|falsification|reproduction)/im
const MERMAID_FENCE = /```\s*mermaid/i
const MISSING_DIAGRAM_SKELETON = `\`\`\`mermaid
flowchart TD
    U(用户输入) --> R[[入口/路由]]
    R --> L{{LLM/核心逻辑}}
    R --> S[(存储/状态)]
    L --产出--> OUT([结果])
\`\`\``

// ── 计划规模门禁（层2）──
// 「flash 出大计划 → 一口气执行 → 重构丢功能」事故链的规模环节：任务数或涉及
// 文件数超阈值的计划，必须显式声明 wave 分波结构 + 每波验证命令，否则 one-shot
// 软拦（同事实锚点门禁模式：首次拦截给出改法，同 title 重提交放行）。

export const PLAN_SCALE_TASK_THRESHOLD = 8
export const PLAN_SCALE_FILE_THRESHOLD = 15

const WAVE_HEADING_RE = /^#{2,5}\s*.*(wave\s*\d|波\s*\d|第[一二三四五六七八九十\d]+波|分波)/im
const WAVE_VERIFY_RE = /(每波|波间|波后|per[- ]wave|wave 完成).{0,60}(验证|verify|verification|typecheck|测试)|验证命令/i

export interface PlanScaleCheck {
  taskCount: number
  fileCount: number
  oversized: boolean
  hasWaveStructure: boolean
}

/** 纯函数：估计计划规模（checkbox 任务数 + 引用文件数）并检测分波声明。 */
export function checkPlanScale(content: string): PlanScaleCheck {
  const taskCount = (content.match(/^\s*[-*]\s*\[[ xX]\]/gm) ?? []).length
  const fileCount = extractPlanAnchors(content).length
  const oversized = taskCount > PLAN_SCALE_TASK_THRESHOLD || fileCount > PLAN_SCALE_FILE_THRESHOLD
  const hasWaveStructure = WAVE_HEADING_RE.test(content) && WAVE_VERIFY_RE.test(content)
  return { taskCount, fileCount, oversized, hasWaveStructure }
}

// Placeholder detection — reject skeletal plans before they are persisted.
const PLACEHOLDER_RE = /\b(TODO|FIXME|TBD|XXX|HACK|placeholder|占位符|待补充|待完善|待填写|待实现|稍后补充|略)\b/gi
const ONLY_DOTS_RE = /^(\.{3,}|…+|-\s*\.{3,})\s*$/m

/**
 * A section is "empty" when its heading is followed (across blank lines only)
 * by a heading at the SAME or SHALLOWER level. A deeper heading means the
 * section's body is structured into subsections — the normal markdown pattern
 * `## 实现` → `### 任务 1`. The old regex flagged that as empty and wedged
 * plan submit in an unfixable rejection loop (session 91840816: a fully
 * fleshed-out draft rejected twice because its parent headings had ###
 * children).
 */
function hasEmptySection(content: string): boolean {
  const lines = content.split('\n')
  let openHeadingLevel: number | null = null
  for (const line of lines) {
    const m = /^(#{2,6})\s+\S/.exec(line)
    if (m) {
      const level = m[1]!.length
      if (openHeadingLevel !== null && level <= openHeadingLevel) return true
      openHeadingLevel = level
      continue
    }
    if (line.trim().length > 0) openHeadingLevel = null
  }
  return false
}

interface PlaceholderCheckResult {
  ok: boolean
  reason?: string
}

const RESERVED_OPTION_LABELS = new Set(
  ['Approve', 'Reject', 'Reject and Exit', 'Revise'].map(normalizeOptionLabel),
)

function normalizeOptionLabel(label: string): string {
  return label.trim().toLowerCase()
}

function parseSubmitOptions(raw: unknown): PlanOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const options: PlanOption[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const label = (item as { label?: unknown }).label
    const description = (item as { description?: unknown }).description
    if (typeof label !== 'string' || label.trim().length === 0) continue
    if (typeof description !== 'string') continue
    options.push({ label: label.trim(), description: description.trim() })
  }
  if (options.length === 0) return undefined
  if (options.length > 3) {
    throw new Error('At most 3 options are allowed')
  }
  const labels = new Set<string>()
  for (const option of options) {
    const key = normalizeOptionLabel(option.label)
    if (labels.has(key)) throw new Error('Option labels must be unique')
    if (RESERVED_OPTION_LABELS.has(key)) throw new Error('Option labels must not use reserved approval labels')
    labels.add(key)
  }
  return options
}

/**
 * Gate a plan's content at the approval boundary (kimi-code borrow: empty-plan
 * hard-fail). `/plan-approve` and the plan-picker previously trusted that submit
 * had validated — approving a stale draft or gutted file slipped through. Reuses
 * the same empty/placeholder checks as submit. Pure + exported for reuse in TUI.
 */
export function validatePlanContentForApproval(content: string): PlaceholderCheckResult {
  const body = stripPlanStatusMarkers(content).trim()
  if (!body) {
    return { ok: false, reason: '计划文件为空——批准前请先写入完整设计（或用 /plan-reject 让 agent 补全）。' }
  }
  return checkPlanForPlaceholders(body)
}

function checkPlanForPlaceholders(content: string): PlaceholderCheckResult {
  const placeholderHits = content.match(PLACEHOLDER_RE)
  if (placeholderHits && placeholderHits.length >= 3) {
    const unique = [...new Set(placeholderHits.map(s => s.toLowerCase()))]
    return {
      ok: false,
      reason: `计划包含过多占位符：${unique.join(', ')}。请继续补充具体设计后再提交。`,
    }
  }

  if (hasEmptySection(content)) {
    return {
      ok: false,
      reason: '检测到只有标题、没有正文的空章节。请为每个章节补充具体分析和方案后再提交。',
    }
  }

  if (ONLY_DOTS_RE.test(content)) {
    return {
      ok: false,
      reason: '检测到仅含省略号的占位段落。请替换为具体设计内容后再提交。',
    }
  }

  return { ok: true }
}

// ── plan_close helpers ──

function isDeliveryState(value: unknown): value is PlanCloseOptions['deliveryState'] {
  return value === 'GREEN' || value === 'YELLOW' || value === 'RED'
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return strings.length > 0 ? strings : undefined
}

type GateState = 'GREEN' | 'YELLOW' | 'RED'

/** Delivery severity ordering: RED > YELLOW > GREEN. Returns the worse of two. */
function worseState(a: GateState, b: GateState): GateState {
  const rank: Record<GateState, number> = { GREEN: 0, YELLOW: 1, RED: 2 }
  return rank[a] >= rank[b] ? a : b
}

function closureAction(result: PlanCloseResult): 'insert' | 'update' | 'unchanged' {
  if (result.closureInserted) return 'insert'
  if (result.closureUpdated) return 'update'
  return 'unchanged'
}

function formatChanges(result: PlanCloseResult): string[] {
  if (result.changes.length === 0) return ['  (none)']
  return result.changes.map(change =>
    `  - Task ${change.taskNumber}: ${change.changedCheckboxCount}/${change.checkboxCount} checkbox(es) updated`,
  )
}

// ── unified tool ──

export const PLAN_TOOL: Tool = {
  definition: {
    name: 'plan',
    description: `Unified plan lifecycle tool — submit a plan for approval, or close completed tasks.

### Plan file status
\`.rivet/plans/*.md\` files carry a status marker: \`> **Status: APPROVED/REJECTED/EXECUTED**\`. When scanning existing plans:
- **REJECTED** plans are dismissed by the user — do NOT re-submit, re-propose, or remind the user about them unless explicitly asked.
- **EXECUTED** plans are done — reference them for context but don't re-process.
- **APPROVED** plans are in progress — continue execution.
- Only **submitted** (no status marker) plans await user action.

### Action: submit
Submit a completed implementation plan for user approval. The plan is persisted to \`.rivet/plans/<slug>.md\`.

The \`plan\` field must be a concrete, ready-to-implement design document. Do NOT submit outlines, skeletons, or placeholder text such as "TODO", "FIXME", "TBD", "待补充", or section headers with no content. Plans that are mostly placeholders will be rejected and you will be asked to continue planning.

Omit \`plan\` to submit from the active plan file (plan mode draft). Write the plan incrementally with write_file/edit_file first.

When the plan contains multiple approaches, pass \`options\` (up to 3) so the user can choose at approval time.

### Action: close
Preview or apply implementation plan closure updates. Defaults to preview mode (no writes). Set apply=true to update the plan file.

Only supports Markdown files under docs/superpowers/plans/ or .rivet/plans/.

### Action: enter_mode
Enter plan mode yourself (write tools become blocked; a plan draft file is created). Use ONLY after the user explicitly agreed to plan first (e.g. answered "进入计划模式" to your ask_user_question). Idempotent when already planning. Exiting plan mode remains user-only — submit the plan and let the user approve.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['submit', 'close', 'enter_mode'],
          description: 'submit: create a plan for user approval. close: close completed plan tasks. enter_mode: enter plan mode (after user confirmation).',
        },
        // ── submit fields ──
        title: { type: 'string', description: '[submit] Short descriptive plan title (used for file slug)' },
        plan: { type: 'string', description: '[submit] Full plan in Markdown. Omit to read from active plan file in plan mode.' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short name for this approach (append "(Recommended)" if preferred)' },
              description: { type: 'string', description: 'Brief summary of trade-offs' },
            },
            required: ['label', 'description'],
          },
          description: '[submit] When the plan has 2-3 distinct approaches, list them for user selection at approval.',
        },
        // ── close fields ──
        file_path: { type: 'string', description: '[close] Path to the plan Markdown file under docs/superpowers/plans/' },
        tasks: { type: 'string', description: '[close] Task selection such as 1, 1-3, 1,3-4, or all' },
        apply: { type: 'boolean', description: '[close] Write changes to the file (default false preview mode)' },
        verifiedCommands: {
          type: 'array', items: { type: 'string' },
          description: '[close] Verification commands to include in the closure summary',
        },
        deliveryState: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED'], description: '[close] Delivery gate state' },
        note: { type: 'string', description: '[close] Optional closure note' },
        updateClosure: { type: 'boolean', description: '[close] Whether to upsert execution status and closure (default true)' },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const action = params.input.action

    if (action === 'submit') {
      return planSubmitExecute(params)
    }
    if (action === 'close') {
      return planCloseExecute(params)
    }
    if (action === 'enter_mode') {
      return planEnterModeExecute(params)
    }
    return { content: `Error: unknown action "${action}". Use "submit", "close" or "enter_mode".`, isError: true }
  },

  requiresApproval(): boolean {
    // Plan closure only touches plan markdown (checkboxes + closure section) under
    // docs/superpowers/plans/ or .rivet/plans/. It is path-validated and reversible,
    // so we skip the approval gate to avoid interrupting the automated close flow.
    return false
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

// ── enter_mode implementation ──

/**
 * 模型自主进入 plan mode（主动 Plan Mode 建议链路的确认后动作）。
 * 只进不出：退出计划模式仍归用户（approve/toggle），避免模型自行逃出只读沙箱。
 * worker/非 agent 上下文没有 enterPlanMode ref → fail-closed 报错。
 */
function planEnterModeExecute(params: ToolCallParams): ToolResult {
  if (!params.enterPlanMode) {
    return { content: 'Error: enter_mode is not available in this context (sub-agents cannot switch the primary agent into plan mode).', isError: true }
  }
  try {
    const { activePlanFilePath, alreadyPlanning } = params.enterPlanMode()
    if (alreadyPlanning) {
      return {
        content: `Already in plan mode.${activePlanFilePath ? ` Active plan draft: ${activePlanFilePath}` : ''}`,
      }
    }
    return {
      content: [
        'Entered plan mode — write tools are now blocked except the plan draft.',
        activePlanFilePath ? `Plan draft: ${activePlanFilePath}` : '',
        '',
        'Next steps:',
        '1. Research first: for multi-module tasks, dispatch 2-4 read-only code_scout workers in parallel via delegate_batch (split by module/file domain), then synthesize the findings.',
        '2. Write the plan incrementally to the draft file with write_file/edit_file.',
        '3. 瑶光反证 (required section, submit-gated): reproduce key claims AT PLAN TIME — re-read cited code AFTER the design is drafted, run_tests for RED evidence on bugfixes, or delegate profile=adversarial_verifier authority=yaoguang. Unreproducible inferences go in as 待验证假设, not conclusions.',
        '4. Submit with plan action=submit for user approval. Exiting plan mode is user-only.',
      ].filter(Boolean).join('\n'),
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── submit implementation ──

async function planSubmitExecute(params: ToolCallParams): Promise<ToolResult> {
  const title = params.input.title
  let planContent: unknown = params.input.plan
  let submitOptions: PlanOption[] | undefined
  try {
    submitOptions = parseSubmitOptions(params.input.options)
  } catch (err) {
    return {
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }

  if (typeof title !== 'string' || !title.trim()) {
    return { content: 'Error: title is required', isError: true }
  }

  let submittedFromDraft: string | null = null
  if (typeof planContent !== 'string' || !planContent.trim()) {
    const draftPath = params.activePlanFilePath
    if (!draftPath) {
      return {
        content: 'Error: plan is required when no active plan file is set. Write to the plan file first or pass plan content.',
        isError: true,
      }
    }
    let draftText: string
    try {
      draftText = await readFile(join(params.cwd, draftPath), 'utf-8')
    } catch (err) {
      return {
        content: `Error reading active plan file (${draftPath}): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
    if (!draftText.trim()) {
      return {
        content: `Error: active plan file is empty (${draftPath}). Write your plan there first, then submit.`,
        isError: true,
      }
    }
    planContent = draftText
    submittedFromDraft = draftPath
  }

  // 剥离历史 approve/reject 状态标记 — 驳回修订后从活动计划文件整读重提交时,
  // 残留的 "> **Status: REJECTED**" 会让新提交被误判为 rejected,从待批准列表消失。
  const planBody = stripPlanStatusMarkers(planContent as string)

  const slug = slugify(title)

  if (!MERMAID_FENCE.test(planBody) && !warnedSlugs.has(slug)) {
    warnedSlugs.add(slug)
    return {
      content: [
        `⚠️ Plan not yet saved — it has no Mermaid diagram.`,
        '',
        `A good plan visualizes architecture or data flow. Add one diagram (even just the core 3-5 nodes) and resubmit. Copy this skeleton and replace the node text:`,
        '',
        MISSING_DIAGRAM_SKELETON,
        '',
        `Shapes: (rounded)=input/user · [[subroutine]]=agent · {{hexagon}}=LLM · [(cylinder)]=store · {rhombus}=decision. Edges: --> read · ==> write · -.-> async/event.`,
        '',
        `If a diagram is genuinely unnecessary for this task, resubmit \`plan\` as-is (same title) and it will be saved.`,
      ].join('\n'),
      isError: true,
    }
  }

  const fullContent = planBody.trim().startsWith('# ')
    ? `${planBody.trim()}\n`
    : `# ${title.trim()}\n\n${planBody.trim()}\n`

  const placeholderCheck = checkPlanForPlaceholders(fullContent)
  if (!placeholderCheck.ok) {
    return {
      content: [
        `⚠️ Plan not yet saved — ${placeholderCheck.reason}`,
        '',
        '请继续完善计划：补充根因分析、每个文件的具体改动（diff 或伪代码）、设计决策对比表、验证步骤等。',
      ].join('\n'),
      isError: true,
    }
  }

  // 瑶光反证门禁：计划期复现，不是执行期才验。快思考事故（49fd1dfd 一族）的
  // 根源是设计阶段发明的断言（"deltaStable 会生效""块名是 cognitive-mirror"）
  // 从未回到代码/运行时复现。one-shot 软拦：首拦列出章节要求；同 title 重提放行
  // （模型自判不适用场景，永不死锁——91840816 教训）。
  if (!FALSIFICATION_HEADING_RE.test(fullContent) && !falsificationWarnedSlugs.has(slug)) {
    falsificationWarnedSlugs.add(slug)
    return {
      content: [
        `⚠️ Plan not yet saved — 计划缺少「瑶光反证」章节（标题含"反证"或"复现"）。`,
        '',
        '设计阶段发明的断言最容易错——出计划的同时就要复现，不能等执行期。请补充该章节，覆盖：',
        '- **关键断言清单**：方案依据的每条代码行为断言 + 计划期证据（设计定稿后的 read/grep 回读到 file:line、run_tests 输出、或 adversarial_verifier 复现结论）',
        '- **原缺陷复现**（bugfix 类计划）：复现命令 + 观察到的 RED 输出——绿非证明，复现即证',
        '- **待验证假设**：计划期无法复现的推论，显式标注并写明执行期第一步如何验证',
        '',
        '可用工具：plan mode 下 run_tests 可直接跑（拿 RED 证据）；`delegate_task profile=adversarial_verifier authority=yaoguang` 可派复现专员。',
        '',
        '补充后重新提交（同一 title）。若该计划确实无可复现断言（纯新增、零行为假设），可原样重提放行。',
      ].join('\n'),
      isError: true,
    }
  }

  // Fact-anchor verification: file paths / line anchors cited by the plan must
  // match the current working tree. One-shot soft block — first offense returns
  // the drift list, resubmitting the same title passes (with drift note kept).
  let anchorDriftNote = ''
  try {
    const anchorReport = await checkPlanFactAnchors(fullContent, params.cwd)
    if (anchorReport.drifts.length > 0) {
      if (!anchorWarnedSlugs.has(slug)) {
        anchorWarnedSlugs.add(slug)
        return {
          content: [
            `⚠️ Plan not yet saved — ${anchorReport.drifts.length} 个事实锚点与当前项目不符：`,
            '',
            formatAnchorDrifts(anchorReport.drifts),
            '',
            '文档和历史计划描述的是写下时的状态，不是现状——用 read/grep/glob 对当前源码逐条核实后修正引用；确认是有意新建的文件请在同一行标注「新增」。核实完成后重新提交（同一 title），若你判断某条是误报（示例路径等）可原样重提。',
          ].join('\n'),
          isError: true,
        }
      }
      anchorDriftNote = `\n⚠ 锚点残留提示：${anchorReport.drifts.length} 个引用仍与当前工作区不符（已放行）。执行时以现实为准并在交付报告留痕。`
    }
  } catch {
    // Anchor verification is best-effort — never let the guard itself block a submit.
  }

  // 规模门禁：大计划（任务 > 8 或文件 > 15）必须显式分波 + 每波验证命令。
  // one-shot 软拦——首拦给出改法，同 title 重提交放行（带留痕 note）。
  let scaleNote = ''
  try {
    const scale = checkPlanScale(fullContent)
    if (scale.oversized && !scale.hasWaveStructure) {
      if (!scaleWarnedSlugs.has(slug)) {
        scaleWarnedSlugs.add(slug)
        return {
          content: [
            `⚠️ Plan not yet saved — 计划规模超阈值（任务 ${scale.taskCount} 个 / 涉及文件 ${scale.fileCount} 个，阈值 ${PLAN_SCALE_TASK_THRESHOLD}/${PLAN_SCALE_FILE_THRESHOLD}），但没有分波结构。`,
            '',
            '大计划一口气执行是重构事故的高发形态。请在计划中补充「分波执行」章节：',
            '- 用 `### Wave 1 / Wave 2 / …` 标题把任务切成 2-4 个可独立验证的波次',
            '- 每波末尾声明验证命令（typecheck / 测试），波间硬门禁会真实执行它们',
            '- 波的边界放在功能可自证的位置（一波结束 = 可编译可测试）',
            '',
            '补充后重新提交（同一 title）。若你判断该计划确实不可分波（如单一原子迁移），可原样重提放行。',
          ].join('\n'),
          isError: true,
        }
      }
      scaleNote = `\n⚠ 规模留痕：计划超阈值（任务 ${scale.taskCount} / 文件 ${scale.fileCount}）且无分波结构（已放行）。执行时建议手动分批 + 阶段性验证。`
    }
  } catch {
    // Scale gate is best-effort — never let the guard itself block a submit.
  }

  // 产出模型留痕：记录本计划由哪个模型写出（H1 前标记行，PlanDocument 解析为
  // model/modelTier）。低阶模型产出的计划在审批面（/plan-approve + 桌面 PlanPanel）
  // 显示复核警告——掐断「flash 出大计划无人知晓」的事故链源头。
  const producerModel = params.sessionModel?.trim()
  const producerTier = producerModel ? inferModelTierFromName(producerModel) : null
  const contentToPersist = producerModel
    ? insertPlanModelMarker(fullContent, producerModel, producerTier)
    : fullContent
  const cheapModelNote = producerTier === 'cheap'
    ? `\n⚠ 本计划由低阶模型（${producerModel}）产出，审批面会提示用户复核。`
    : ''

  try {
    const relativePath = await writePlan(params.cwd, slug, contentToPersist, submitOptions)
    // Draft recycling: the content now lives in the canonical plan file — remove
    // the plan-mode working draft so it never lingers as an orphan (and never
    // duplicates the submitted plan). Best-effort: a failed cleanup must not
    // fail the submit. Only draft-shaped files are removed; a revision session
    // whose active plan file IS the canonical file is left untouched.
    if (submittedFromDraft && isDraftSlug(basename(submittedFromDraft, '.md'))) {
      await rm(join(params.cwd, submittedFromDraft), { force: true }).catch(() => {})
    }
    const optionsHint = submitOptions && submitOptions.length >= 2
      ? `\nOptions recorded (${submitOptions.length}). User can choose at approval: ${submitOptions.map(o => `\`${o.label}\``).join(', ')}`
      : ''
    return {
      content: [
        `✅ Plan submitted: **${title.trim()}**`,
        `File: \`${relativePath}\``,
        `Slug: \`${slug}\``,
        optionsHint,
        anchorDriftNote,
        scaleNote,
        cheapModelNote,
        '',
        `The user will review and respond with:`,
        `- \`/plan-approve ${slug}\` — approve and start execution`,
        `- \`/plan-approve ${slug} <option-label>\` — approve a specific approach`,
        `- \`/plan-reject ${slug} <feedback>\` — reject with feedback for revision`,
        `- \`/plan-list\` — list all plans`,
        '',
        `**Wait here — do not proceed until the user approves.**`,
      ].filter(Boolean).join('\n'),
    }
  } catch (err) {
    return {
      content: `Error writing plan: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}

// ── close implementation ──

async function planCloseExecute(params: ToolCallParams): Promise<ToolResult> {
  const rawPath = params.input.file_path
  const tasks = params.input.tasks
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { content: 'Error: file_path is required', isError: true }
  }
  if (typeof tasks !== 'string' || !tasks.trim()) {
    return { content: 'Error: tasks is required', isError: true }
  }

  let filePath: string
  try {
    filePath = validatePath(params.cwd, rawPath)
  } catch {
    return { content: 'Error: Path escapes project directory', isError: true }
  }

  const relativePath = relative(params.cwd, filePath).replaceAll('\\', '/')
  const inSuperpowersPlans = relativePath.startsWith('docs/superpowers/plans/') && relativePath.endsWith('.md')
  const inRivetPlans = relativePath.startsWith('.rivet/plans/') && relativePath.endsWith('.md')
  if (!inSuperpowersPlans && !inRivetPlans) {
    return { content: `Error: plan close only supports docs/superpowers/plans/ or .rivet/plans/: ${relativePath}`, isError: true }
  }
  try { await stat(filePath) } catch {
    return { content: `Error: Plan file not found: ${filePath}`, isError: true }
  }

  const deliveryState = params.input.deliveryState
  if (deliveryState !== undefined && !isDeliveryState(deliveryState)) {
    return { content: 'Error: deliveryState must be GREEN, YELLOW, or RED', isError: true }
  }

  const claimedCommands = asStringArray(params.input.verifiedCommands)

  // ── 防伪闭环: evidence-gated closure ──
  // When the session wired a real delivery gate, closure state and verified
  // commands are driven by actual evidence, not the model's self-report.
  // Degrades gracefully to legacy (trust-claimed) behavior when absent.
  let effectiveState: GateState | undefined = deliveryState
  let effectiveCommands = claimedCommands
  let mismatchNote: string | undefined
  let realGreen = false
  let gateBlock: { reason: string; nextStep?: string } | undefined

  if (params.assessDelivery) {
    const real = params.assessDelivery(params.sessionModifiedFiles)
    const summary = params.getVerificationEvidence?.()
    const claimed: GateState = deliveryState ?? 'GREEN'

    if (claimed === 'GREEN' && real.state === 'RED') {
      gateBlock = {
        reason: real.blockingReason ?? real.reason ?? 'Delivery gate is RED — owned files modified but unverified.',
        nextStep: real.shortestNextStep,
      }
    } else {
      effectiveState = worseState(claimed, real.state)
      realGreen = effectiveState === 'GREEN'
      const hasRealVerification = real.verificationCount > 0 || (summary?.verified ?? 0) > 0
      if (!hasRealVerification) {
        if (claimedCommands && claimedCommands.length > 0) {
          mismatchNote = `声明了 ${claimedCommands.length} 条验证命令，但会话证据中无对应验证记录（已按真实证据记为空）。`
        }
        effectiveCommands = undefined
      } else if (!effectiveCommands && real.latestVerificationTotals?.command) {
        effectiveCommands = [real.latestVerificationTotals.command]
      }
    }
  }

  // Anti-forgery block only fires on write (apply=true); preview still renders.
  if (gateBlock && params.input.apply === true) {
    return {
      content: [
        `Plan close blocked: claimed GREEN but the delivery gate is RED.`,
        gateBlock.reason,
        gateBlock.nextStep ? `Next: ${gateBlock.nextStep}` : '',
        '',
        `Run the real verification (typecheck/tests) then re-close, or close honestly with deliveryState=RED/YELLOW as a progress checkpoint.`,
      ].filter(Boolean).join('\n'),
      isError: true,
    }
  }

  const combinedNote = [
    typeof params.input.note === 'string' ? params.input.note : undefined,
    mismatchNote,
  ].filter(Boolean).join(' ') || undefined

  try {
    const result = closePlanMarkdown(await readFile(filePath, 'utf-8'), {
      tasks,
      verifiedCommands: effectiveCommands,
      deliveryState: effectiveState,
      note: combinedNote,
      updateClosure: typeof params.input.updateClosure === 'boolean' ? params.input.updateClosure : undefined,
    })

    const action = closureAction(result)
    if (params.input.apply === true) {
      // EXECUTED status marker is written only on gate-backed GREEN.
      const contentToWrite = realGreen ? insertPlanStatusMarker(result.content, 'EXECUTED') : result.content
      await writeFileAtomicAsync(filePath, contentToWrite)
      if (params.onPlanClosed) {
        params.onPlanClosed({
          planFile: relativePath,
          tasks,
          deliveryState: effectiveState ?? 'GREEN',
          totalChangedCheckboxes: result.totalChangedCheckboxes,
        })
      }

      return {
        content: [
          `Plan closed: ${relativePath}`,
          `Tasks: ${tasks}`,
          `Checkboxes updated: ${result.totalChangedCheckboxes}`,
          `Closure: ${action}`,
          effectiveState ? `Delivery: ${effectiveState}${realGreen ? ' (marked EXECUTED)' : ''}` : '',
          mismatchNote ? `Evidence: ${mismatchNote}` : '',
        ].filter(Boolean).join('\n'),
      }
    }

    return {
      content: [
        `Plan close preview: ${relativePath}`,
        `Tasks: ${tasks}`,
        `Checkboxes to update: ${result.totalChangedCheckboxes}`,
        `Closure: ${action}`,
        effectiveState ? `Delivery: ${effectiveState}` : '',
        gateBlock ? `⚠ Gate: claimed GREEN but real gate is RED — apply=true will be blocked.` : '',
        mismatchNote ? `Evidence: ${mismatchNote}` : '',
        '',
        'Changes:',
        ...formatChanges(result),
        '',
        'No files changed. Re-run with apply=true to write the plan closure.',
      ].filter(Boolean).join('\n'),
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── Backward-compat exports: callers in default-registry and elsewhere expect
//    the old split-tool constants. Both resolve to the same PLAN_TOOL instance.
export const PLAN_SUBMIT_TOOL = PLAN_TOOL
export const PLAN_CLOSE_TOOL = PLAN_TOOL

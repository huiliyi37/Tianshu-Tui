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
import { detectPointerPlaceholder, POINTER_GUARD_ERROR_MARKER, resolveIdempotentPointer } from './pointer-guard.js'
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
// 需求提炼门禁：计划开头必须有用用户原话提炼需求的章节——防止计划直接跳进
// 方案而误解意图。one-shot 软拦同款模式。
const requirementWarnedSlugs = new Set<string>()
const REQUIREMENT_DISTILL_HEADING_RE = /^#{2,5}\s*.*(需求提炼|需求理解|requirements?(\s+(distillation|summary))?)/im
const MERMAID_FENCE = /```\s*mermaid/i
const MISSING_DIAGRAM_SKELETON = `\`\`\`mermaid
flowchart TD
    U(用户输入) --> R[[入口/路由]]
    R --> L{{LLM/核心逻辑}}
    R --> S[(存储/状态)]
    L --产出--> OUT([结果])
\`\`\``

// ── 计划规模门禁（层2）──
// 任务数或涉及文件数超阈值的计划，必须显式声明 wave 分波结构 + 每波验证命令，
// 否则 one-shot 软拦（同事实锚点门禁模式：首次拦截给出改法，同 title 重提交放行）。

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
 * `## 实现` → `### 任务 1`.
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
    description: `统一计划生命周期工具——提交计划供用户审批，或关闭已完成任务。

### 计划文件状态
\`.rivet/plans/*.md\` 文件带状态标记行：\`> **Status: APPROVED/REJECTED/EXECUTED**\`。扫描既有计划时：
- **REJECTED** 计划已被用户否决——不要重新提交、重新提议或提醒用户，除非用户明确要求。
- **EXECUTED** 计划已完成——可作上下文参考，不要重复处理。
- **APPROVED** 计划执行中——继续执行。
- 只有**已提交待批**（无状态标记）的计划等待用户操作。

### Action: submit
提交一份完成的实现计划供用户审批。计划持久化到 \`.rivet/plans/<slug>.md\`。

\`plan\` 字段必须是具体、可直接实施的设计文档，不是大纲或骨架。

提交门禁——提交前必须自检六项：标题级「需求提炼」章节（H1 之后，用户原话提炼目标 + 非目标）、至少一张 mermaid 图、标题级「反证/复现」章节、大计划（checkbox 任务 >8 或引用文件 >15）的 \`### Wave N\` 分波 + 每波验证命令、无占位符簇/空章节（硬门禁，重提不豁免）、file:line 锚点与当前工作树一致。未达标项会在一次驳回中逐条列出，补完后用相同 title 重提（每项软门禁只拦一次）。完整标准与 mermaid 骨架见 plan mode 的 \`<plan-mode>\` 块。
绝不要把消息历史里的 "[plan persisted to …]" 指针当作 \`plan\` 传入（会被驳回）——那是计划已成功保存后的正常截断显示，省略 \`plan\` 字段即可从计划文件读取。

省略 \`plan\` 字段则从活动计划文件（plan mode 草稿）提交。先用 write_file/edit_file 把计划增量写入草稿。

计划包含多个方案时，传 \`options\`（最多 3 个）供用户在审批时选择。

### Action: close
预览或应用计划闭环更新。默认预览模式（不写盘）。设 apply=true 才写回计划文件。

仅支持 docs/superpowers/plans/ 或 .rivet/plans/ 下的 Markdown 文件。

### Action: enter_mode
自主进入计划模式，先规划再动手（写工具将被禁用；会创建计划草稿文件）。命中以下任一情况时主动使用：新功能实现、多文件（>2-3 个）改动、存在多个有效方案、架构决策、需求不清需要先探索。不要用于：单点小修、用户已给出详细逐步指令的任务、纯研究/问答。进入**无需用户确认**——用户的审批门在计划提交时，不在进入时。已在规划中时重复调用幂等。用户通过会话内审批卡（桌面端）或 /plan-approve（TUI）批准提交的计划；全部任务完成后 \`plan close\` apply=true 会把计划标记为 EXECUTED。

### Action: exit_mode
退出计划模式、解除写锁。不修改计划文件（不标记 EXECUTED、不勾选 checkbox）。审批即自动退出，仅在系统未自动退出、或用户明确要求「直接开始写代码」时调用。`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['submit', 'close', 'enter_mode', 'exit_mode'],
          description: '语义见上方各 Action 章节。',
        },
        // ── submit fields ──
        title: { type: 'string', description: '[submit] 简短描述性计划标题（用于生成文件 slug）' },
        plan: { type: 'string', description: '[submit] 完整计划 Markdown。省略则从 plan mode 活动计划文件读取。' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '方案短名（推荐项追加 "(Recommended)"）' },
              description: { type: 'string', description: '取舍简要说明' },
            },
            required: ['label', 'description'],
          },
          description: '[submit] 计划含 2-3 个不同方案时列出，供用户审批时选择。',
        },
        // ── close fields ──
        file_path: { type: 'string', description: '[close] docs/superpowers/plans/ 下的计划 Markdown 路径' },
        tasks: { type: 'string', description: '[close] 任务选择，如 1、1-3、1,3-4 或 all' },
        apply: { type: 'boolean', description: '[close] 写回计划文件（默认 false 预览模式）' },
        verifiedCommands: {
          type: 'array', items: { type: 'string' },
          description: '[close] 闭环摘要中包含的验证命令',
        },
        deliveryState: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED'], description: '[close] 交付门状态' },
        note: { type: 'string', description: '[close] 可选闭环备注' },
        updateClosure: { type: 'boolean', description: '[close] 是否 upsert 执行状态与闭环（默认 true）' },
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
    if (action === 'exit_mode') {
      return planExitModeExecute(params)
    }
    return { content: `错误：未知 action「${action}」。请使用 "submit"、"close"、"enter_mode" 或 "exit_mode"。`, isError: true }
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
 * 模型自主进入 plan mode（对齐 kimi-code EnterPlanMode：进入无需用户确认，
 * 审批门在 submit 时）。只进不出：退出计划模式仍归用户（approve/toggle），
 * 避免模型自行逃出只读沙箱。worker/非 agent 上下文没有 enterPlanMode ref →
 * fail-closed 报错。
 */
function planEnterModeExecute(params: ToolCallParams): ToolResult {
  if (!params.enterPlanMode) {
    return { content: '错误：当前上下文不可用 enter_mode（子代理不能把主代理切入计划模式）。', isError: true }
  }
  try {
    const { activePlanFilePath, alreadyPlanning } = params.enterPlanMode()
    if (alreadyPlanning) {
      return {
        content: `已在计划模式中。${activePlanFilePath ? ` 活动计划草稿：${activePlanFilePath}` : ''}`,
      }
    }
    return {
      content: [
        '已进入计划模式——写工具已禁用（计划草稿文件除外）。',
        activePlanFilePath ? `计划草稿: ${activePlanFilePath}` : '',
        '',
        '下一步：',
        '1. 先用 todo 建调研清单（3-6 项：摸清各模块现状、外部调研、设计收敛），最后一项固定为「汇总写计划并用 plan action=submit 提交审批」；逐项勾掉推进。计划正文只写计划文件，不进 todo。',
        '2. 调研：多模块任务用 delegate_batch 一次并行派 2-4 个只读 code_scout（按模块/文件域切分），汇总发现。',
        '3. 用 write_file/edit_file 把计划增量写入草稿——开头（H1 之后）先写「## 需求提炼」：用用户原话提炼需求目标与非目标（submit 门禁）。',
        '4. 瑶光反证（必需章节，submit 门禁）：关键断言在计划期复现——设计定稿后回读引用代码到 file:line、bugfix 跑 run_tests 拿 RED 证据、或派 profile=adversarial_verifier authority=yaoguang。复现不了的推论写为待验证假设，不当结论。',
        '5. 用 plan action=submit 提交（省略 plan 字段即从草稿提交）。提交门禁：标题级「需求提炼」章节、一张 ```mermaid 图、标题级「反证/复现」章节、>8 任务/>15 文件时 ### Wave N 分波——所有未达标项一次驳回列全。提交后用户通过会话内审批卡批准；不要让用户手输 /plan-approve 或任何命令。',
      ].filter(Boolean).join('\n'),
    }
  } catch (err) {
    return { content: `错误：${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/**
 * 退出 plan mode，解除写操作限制。不修改计划文件。
 * 正常流程审批即自动退出；本工具是后备——审批后系统未自动退出时手动调用。
 * worker/非 agent 上下文没有 exitPlanMode ref → fail-closed 报错。
 */
function planExitModeExecute(params: ToolCallParams): ToolResult {
  if (!params.exitPlanMode) {
    return { content: '错误：当前上下文不可用 exit_mode（子代理不能退出主代理的计划模式）。', isError: true }
  }
  try {
    params.exitPlanMode()
    return { content: '已退出计划模式——写操作限制已解除。' }
  } catch (err) {
    return { content: `错误：${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── submit implementation ──

/** 从 plan 指针首行解析出项目相对路径。格式：`[plan persisted to <path> — …]`。 */
function parsePlanPointerPath(prefix: string, value: string): string | null {
  const firstLine = value.trimStart().split(/\r?\n/, 1)[0] ?? ''
  if (!firstLine.startsWith(prefix)) return null
  const after = firstLine.slice(prefix.length).trimStart()
  const dashIdx = after.indexOf(' — ')
  const rel = (dashIdx >= 0 ? after.slice(0, dashIdx) : after.split(/\s/, 1)[0]!).trim()
  return rel || null
}

async function planSubmitExecute(params: ToolCallParams): Promise<ToolResult> {
  const title = params.input.title
  let planContent: unknown = params.input.plan
  let submitOptions: PlanOption[] | undefined
  try {
    submitOptions = parseSubmitOptions(params.input.options)
  } catch (err) {
    return {
      content: `错误：${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }

  if (typeof title !== 'string' || !title.trim()) {
    return { content: '错误：title 必填', isError: true }
  }

  let submittedFromDraft: string | null = null
  if (typeof planContent !== 'string' || !planContent.trim()) {
    const draftPath = params.activePlanFilePath
    if (!draftPath) {
      return {
        content: '错误：未设置活动计划文件时 plan 必填。请先写入计划文件，或直接传入 plan 内容。',
        isError: true,
      }
    }
    let draftText: string
    try {
      draftText = await readFile(join(params.cwd, draftPath), 'utf-8')
    } catch (err) {
      return {
        content: `读取活动计划文件失败（${draftPath}）：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
    if (!draftText.trim()) {
      return {
        content: `错误：活动计划文件为空（${draftPath}）。请先写入计划，再提交。`,
        isError: true,
      }
    }
    planContent = draftText
    submittedFromDraft = draftPath
  }

  // 指针回传门禁（硬性，先于一切软门禁）：arg post-processor 会把历史里的
  // plan 字段改写成 "[plan persisted to …]" 显示指针——包括被门禁拒绝、实际
  // 并未落盘的提交。模型复用该指针重提时必须在这里拦下。
  //（write_file/edit_file/hash_edit 同款防线，pointer-guard.ts 中 PLAN_POINTER_PREFIX 已注册。）
  const matchedPointer = detectPointerPlaceholder(planContent as string)
  if (matchedPointer) {
    // 优雅化解：指针所指计划文件确实在磁盘上 → 幂等成功。
    // 被门禁拒绝的提交也会产生指针但未落盘 → resolve 返回 null，走原错误。
    const relPath = parsePlanPointerPath(matchedPointer, planContent as string)
    if (relPath) {
      const absPath = join(params.cwd, relPath)
      const resolved = await resolveIdempotentPointer({ mode: 'edit', filePath: absPath, value: planContent as string, matchedPrefix: matchedPointer })
      if (resolved) return { content: resolved.content }
    }
    return {
      content: [
        `❌ 提交被拦截：plan 字段的内容是系统显示占位符（"${matchedPointer} …"），不是真实的计划正文。`,
        `原因：对话历史中，提交后的参数会被替换为显示摘要（包括被门禁拒绝、未落盘的提交）。AI 有时会误把摘要当正文复用。`,
        `修复：在 plan 字段写出完整计划正文；或省略 plan 字段同 title 重提（从活动计划文件读取）。如需旧版本，先 read_file 目标计划文件。`,
        `[${POINTER_GUARD_ERROR_MARKER}]`,
      ].join(' '),
      isError: true,
    }
  }

  // 剥离历史 approve/reject 状态标记 — 驳回修订后从活动计划文件整读重提交时,
  // 残留的 "> **Status: REJECTED**" 会让新提交被误判为 rejected,从待批准列表消失。
  const planBody = stripPlanStatusMarkers(planContent as string)

  const slug = slugify(title)

  const fullContent = planBody.trim().startsWith('# ')
    ? `${planBody.trim()}\n`
    : `# ${title.trim()}\n\n${planBody.trim()}\n`

  // 硬拦（每次命中都拦，非 one-shot）：占位符簇/空章节/纯省略号段落。
  const placeholderCheck = checkPlanForPlaceholders(fullContent)
  if (!placeholderCheck.ok) {
    return {
      content: [
        `⚠️ 计划尚未保存 — ${placeholderCheck.reason}`,
        '',
        '用 edit_file 完善活动计划文件：根因、每文件 diff/伪代码、取舍表、验证清单等。不要在聊天里重打全文；补完后同 title 重提（省略 plan 字段可从活动计划文件读取）。',
      ].join('\n'),
      isError: true,
    }
  }

  // 软门禁聚合：全部检查一次跑完，一次拒绝列全所有缺口。串行 early-return
  // 曾让一份计划被逐条拦 4 轮（规模→mermaid→反证），每轮拒绝还在历史里多留
  // 一个谎称"已持久化"的指针（见上方指针门禁）。one-shot 软拦语义不变：每项
  // 按 slug 只拦一次，同 title 重提即放行。
  const blocks: string[] = []

  // 需求提炼门禁：审批先审意图再审方案——计划开头必须有用用户原话提炼的
  // 需求章节（目标 + 非目标），防止误解意图后直接跳进设计。
  if (!REQUIREMENT_DISTILL_HEADING_RE.test(fullContent) && !requirementWarnedSlugs.has(slug)) {
    requirementWarnedSlugs.add(slug)
    blocks.push([
      '缺「需求提炼」章节——在计划开头（H1 之后）补一个标题含"需求提炼"的 ## 级章节，用用户原话提炼需求：',
      '- **目标**：用户要达成什么（尽量引用/贴近用户原话，不要改写成官方套话）',
      '- **非目标**：明确不做什么（边界外但容易被误并入的事项）',
    ].join('\n'))
  }

  if (!MERMAID_FENCE.test(planBody) && !warnedSlugs.has(slug)) {
    warnedSlugs.add(slug)
    blocks.push([
      `缺 Mermaid 图——用 edit_file 在活动计划文件里补一张架构/数据流图（哪怕核心 3–5 个节点）。骨架：`,
      '',
      MISSING_DIAGRAM_SKELETON,
      '',
      `图形说明：(圆角)=输入/用户 · [[子程序]]=agent · {{六边形}}=LLM · [(圆柱)]=存储 · {菱形}=决策。`,
    ].join('\n'))
  }

  // 瑶光反证门禁：计划期复现，不是执行期才验。设计阶段发明的断言
  // 必须回到代码/运行时复现。
  if (!FALSIFICATION_HEADING_RE.test(fullContent) && !falsificationWarnedSlugs.has(slug)) {
    falsificationWarnedSlugs.add(slug)
    blocks.push([
      '缺「瑶光反证」章节——需要一个标题含"反证"或"复现"的 ## 级章节（正文/列表里提到不算）。用 edit_file 在活动计划文件补该章节（证据摘要 + file:line，不要贴逐步 shell 菜谱）：',
      '- **关键断言清单**：每条断言 + 计划期证据（定稿后 read/grep 到 file:line、run_tests 输出摘要、或 adversarial_verifier 结论）',
      '- **原缺陷复现**（bugfix）：复现结果摘要（RED），非完整命令教程',
      '- **待验证假设**：计划期无法复现的推论 + 执行期如何验证',
    ].join('\n'))
  }

  // Fact-anchor verification: file paths / line anchors cited by the plan must
  // match the current working tree. One-shot soft block, aggregated with the
  // other gates; on pass-through the residual drift note is kept.
  let anchorDriftNote = ''
  try {
    const anchorReport = await checkPlanFactAnchors(fullContent, params.cwd)
    if (anchorReport.drifts.length > 0) {
      if (!anchorWarnedSlugs.has(slug)) {
        anchorWarnedSlugs.add(slug)
        blocks.push([
          `${anchorReport.drifts.length} 个事实锚点与当前项目不符：`,
          '',
          formatAnchorDrifts(anchorReport.drifts),
          '',
          '用 read/grep 核实后 edit_file 修正活动计划文件中的引用；确认新建则标注「新增」；根错位（实际位于子目录/兄弟项目）的引用补全根前缀。',
        ].join('\n'))
      } else {
        anchorDriftNote = `\n⚠ 锚点残留提示：${anchorReport.drifts.length} 个引用仍与当前工作区不符（已放行）。执行时以现实为准并在交付报告留痕。`
      }
    }
  } catch {
    // Anchor verification is best-effort — never let the guard itself block a submit.
  }

  // 规模门禁：大计划（任务 > 8 或文件 > 15）必须显式分波 + 每波验证命令。
  let scaleNote = ''
  try {
    const scale = checkPlanScale(fullContent)
    if (scale.oversized && !scale.hasWaveStructure) {
      if (!scaleWarnedSlugs.has(slug)) {
        scaleWarnedSlugs.add(slug)
        blocks.push([
          `计划规模超阈值（任务 ${scale.taskCount} 个 / 涉及文件 ${scale.fileCount} 个，阈值 ${PLAN_SCALE_TASK_THRESHOLD}/${PLAN_SCALE_FILE_THRESHOLD}），但没有分波结构。用 edit_file 在活动计划文件补充「分波执行」章节：`,
          '- 用 `### Wave 1 / Wave 2 / …` 标题把任务切成 2-4 个可独立验证的波次',
          '- 每波末尾声明验证要点（typecheck / 测试），波间硬门禁会真实执行它们',
          '- 波的边界放在功能可自证的位置（一波结束 = 可编译可测试）',
        ].join('\n'))
      } else {
        scaleNote = `\n⚠ 规模留痕：计划超阈值（任务 ${scale.taskCount} / 文件 ${scale.fileCount}）且无分波结构（已放行）。执行时建议手动分批 + 阶段性验证。`
      }
    }
  } catch {
    // Scale gate is best-effort — never let the guard itself block a submit.
  }

  if (blocks.length > 0) {
    return {
      content: [
        `⚠️ 计划尚未保存 — 共 ${blocks.length} 项缺口（一次列全，免去逐条往返）：`,
        '',
        ...blocks.map((block, i) => `${i + 1}. ${block}`),
        '',
        '逐条补完后同 title 重提（省略 plan 字段可从活动计划文件读取；不要在聊天重贴全文，历史里的 "[plan persisted to …]" 是显示指针不是内容）。每项只拦一次——确认某项不适用时原样重提即放行。',
      ].join('\n'),
      isError: true,
    }
  }

  // 产出模型留痕：记录本计划由哪个模型写出（H1 前标记行，PlanDocument 解析为
  // model/modelTier）。纯中性元数据，不在任何审批面产生差异化提示。
  const producerModel = params.sessionModel?.trim()
  const producerTier = producerModel ? inferModelTierFromName(producerModel) : null
  const contentToPersist = producerModel
    ? insertPlanModelMarker(fullContent, producerModel, producerTier)
    : fullContent

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
      ? `\n已记录选项（${submitOptions.length}）。用户可在审批时选择：${submitOptions.map(o => `\`${o.label}\``).join(', ')}`
      : ''
    // Notify the TUI so it can prompt the user with an arrow-key approval panel.
    params.onPlanSubmitted?.({ slug, title: title.trim(), options: submitOptions })
    return {
      content: [
        `✅ 计划已提交：**${title.trim()}**`,
        `文件：\`${relativePath}\``,
        `Slug：\`${slug}\``,
        optionsHint,
        anchorDriftNote,
        scaleNote,
        '',
        '',
        `审批请求已推送给用户（桌面端会话内审批卡 / TUI 审批面板；若卡片未弹出，用户可在计划面板找到该计划批准）——批准即开始执行，也可附修订意见驳回。批准从不要求用户手输任何命令。`,
        `若用户问起 TUI 备用命令：/plan-approve ${slug}、/plan-reject ${slug}，或 /plan-list。`,
        '',
        `**请在此等待——在用户批准前不要继续推进。**`,
      ].filter(Boolean).join('\n'),
    }
  } catch (err) {
    return {
      content: `写入计划失败：${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}

// ── close implementation ──

async function planCloseExecute(params: ToolCallParams): Promise<ToolResult> {
  const rawPath = params.input.file_path
  const tasks = params.input.tasks
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { content: '错误：file_path 必填', isError: true }
  }
  if (typeof tasks !== 'string' || !tasks.trim()) {
    return { content: '错误：tasks 必填', isError: true }
  }

  let filePath: string
  try {
    filePath = validatePath(params.cwd, rawPath)
  } catch {
    return { content: '错误：路径逃逸出项目目录', isError: true }
  }

  const relativePath = relative(params.cwd, filePath).replaceAll('\\', '/')
  const inSuperpowersPlans = relativePath.startsWith('docs/superpowers/plans/') && relativePath.endsWith('.md')
  const inRivetPlans = relativePath.startsWith('.rivet/plans/') && relativePath.endsWith('.md')
  if (!inSuperpowersPlans && !inRivetPlans) {
    return { content: `错误：plan close 仅支持 docs/superpowers/plans/ 或 .rivet/plans/：${relativePath}`, isError: true }
  }
  try { await stat(filePath) } catch {
    return { content: `错误：未找到计划文件：${filePath}`, isError: true }
  }

  const deliveryState = params.input.deliveryState
  if (deliveryState !== undefined && !isDeliveryState(deliveryState)) {
    return { content: '错误：deliveryState 必须是 GREEN、YELLOW 或 RED', isError: true }
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
        `计划关闭被拦截：声称 GREEN，但交付门禁为 RED。`,
        gateBlock.reason,
        gateBlock.nextStep ? `下一步：${gateBlock.nextStep}` : '',
        '',
        `请先跑真实验证（typecheck/测试）再关闭，或诚实以 deliveryState=RED/YELLOW 作为进度检查点关闭。`,
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
      // plan close 只做闭环标记，不再承担「解锁写权限」职责。
      // 退出 plan mode 改用 plan action=exit_mode（或审批自动退出）。
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
          `计划已关闭：${relativePath}`,
          `任务：${tasks}`,
          `已更新复选框：${result.totalChangedCheckboxes}`,
          `闭环：${action}`,
          effectiveState ? `交付：${effectiveState}${realGreen ? '（已标记 EXECUTED）' : ''}` : '',
          mismatchNote ? `证据：${mismatchNote}` : '',
        ].filter(Boolean).join('\n'),
      }
    }

    return {
      content: [
        `计划关闭预览：${relativePath}`,
        `任务：${tasks}`,
        `将更新复选框：${result.totalChangedCheckboxes}`,
        `闭环：${action}`,
        effectiveState ? `交付：${effectiveState}` : '',
        gateBlock ? `⚠ 门禁：声称 GREEN 但真实门禁为 RED —— apply=true 将被拦截。` : '',
        mismatchNote ? `证据：${mismatchNote}` : '',
        '',
        '变更：',
        ...formatChanges(result),
        '',
        '未写入任何文件。以 apply=true 重跑以写入计划闭环。',
      ].filter(Boolean).join('\n'),
    }
  } catch (err) {
    return { content: `错误：${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── Backward-compat exports: callers in default-registry and elsewhere expect
//    the old split-tool constants. Both resolve to the same PLAN_TOOL instance.
export const PLAN_SUBMIT_TOOL = PLAN_TOOL
export const PLAN_CLOSE_TOOL = PLAN_TOOL

import { TASK_ANCHOR_MAX_ITEMS } from '../compact/constants.js'

export type ContractStatus =
  | 'exploring'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'blocked'
  | 'ready_to_deliver'

export interface TaskContract {
  id: string
  objective: string
  scope: {
    mentionedFiles: string[]
  }
  constraints: string[]
  successCriteria: string[]
  status: ContractStatus
  createdAtTurn: number
  updatedAtTurn: number
  isActionable: boolean
}

const FILE_PATTERN = /(?:^|\s)((?:src|lib|test|tests|pkg|cmd|internal|docs|scripts)\/[\w./-]+\.\w+)/g
const CONSTRAINT_MARKER_PATTERN = /\b(?:don'?t|must(?:n'?t)?|never)\b|不要|禁止|必须|不可以|不能/i
const CLAUSE_SPLIT_PATTERN = /[。.!?！？]+|[\n\r]+/g

/** Shared word list for greeting / non-actionable detection. Single source of truth. */
const GREETING_WORDS = 'hi|hello|hey|你好|您好|谢谢|多谢|谢谢你|ok|okay|了解|收到|辛苦了|thanks|thank you'

/** Short messages that signal task continuation — not social, even though they're short CJK-only. */
const CONTINUATION_PATTERN = /^(?:继续|然后呢|然后|接着|下一步|做\s*[PpTtSs]\d+|go|continue|next|好\s*(?:继续|做|的\s*(?:继续|做)))[。.!\uff01？?\s]*$/i

/** Matches a message that is *entirely* a greeting or polite ack (no substantive content). */
const NON_ACTIONABLE_PATTERN = new RegExp('^(?:' + GREETING_WORDS + ')[\u3002.!\uff01\uff1f?\s]*$', 'i')

/**
 * Matches a greeting *prefix* followed by substantive content on the next line.
 * Used by stripGreetingPrefix to peel off greeting lines before real instructions.
 */
const GREETING_PREFIX_RE = new RegExp('^(?:' + GREETING_WORDS + ')[\u3002.,!\uff01\uff1f?\s]*(?:\n|$)', 'i')

const STATUS_RANK: Record<Exclude<ContractStatus, 'blocked'>, number> = {
  exploring: 0,
  planning: 1,
  executing: 2,
  verifying: 3,
  ready_to_deliver: 4,
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function stripGreetingPrefix(userMessage: string): string {
  return userMessage.replace(GREETING_PREFIX_RE, '').trim()
}

function normalizeObjective(userMessage: string): string {
  // Strip greeting prefix if followed by substantive content on next line
  const stripped = stripGreetingPrefix(userMessage)
  const msg = stripped || userMessage
  const firstLine = msg.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 200 ? firstLine.slice(0, 197).trimEnd() + '...' : firstLine
}

function makeContractId(objective: string, turn: number): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return `task-${turn}-${slug || 'untitled'}`
}

export type TurnMode = 'chat' | 'followUp' | 'task'

function cjkAwareWeight(text: string): number {
  return [...text].reduce((sum, ch) => {
    const cp = ch.codePointAt(0) ?? 0
    return sum + ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ? 2 : 1)
  }, 0)
}

/**
 * Unified social/trivial detection — single source of truth for both
 * task-contract and intent-retrieval-route. Covers pure greetings,
 * short CJK-only social phrases, and short Latin greetings.
 */
export function isSocialOrTrivial(text: string): boolean {
  const stripped = text.trim()
  if (stripped.length === 0) return true
  if (NON_ACTIONABLE_PATTERN.test(stripped)) return true
  const cjkChars = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  if (cjkChars > 0 && cjkChars <= 4 && stripped.replace(/[\u4e00-\u9fff\u3400-\u4dbf\s!?！？。，,.]/g, '').length === 0) return true
  const wordCount = stripped.split(/\s+/).filter(Boolean).length
  if (wordCount > 0 && wordCount <= 3) {
    if (/^(hi|hello|hey|yo|sup|ok|okay|thanks|thx|bye|goodbye|morning|evening|night|greetings?)(\s+(there|you|all|everyone|folks))?$/i.test(stripped.toLowerCase())) return true
  }
  return false
}

function isActionableObjective(objective: string, mentionedFiles: string[], constraints: string[]): boolean {
  if (mentionedFiles.length > 0 || constraints.length > 0) return true
  if (cjkAwareWeight(objective) < 6) return false
  return !NON_ACTIONABLE_PATTERN.test(objective)
}

/**
 * Three-state turn mode classification.
 * - chat: social/trivial input with no active task context
 * - followUp: short directive or lightweight query within an active task
 * - task: substantive new or progressing task requiring full CVM pipeline
 */
export function classifyTurnMode(userMessage: string, activeContract?: TaskContract): TurnMode {
  const objective = normalizeObjective(userMessage)

  // Gate 0: continuation directives with active contract → followUp (before social check)
  if (activeContract && activeContract.status !== 'ready_to_deliver' && CONTINUATION_PATTERN.test(objective)) {
    return 'followUp'
  }

  // Gate 1: pure social/greeting → chat, unless it's a non-greeting ack with active contract
  if (isSocialOrTrivial(objective)) {
    // Explicit greetings/thanks → always chat
    if (!activeContract || activeContract.status === 'ready_to_deliver' || NON_ACTIONABLE_PATTERN.test(objective.trim())) {
      return 'chat'
    }
    // Short CJK ack (not a greeting word) with active contract → followUp
    return 'followUp'
  }

  // Gate 2: active contract + short message without new scope → followUp
  if (activeContract && activeContract.status !== 'ready_to_deliver') {
    const hasNewFiles = FILE_PATTERN.test(userMessage)
    // Reset lastIndex after .test() on a global regex
    FILE_PATTERN.lastIndex = 0
    const hasNewConstraints = CONSTRAINT_MARKER_PATTERN.test(objective)
    if (!hasNewFiles && !hasNewConstraints) {
      const weight = cjkAwareWeight(objective)
      if (weight < 20) return 'followUp'
    }
  }

  // Gate 3: full actionable check → task
  const mentionedFiles: string[] = []
  for (const match of userMessage.matchAll(FILE_PATTERN)) {
    const file = match[1]
    if (file && !mentionedFiles.includes(file)) mentionedFiles.push(file)
  }
  const constraints = extractConstraints(userMessage)
  if (isActionableObjective(objective, mentionedFiles, constraints)) return 'task'

  // Gate 4: non-actionable but active contract → followUp
  if (activeContract && activeContract.status !== 'ready_to_deliver') return 'followUp'

  return 'chat'
}

function defaultSuccessCriteria(objective: string): string[] {
  if (!objective) return []
  return [
    'requested behavior addressed',
    'relevant verification completed or explicitly marked unverified',
  ]
}

function extractConstraints(userMessage: string): string[] {
  const constraints: string[] = []
  for (const rawClause of userMessage.split(CLAUSE_SPLIT_PATTERN)) {
    const clause = rawClause.trim()
    if (!clause || !CONSTRAINT_MARKER_PATTERN.test(clause)) continue
    const text = clause.slice(0, 120)
    if (!constraints.includes(text)) constraints.push(text)
  }
  return constraints
}

export function extractTaskContract(userMessage: string, turn: number = 0): TaskContract {
  const objective = normalizeObjective(userMessage)

  const mentionedFiles: string[] = []
  for (const match of userMessage.matchAll(FILE_PATTERN)) {
    const file = match[1]
    if (file && !mentionedFiles.includes(file)) mentionedFiles.push(file)
  }

  const constraints = extractConstraints(userMessage)

  return {
    id: makeContractId(objective, turn),
    objective,
    scope: { mentionedFiles },
    constraints,
    successCriteria: defaultSuccessCriteria(objective),
    status: 'exploring',
    createdAtTurn: turn,
    updatedAtTurn: turn,
    isActionable: isActionableObjective(objective, mentionedFiles, constraints),
  }
}

/**
 * P5: merge new constraints / files mentioned in a follow-up turn into the
 * inherited contract.
 *
 * classifyTurnMode's gate-2 checks for new constraints using only the first
 * line (objective), so a multi-line follow-up whose constraint sits on a later
 * line is classified as 'followUp' and would otherwise be dropped. Here we
 * re-scan the WHOLE message (same extractors extractTaskContract uses) and fold
 * anything new into the contract, so corrections survive into the task-anchor
 * that is re-injected after compaction.
 *
 * Returns the original contract unchanged when nothing new is found, preserving
 * identity (and thus avoiding needless task-anchor churn / cache invalidation).
 */
export function mergeFollowUpIntoContract(
  contract: TaskContract,
  userMessage: string,
  turn: number = contract.updatedAtTurn,
): TaskContract {
  const newConstraints = extractConstraints(userMessage)
  const newFiles: string[] = []
  for (const match of userMessage.matchAll(FILE_PATTERN)) {
    const file = match[1]
    if (file) newFiles.push(file)
  }
  if (newConstraints.length === 0 && newFiles.length === 0) return contract

  const constraints = [...contract.constraints]
  for (const c of newConstraints) if (!constraints.includes(c)) constraints.push(c)
  const mentionedFiles = [...contract.scope.mentionedFiles]
  for (const f of newFiles) if (!mentionedFiles.includes(f)) mentionedFiles.push(f)

  const constraintsChanged = constraints.length !== contract.constraints.length
  const filesChanged = mentionedFiles.length !== contract.scope.mentionedFiles.length
  if (!constraintsChanged && !filesChanged) return contract

  return {
    ...contract,
    constraints,
    scope: { mentionedFiles },
    updatedAtTurn: turn,
    isActionable: contract.isActionable || isActionableObjective(contract.objective, mentionedFiles, constraints),
  }
}

export function advanceContractStatus(contract: TaskContract, nextStatus: ContractStatus, turn: number = contract.updatedAtTurn): TaskContract {
  if (contract.status === nextStatus) return contract
  if (nextStatus === 'blocked') return { ...contract, status: 'blocked', updatedAtTurn: turn }
  if (contract.status === 'blocked') return { ...contract, status: nextStatus, updatedAtTurn: turn }

  const currentRank = STATUS_RANK[contract.status]
  const nextRank = STATUS_RANK[nextStatus]
  if (nextRank < currentRank) return contract
  return { ...contract, status: nextStatus, updatedAtTurn: turn }
}

export function contractStatusFromPhaseClass(phaseClass: string): ContractStatus | undefined {
  switch (phaseClass) {
    case 'explore': return 'exploring'
    case 'plan': return 'planning'
    case 'execute': return 'executing'
    case 'verify': return 'verifying'
    case 'deliver': return 'ready_to_deliver'
    default: return undefined
  }
}

export function renderContractProjection(contract: TaskContract): string {
  if (!contract.isActionable) return ''

  const parts = [`<task-contract id="${escapeXml(contract.id)}" status="${contract.status}">`]
  parts.push(`  <objective>${escapeXml(contract.objective)}</objective>`)
  if (contract.scope.mentionedFiles.length > 0) {
    parts.push(`  <scope>${contract.scope.mentionedFiles.map(escapeXml).join(', ')}</scope>`)
  }
  for (const constraint of contract.constraints.slice(0, 3)) {
    parts.push(`  <constraint>${escapeXml(constraint)}</constraint>`)
  }
  for (const criterion of contract.successCriteria.slice(0, 2)) {
    parts.push(`  <success>${escapeXml(criterion)}</success>`)
  }
  parts.push('</task-contract>')
  return parts.join('\n')
}

/** Progress fields fused into the post-compaction task anchor. Sourced from
 *  the live task-state (todos / trajectory), which the contract itself does
 *  not track. */
export interface TaskAnchorProgress {
  completed?: string[]
  remaining?: string[]
}

/**
 * Render the AUTHORITATIVE task anchor for re-injection into the appendix
 * region after compaction (C4).
 *
 * The difference from `renderContractProjection`: this block is explicitly
 * marked authoritative and fuses the verbatim contract (objective / constraints
 * = forbidden items / success criteria) with live progress (completed /
 * remaining). When an LLM-generated compaction summary above it drifts or drops
 * a constraint, this block is the ground truth the model must defer to.
 *
 * It is appended at the TAIL of the message list (never the frozen prefix), so
 * re-injecting it every compaction is prefix-cache safe.
 */
export function renderTaskAnchor(contract: TaskContract, progress: TaskAnchorProgress = {}): string {
  if (!contract.isActionable) return ''

  const lines: string[] = [
    `<task-anchor authoritative="true" status="${contract.status}">`,
    'AUTHORITATIVE task definition — survives compaction verbatim. If any summary above conflicts with this block, THIS block is ground truth.',
    `  <objective>${escapeXml(contract.objective)}</objective>`,
  ]
  if (contract.scope.mentionedFiles.length > 0) {
    lines.push(`  <scope>${contract.scope.mentionedFiles.slice(0, TASK_ANCHOR_MAX_ITEMS).map(escapeXml).join(', ')}</scope>`)
  }
  // constraints == forbidden / hard requirements: never silently drop these.
  for (const constraint of contract.constraints.slice(0, TASK_ANCHOR_MAX_ITEMS)) {
    lines.push(`  <constraint>${escapeXml(constraint)}</constraint>`)
  }
  for (const criterion of contract.successCriteria.slice(0, 2)) {
    lines.push(`  <success>${escapeXml(criterion)}</success>`)
  }
  const completed = (progress.completed ?? []).filter(Boolean)
  const remaining = (progress.remaining ?? []).filter(Boolean)
  for (const item of completed.slice(-TASK_ANCHOR_MAX_ITEMS)) {
    lines.push(`  <completed>${escapeXml(item)}</completed>`)
  }
  for (const item of remaining.slice(0, TASK_ANCHOR_MAX_ITEMS)) {
    lines.push(`  <remaining>${escapeXml(item)}</remaining>`)
  }
  lines.push('</task-anchor>')
  return lines.join('\n')
}

/**
 * Quick intent check: does this user message warrant task-mode scaffolding?
 * Kept for backward compatibility — prefer classifyTurnMode for three-state logic.
 */
export function isActionableTurn(userMessage: string): boolean {
  const contract = extractTaskContract(userMessage)
  return contract.isActionable
}

// ── Task Depth Layer ────────────────────────────────────────────────

export type TaskDepthLayer = 'unit' | 'wiring' | 'system'

const WIRING_VERB_PATTERN = /接通|对接|串联|接线|打通|wire|integrat|hook.*up|connect.*to|pipe.*through/i
const SYSTEM_VERB_PATTERN = /端到端|全链路|end.to.end|\bE2E\b|full.path|cross.layer/i

/**
 * Minimal impact shape accepted by classifyTaskDepth — avoids a hard
 * dependency on meridian-impact.ts so callers can pass whatever subset
 * they have (or nothing at all).
 */
export interface DepthImpactHint {
  directCount: number
  transitiveCount: number
}

/**
 * Classify how many module boundaries a task crosses.
 *
 * - unit:   single file / single function scope — mocks are safe
 * - wiring: 2+ modules, the fix IS the connection — mocks hide the bug
 * - system: 3+ layers end-to-end — needs E2E or multi-layer integration test
 *
 * Signals (priority order):
 *  1. Verb override  — Chinese/English keywords that directly signal depth
 *  2. File count + impact (optional MeridianDb reverse-BFS result)
 *  3. IntentTaskKind bias (optional, passed as string[])
 */
export function classifyTaskDepth(
  contract: TaskContract,
  impact?: DepthImpactHint,
  taskKinds?: string[],
): TaskDepthLayer {
  const obj = contract.objective

  // Priority 1: explicit verb override (strongest signal)
  if (SYSTEM_VERB_PATTERN.test(obj)) return 'system'
  if (WIRING_VERB_PATTERN.test(obj)) return 'wiring'

  // Priority 2: file count + impact analysis
  const fileCount = contract.scope.mentionedFiles.length
  const directDeps = impact?.directCount ?? 0
  const transitiveDeps = impact?.transitiveCount ?? 0

  if (directDeps >= 9 || (directDeps >= 5 && transitiveDeps >= 10)) return 'system'
  if (directDeps >= 3 || fileCount >= 3) return 'wiring'
  if (fileCount >= 2) {
    // 2 files in different directories → likely wiring
    const dirs = new Set(contract.scope.mentionedFiles.map(f => f.split('/').slice(0, 2).join('/')))
    if (dirs.size >= 2) return 'wiring'
  }

  // Priority 3: IntentTaskKind bias
  if (taskKinds && taskKinds.length > 0) {
    const kinds = new Set(taskKinds)
    if (kinds.has('architecture_design')) return 'system'
    if (kinds.has('refactor') && fileCount >= 2) return 'wiring'
  }

  return 'unit'
}

// ── Plan Methodology Router ─────────────────────────────────────────
//
// 天璇收敛（碎片→模式）：TaskDepthLayer 数模块边界，两个计划模板的
// 区别本质上是 enforcement gate 数量。统一方法：让 TaskDepthLayer 的
// 输出直接驱动模板选择，不新建第四个系统。

export type PlanMethodology = 'lightweight' | 'full'

/**
 * Files belonging to enforcement subsystems. When a task mentions files from
 * 2+ different subsystems here, it's a multi-gate coordination change →
 * full plan methodology.
 *
 * Maintained as a flat list for now (MVP: security domain). Future domains
 * (prompt + behavior, cache + prompt, API + error-classifier) can be added
 * by extending this list or migrating to a directory-convention glob.
 */
const ENFORCEMENT_SUBSYSTEM_FILES: ReadonlySet<string> = new Set([
  // File-tool gate
  'src/tools/path-validate.ts',
  'src/tools/path-grants.ts',
  // Kernel sandbox gate
  'src/tools/sandbox-profile.ts',
  // Approval perimeter
  'src/agent/permissions.ts',
  'src/agent/approval-risk.ts',
  // Sandbox wrapper (bash tool)
  'src/tools/bash.ts',
])

const MULTI_GATE_VERB_PATTERN = /双门|多门|两个.*gate|both.*enforcement|sandbox.*file.*tool|file.*sandbox|enforcement.*sync|授权.*同步|安全.*接通/i
const SAFETY_KEYWORD_PATTERN = /(security|permission|sandbox|安全|权限|沙箱|auth(?:orization)?|validate\s*safe|writable\s*root|policy)/i

/**
 * Routing decision: given what we know about the task, which plan
 * template should 天权 use?
 *
 * This is a DERIVED signal — it doesn't replace TaskDepthLayer. It
 * combines TaskDepthLayer with gate-count and safety-critical signals
 * to decide between lightweight (5-stage) and full (9-stage) templates.
 *
 * Rules are evaluated in priority order. Returns 'lightweight' by default
 * (fail-conservative: don't upgrade to full without sufficient signal).
 *
 * @param contract   Task contract with objective, mentionedFiles, constraints
 * @param depthLayer Pre-computed TaskDepthLayer classification
 * @param impact     Optional MeridianDb impact analysis result
 * @param override   Explicit user override — if set, skips all rules
 */
export function classifyPlanMethodology(
  contract: TaskContract,
  depthLayer: TaskDepthLayer,
  impact?: DepthImpactHint,
  override?: PlanMethodology,
): PlanMethodology {
  // User override always wins — skip the entire rule chain
  if (override !== undefined) return override

  const obj = contract.objective
  const files = contract.scope.mentionedFiles

  // Rule 1 — SYSTEM depth → always 'full'
  // System tasks span 3+ layers; even single-gate changes have wide
  // consumer impact requiring full-boundary safety invariants.
  if (depthLayer === 'system') return 'full'

  // Count enforcement files mentioned in this task
  const enforcementFiles = files.filter(f => ENFORCEMENT_SUBSYSTEM_FILES.has(f))
  const enforcementFileCount = enforcementFiles.length

  // Rule 2 — Multi-gate signal → 'full'
  // 2a: Verb pattern signals multi-gate coordination
  if (MULTI_GATE_VERB_PATTERN.test(obj)) return 'full'

  // 2b: Files from 2+ enforcement subsystems
  if (enforcementFileCount >= 2) return 'full'

  // 2c: Constraint signals safety-critical coordination
  const hasSafetyConstraint = contract.constraints.some(c => SAFETY_KEYWORD_PATTERN.test(c))
  if (hasSafetyConstraint) return 'full'

  // Rule 3 — WIRING depth + multi-file.
  // If we reach here, enforcementFileCount < 2 (Rule 2b already checked).
  // WIRING multi-file without multi-gate signal → lightweight.
  // (Pure refactors spanning multiple non-enforcement files don't need the
  // full 9-stage template.)

  // Rule 4 — WIRING depth + single enforcement file + safety keyword → 'full'
  // Even when only one enforcement file is touched, if the objective
  // explicitly mentions safety concepts, the full template's security
  // invariants and trigger-path checklist have defensive value.
  if (depthLayer === 'wiring' && enforcementFileCount === 1 && SAFETY_KEYWORD_PATTERN.test(obj)) {
    return 'full'
  }

  // Rule 5 — UNIT depth → 'lightweight'
  // Single-file/single-function scope. Even enforcement-file fixes at
  // unit scope (e.g. "fix canonicalize typo in path-grants.ts") don't
  // need the full 9-stage template.
  if (depthLayer === 'unit') return 'lightweight'

  // Default — 'lightweight'
  // Not enough signal to justify full template. User can override.
  return 'lightweight'
}
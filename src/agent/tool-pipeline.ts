import type { AgentConfig, AgentCallbacks } from './loop-types.js'
import type { TurnBudget } from './turn-budget.js'
import type { ContentBlock } from '../api/types.js'
import type { ToolCallParams, VerificationMetadata, ToolErrorClass } from '../tools/types.js'
import type { TurnHarness } from './turn-harness.js'
import type { EvidenceTrackerPublic } from './evidence.js'
import type { TraceStore } from './trace-store.js'
import type { RepairHintTracker } from './repair-hint.js'
import type { ImportGraph } from './import-graph.js'
import { mkdir, appendFile } from 'node:fs/promises'
import { createCheckpoint, recordAgentTouchedFile, recordBashSideEffects, makeOwnershipGuard, type OwnershipGuard, type ClaimLookup } from './checkpoint.js'
import { validatePath, validatePathSafe } from '../tools/path-validate.js'
import { grantPath } from '../tools/path-grants.js'
import { dirname, join, resolve as resolvePath, isAbsolute } from 'node:path'
import { getSessionDir } from './session-persist.js'
import { classifyFailure, classifyTestRun, isTransient } from './failure-classifier.js'
import { extractClaimsFromToolResult } from '../context/claim-extractor.js'
import { appendProjectMemory, compactProjectMemory } from '../context/project-memory-writer.js'
import { detectConflicts } from '../context/conflict-detect.js'
import { createAntibodyProposal } from '../context/antibody.js'
import { buildImportGraph, invalidateFile } from './import-graph.js'
import { generateImpactHint } from './impact-hint.js'
import { analyzeImpact } from '../repo/meridian-impact.js'
import { shouldRunDiagnostics, filterDiagnosticsForEdit } from '../lsp/client.js'
import type { LspManager } from '../lsp/manager.js'
import { startTraceEvent, finishTraceEvent, fingerprintToolCall, fingerprintToolClass, recordToolFingerprint, recordTraceEvent, offendingFingerprints, getDoomLoopThresholds } from './trace-store.js'
import { summarizeRepairTelemetry } from './repair-pipeline.js'
import type { InterventionLevel } from './prediction-error.js'
import { assessToolRisk, CONFIDENCE_THRESHOLDS, isDestructiveGitAction, isSafeWriteOnly, requiresBashWriteApproval } from './approval-risk.js'
import type { Sensorium } from './sensorium.js'
import { isToolAllowed, isToolDenied, isBashCommandAllowlisted, isBashCommandDenied, learnBashPrefix, learnFileApproval } from './permissions.js'
import { isSandboxActive } from '../tools/sandbox-profile.js'
import { applyApprovalEdit, type ApprovalResult } from './approval-edit.js'
import { debugEnabled, debugLog } from '../utils/debug.js'
import { suggestStrategyShift, type TrajectorySummary } from './strategy-shift.js'
import { PrewarmCache } from './prewarm.js'
import { batchPrewarm } from './prewarm-file.js'

import { compactThresholds, pruneThresholds } from '../compact/constants.js'
import { getToolArtifactThreshold } from '../tools/artifact-threshold.js'
import { extractTrailingArtifactId } from './tool-result-tiering.js'
import { truncateToolResult } from './tool-result-truncate.js'
import { getStarSignature } from './star-signature.js'
import type { ImmuneHook } from './immune-hook.js'
import { detectMistakeResolution } from './mistake-detector.js'
import { isToolAllowedInReliabilityMode, reliabilityBlockMessage, type ReliabilityDecision } from './reliability-mode.js'
import type { ArtifactStore } from '../artifact/store.js'
import type { CacheAdvisor } from '../cache/advisor.js'
import type { TaskLedger } from './task-ledger.js'
import type { P3Integration } from './p3-integration.js'
import { buildCommitNudge } from './commit-nudge.js'
import { evaluateTddGate, parseTddGateConfig, EDIT_TOOLS, type TddGateConfig } from './tdd-gate.js'
import { checkPlanMode } from './plan-mode.js'
import { buildSensitivePreflightMessage, shouldRequireSensitivePreflight } from './sensitive-preflight.js'
import { toolTargetFromInput } from './tool-target.js'

/** Extract artifact ID from content if it starts with [artifact:ID] */
function extractArtifactId(content: string): string | undefined {
  const m = content.match(/^\[artifact:([^\]]+)\]/)
  return m?.[1]
}

/** Failure classes that trigger onPhaseChange('blocked') — user-visible state. */
const BLOCKED_CLASSES: ReadonlySet<string> = new Set([
  'context_window_exceeded',
  'api_error',
  'permission_denied',
])

const DEFAULT_TOOL_TIMEOUT_MS = 120_000 // 2 minutes

/** TDD gate config — parsed once from env at module load. */
const _TDD_GATE_CONFIG: TddGateConfig = parseTddGateConfig()

/** Tools that may mutate the workspace and therefore open the rollback window. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'apply_patch', 'bash',
])
function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name)
}

function sortedInputKeys(input: Record<string, unknown>): string[] {
  return Object.keys(input).sort()
}

function toolInputTraceDebugEnabled(): boolean {
  return process.env.RIVET_DEBUG_TOOL_INPUT === '1'
}

function shouldEmitToolInputTrace(
  toolName: string,
  beforeHookKeys: string[] | undefined,
  afterHookKeys: string[] | undefined,
  afterRepairKeys: string[] | undefined,
): boolean {
  if (toolInputTraceDebugEnabled()) return true
  if (toolName !== 'grep') return false
  return !beforeHookKeys?.includes('pattern') ||
    !afterHookKeys?.includes('pattern') ||
    !afterRepairKeys?.includes('pattern')
}

async function emitToolInputTrace(input: { cwd: string; sessionId?: string; message: string }): Promise<void> {
  if (debugEnabled()) {
    debugLog(input.message)
    return
  }
  try {
    const sessionDir = input.sessionId
      ? join(getSessionDir(input.cwd), input.sessionId)
      : join(getSessionDir(input.cwd), 'unknown')
    await mkdir(sessionDir, { recursive: true })
    await appendFile(join(sessionDir, 'tool-input-trace.jsonl'), `${input.message}\n`, 'utf8')
  } catch {
    // Diagnostics must never affect tool execution or pollute model-visible output.
  }
}

/**
 * File tools whose path operand may target a path outside the workspace, with
 * the access mode they need. Used to gate out-of-workspace file ops behind an
 * approval-driven path grant (rather than a hard "Path outside workspace" error).
 * `read_section` is artifact-id based and `apply_patch` embeds paths in a patch
 * body — neither has a single extractable path, so they rely on request_path_access.
 */
const FILE_TOOL_MODES: Record<string, 'read' | 'write'> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'write',
  hash_edit: 'write',
}

/**
 * Resolve the absolute paths a file tool would touch that currently fall OUTSIDE
 * the workspace and are not yet covered by a grant. Empty when in-workspace or
 * already granted (validatePathSafe consults the grant store).
 */
function outOfWorkspaceFilePaths(cwd: string, toolName: string, input: Record<string, unknown>): { mode: 'read' | 'write'; paths: string[] } | null {
  const mode = FILE_TOOL_MODES[toolName]
  if (!mode) return null
  const candidates: string[] = []
  if (typeof input.file_path === 'string') candidates.push(input.file_path)
  if (Array.isArray(input.file_paths)) {
    for (const p of input.file_paths) if (typeof p === 'string') candidates.push(p)
  }
  const paths: string[] = []
  for (const c of candidates) {
    if (!validatePathSafe(cwd, c, mode).ok) paths.push(resolvePath(cwd, c))
  }
  return paths.length > 0 ? { mode, paths } : null
}

/** Build a cross-session ownership guard from the live session registry, if any. */
function buildOwnershipGuard(deps: {
  cwd: string
  config: { sessionRegistry?: ClaimLookup; sessionId?: string }
}): OwnershipGuard | undefined {
  const registry = deps.config.sessionRegistry
  const sessionId = deps.config.sessionId
  if (!registry || !sessionId) return undefined
  return makeOwnershipGuard(registry, sessionId, deps.cwd)
}

function withToolTimeout<T>(
  promise: Promise<T>,
  toolName: string,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutController?: AbortController,
): Promise<T> {
  // Guard against NaN/Infinity/negative timeout (e.g. parameter misplacement bugs)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS
 }
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Cascade abort to the underlying op (child proc / fetch) BEFORE rejecting,
      // so the tool stops consuming resources instead of orphaning.
      try { timeoutController?.abort() } catch { /* noop */ }
      reject(new Error(`Tool ${toolName} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e) },
    )
 })
}

export interface ToolPipelineDeps {
  config: AgentConfig
  cwd: string
  harness: TurnHarness
  prewarm: PrewarmCache
  evidence: EvidenceTrackerPublic
  traceStore: TraceStore
  repairHintTracker: RepairHintTracker
  repairPipeline: import('./repair-pipeline.js').RepairPipeline
  importGraph: ImportGraph | null
  /** Meridian indexer — when available, edit impact tracking prefers the
   *  persisted SQLite reverse BFS over the in-memory import-graph. */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
  lastConflictCheckCount: number
  trajectory: { getEntries(): { tool: string; target: string; status: string; errorClass?: string }[] }
  getDoomLoopLevel(): import('./trace-store.js').DoomLoopLevel
  /** Whether goal mode is active — relaxes doom-loop thresholds when true. */
  isGoalActive?: boolean
  latestRisk: import('./approval-risk.js').RiskAssessment
  sessionTurnCount: number
  sessionId: string | undefined
  abortSignal?: AbortSignal
  /** Capture an agent's departure mark (leave_mark tool) for 主控 to record at close. */
  onLeaveMark?: (mark: import('../tools/types.js').LeaveMarkInput) => void
  /** U6/C1: capture goal decomposition from plan_steps into the loop's PlanExecutionTrace. */
  onPlanSteps?: (steps: import('../tools/types.js').PlanStepInput[]) => void
  /** Write a constellation milestone when plan_close succeeds with apply=true. */
  onPlanClosed?: (input: import('../tools/types.js').PlanClosedInput) => void
  /** Called when the model explicitly loads a skill via the skill tool. */
  onSkillInvoked?: (name: string) => void
  /** Called when the model explicitly marks a skill as complete via the skill tool. */
  onSkillCompleted?: (name: string) => void
  recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, content: string, errorClass?: ToolErrorClass): void
  getInterventionLevel?(): InterventionLevel
  recordPrediction?(correct: boolean): void
  /** Current sensorium snapshot — enables confidence-driven adaptive approval. */
  getSensorium?(): Sensorium | null
  /** Current reliability mode decision — blocks risky tools before approval/execution. */
  getReliabilityDecision?(): ReliabilityDecision | null
  /** Turn-level token budget — degrades tool results when exhausted. */
  turnBudget: TurnBudget
  /** Artifact store for persisting tool output — injected via params, no global setter */
  artifactStore?: import('../artifact/store.js').ArtifactStore
  /** Session-scoped background job registry — forwarded to bash / job tools. */
  jobs?: import('../tools/job-store.js').JobRegistry
  /** Immune system hook for recording repair success (failed→passed transitions) */
  immuneHook?: ImmuneHook
  /** Optional cache advisor for adaptive artifact thresholds */
  cacheAdvisor?: CacheAdvisor
  /** Phase hint passed to cache advisor (e.g. 'explore', 'execute', 'verify'). Defaults to 'execute'. */
  phaseHint?: string
  /** Optional TaskLedger for B1 ownership tracking */
  taskLedger?: TaskLedger
  /** Optional OwnershipLedger for real-time file ownership registration */
  ownershipLedger?: import('./ownership-ledger.js').OwnershipLedger
  /** VSW: session-scoped snapshot manager. Consulted before run_tests to decide
   *  isolated (Phase A) + integration (Phase B) verification vs in-place. */
  verificationSnapshotManager?: import('./verification-snapshot-manager.js').VerificationSnapshotManager
  /** Optional SessionRegistry for cross-session file claim coordination */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** P3 integration facade for speculative execution + mistake hints */
  p3?: P3Integration
  /** Turn-scoped accumulator: artifact IDs evicted (created by artifactIntercept) */
  artifactIdsEvicted?: string[]
  /** Turn-scoped accumulator: artifact IDs accessed (read_section calls) */
  artifactIdsAccessed?: string[]
  /** Optional LSP manager — notified on file changes for goto-def / find-refs accuracy */
  lspManager?: LspManager
  /** 破坏性命令 pre-execution 闸门(会话级状态,loop 持有)。pipeline 是唯一
   *  写者(noteVerification/noteToolExecuted)兼唯一读者(evaluate)。 */
  destructiveGate?: import('../tools/destructive-gate.js').DestructiveGateState
  /** T4: late-bound LSP manager getter. Checked first, falls back to `lspManager`.
   *  Enables T9 path where LSP initializes asynchronously after AgentLoop construction. */
  getLspManager?: () => LspManager | null
}

export interface ToolExecResult {
  toolResult: ContentBlock
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  checkpointCreated: boolean
  latestRisk: import('./approval-risk.js').RiskAssessment
  /** True when the tool returned endTurn: true (e.g. ask_user_question). */
  endTurn?: boolean
}

function truncateSuccessfulToolResult(content: string, config: AgentConfig): string {
  return truncateToolResult(content, compactThresholds({
    contextWindow: config.contextWindow ?? 1_000_000,
    providerProfile: config.providerProfile,
 }).toolResultMaxTokens)
}

/**
 * Artifact intercept: if content exceeds threshold and artifactStore is available,
 * persist to disk and replace with a compact reference. This keeps message history
 * append-only (no future truncation) → maximizes DeepSeek prefix cache hit rate.
 *
 * Tools that already return artifact refs (read_file, grep, bash) are detected by
 * the `[artifact:` prefix and skipped.
 */
const ARTIFACT_INTERCEPT_THRESHOLD = 2500 // chars — success results (raised from 800; review workflows need more inline content)
const ARTIFACT_ERROR_THRESHOLD = 1600 // chars — error results need more inline context for debugging

/**
 * Tools whose output MUST reach the model complete and inline — never replaced by
 * a lossy artifact summary, nor head/tail truncated, nor collapsed to a budget
 * preview. The `skill` tool loads a skill's full instructions that the model
 * explicitly asked for and will follow verbatim; a summary or a truncated middle
 * would make it act on partial/wrong instructions and force a whole-session redo
 * (fidelity is the #1 priority over context cleanliness). Unlike read tools,
 * `skill` has no offset/section param, so any truncation is unrecoverable. Heavy
 * reference material is split into sub-files (Tier-3) read on demand via
 * read_file (which DOES page), so the SKILL.md body stays bounded by author
 * convention and is safe to deliver in full.
 */
const FIDELITY_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['skill'])

/** Tools that perform their own L0 artifact wrapping (inside the tool impl) and
 *  emit a trailing [artifact:id] marker. L1 must NOT re-wrap their output:
 *  - read_file / read_section: content the model explicitly requested; re-wrap
 *    turns every recovery into [artifact:NEW_ID] -> read_section(NEW_ID) -> ...
 *    an infinite nesting loop (tianshu v4 pro post-mortem 2026-05-25).
 *  - grep / bash: L0 wraps at its own threshold with a trailing marker; the old
 *    startsWith('[artifact:') check missed the trailing marker and re-saved the
 *    already-truncated string (L0->L1 double-save bug). */
const L0_WRAPPED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'grep', 'bash',
])

function isDietNoInfoReadResult(content: string): boolean {
  return content.includes('[diet:redundant]') || content.includes('[diet:useless]')
}

function countRecentReadLoopPlaceholders(
  entries: { tool: string; target: string; status: string; errorClass?: string; resultSummary?: string }[],
  target: string,
): number {
  return entries
    .slice(-8)
    .filter(entry =>
      entry.tool === 'read_file'
      && entry.target === target
      && isDietNoInfoReadResult(entry.resultSummary ?? ''),
    ).length
}

function buildReadLoopStrategySignal(
  toolName: string,
  target: string,
  content: string,
  priorNoInfoReads: number,
): string | null {
  if (toolName !== 'read_file') return null
  if (!isDietNoInfoReadResult(content)) return null
  if (priorNoInfoReads < 1) return null

  const targetLabel = target.length > 80 ? `${target.slice(0, 77)}...` : target
  return [
    '',
    '[策略信号：读取循环]',
    `这次 read_file 没有提供新信息。不要继续立刻读取 ${targetLabel}；请切换到 grep / repo_graph / ask_user_question，或说明为什么必须再次读取。`,
  ].join('\n')
}

async function artifactIntercept(
  content: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  artifactStore: ArtifactStore | undefined,
  isError = false,
  thresholdOverride?: number,
  remainingBudgetFraction?: number,
  contextWindow?: number,
): Promise<string> {
  if (!artifactStore) return content

  // Tools with their own L0 wrapping must not be re-intercepted here.
  if (L0_WRAPPED_TOOLS.has(toolName)) return content
  // Belt-and-suspenders: never re-wrap content that already ends in an artifact
  // ref (covers any future L0-wrapping tool not yet listed above). Uses the
  // shared trailing-marker convention, not startsWith — the marker is at the END.
  if (extractTrailingArtifactId(content)) return content

  let threshold = thresholdOverride ?? (isError ? ARTIFACT_ERROR_THRESHOLD : ARTIFACT_INTERCEPT_THRESHOLD)

  // Context-window-aware floor for SUCCESS results: align with L0 (per-tool)
  // artifact wrapping in read-file/bash/grep, which uses pruneThresholds.minChars.
  // Without this floor, cacheAdvisor.getArtifactThreshold (capped at MAX_ARTIFACT=4000)
  // and the static 2500-char fallback both wrap medium-sized outputs (delegate_batch
  // 14K, sandbox_exec 5K, bash sed 8K) even on a 1M window. Tianshu v4 pro's
  // post-mortem identified this as the L1 layer of the four-layer compression
  // architecture — small enough to misfire on every interesting tool result.
  // Errors keep the original behavior: stack traces below ~30K are useful inline,
  // and we want larger error blobs (e.g. 200K test output) to still be intercepted.
  if (!isError && contextWindow != null) {
    const floor = getToolArtifactThreshold(toolName, contextWindow)
    threshold = Math.max(threshold, floor)
 }

  // Budget-aware scaling: when context budget is ample, inline more aggressively
  if (remainingBudgetFraction != null) {
    if (remainingBudgetFraction > 0.5) {
      threshold = Math.max(threshold, threshold * 3) // plenty of room → 3x threshold
   } else if (remainingBudgetFraction > 0.3) {
      threshold = Math.max(threshold, threshold * 1.5) // moderate room → 1.5x
   }
    // < 0.3 → use base threshold (context is getting tight)
 }

  if (content.length <= threshold) {
    debugLog(`[artifact-intercept-skip] tool=${toolName} len=${content.length} threshold=${threshold} isError=${isError}`)
    return content
 }
  // Determine target label for the artifact
  const target = typeof toolInput.file_path === 'string'
    ? toolInput.file_path
    : typeof toolInput.path === 'string'
      ? toolInput.path
      : typeof toolInput.command === 'string'
        ? (toolInput.command as string).slice(0, 80)
        : typeof toolInput.pattern === 'string'
          ? toolInput.pattern
          : typeof toolInput.url === 'string'
            ? toolInput.url
            : toolName

  // Generate a simple summary based on tool type
  const summary = generateToolSummary(content, toolName, toolInput)

  try {
    const artifactId = await artifactStore.save({
      tool: toolName,
      target: target as string,
      rawContent: content,
      summary,
      sections: [],
   })

    // For errors, include a head excerpt so the model can debug without read_section
    const headExcerpt = isError ? `\n${extractErrorHead(content)}` : ''
    return `[artifact:${artifactId}] ${summary}${headExcerpt}\nUse read_section(artifactId="${artifactId}", section="L1-L200") to expand.`
 } catch {
    // Graceful degradation: if disk write fails, return original content
    // and let downstream truncation handle it
    return content
 }
}

/** Extract the most diagnostic lines from error output (max ~600 chars). */
function extractErrorHead(content: string): string {
  const lines = content.split('\n')
  // Prioritize lines with error/fail keywords — use word boundaries to avoid matching identifiers like errorHandler
  const errorLines = lines.filter(l => /\b(?:error|Error|FAIL|AssertionError|TypeError|ReferenceError)\b|expect\(/.test(l))
  if (errorLines.length > 0) {
    return errorLines.slice(0, 8).map(l => l.trim().slice(0, 120)).join('\n')
 }
  // Fallback: last 8 lines (often contain the summary)
  return lines.slice(-8).map(l => l.trim().slice(0, 120)).join('\n')
}

function generateToolSummary(content: string, toolName: string, input: Record<string, unknown>): string {
  const lines = content.split('\n')
  const lineCount = lines.length
  const charCount = content.length

  switch (toolName) {
    case 'run_tests': {
      // Extract test summary from content
      const testLine = lines.find(l => /tests?\s*(?:pass|passed|fail|failed)|total/i.test(l))
        ?? lines.find(l => /\d+\s+pass/i.test(l))
      const errorLines = lines.filter(l => /error|Error|FAIL/i.test(l)).slice(0, 2)
      const parts = [`[run_tests] ${lineCount} lines.`]
      if (testLine) parts.push(testLine.trim())
      if (errorLines.length > 0) parts.push(`Errors: ${errorLines.map(l => l.trim().slice(0, 60)).join('; ')}`)
      return parts.join(' ')
   }
    case 'diff': {
      const files = lines.filter(l => l.startsWith('diff --git')).map(l => {
        const m = l.match(/b\/(.+)$/)
        return m ? m[1] : ''
     }).filter(Boolean)
      return `[diff] ${files.length} files changed, ${lineCount} lines. Files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5})` : ''}`
   }
    case 'glob': {
      const matches = lines.filter(l => l.trim())
      const pattern = typeof input.pattern === 'string' ? input.pattern : '?'
      return `[glob "${pattern}"] ${matches.length} files found. First: ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? ` (+${matches.length - 3})` : ''}`
   }
    case 'web_fetch': {
      const url = typeof input.url === 'string' ? input.url : '?'
      return `[web_fetch ${url}] ${charCount} chars, ${lineCount} lines fetched.`
   }
    case 'repo_map': {
      return `[repo_map] ${lineCount} lines. ${lines.find(l => /\d+ files/.test(l))?.trim() ?? `${lineCount} entries`}`
   }
    case 'inspect_project': {
      return `[inspect_project] ${lineCount} lines of project analysis.`
   }
    case 'bash': {
      const cmd = typeof input.command === 'string' ? input.command.slice(0, 80) : '?'
      // Detect test/typecheck output
      if (/\b(tsc|typecheck|type-check)\b/.test(cmd)) {
        const errorCount = lines.filter(l => /error TS\d+/.test(l)).length
        return `[bash typecheck] ${errorCount} errors, ${lineCount} lines. cmd: ${cmd}`
     }
      if (/\b(test|jest|vitest|mocha|pytest)\b/.test(cmd)) {
        const passLine = lines.find(l => /pass|fail|tests?\s+\d+/i.test(l))?.trim().slice(0, 80) ?? ''
        return `[bash test] ${lineCount} lines. ${passLine} cmd: ${cmd}`
     }
      return `[bash] ${charCount} chars, ${lineCount} lines. cmd: ${cmd}`
   }
    default: {
      // Generic: first meaningful line + stats
      const firstLine = lines.find(l => l.trim().length > 10)?.trim().slice(0, 80) ?? ''
      return `[${toolName}] ${charCount} chars, ${lineCount} lines. ${firstLine}`
   }
 }
}

export async function executeToolUse(
  tu: { id: string; name: string; input: Record<string, unknown> },
  deps: ToolPipelineDeps,
  callbacks: AgentCallbacks,
  turn: number,
  checkpointAlreadyCreated: boolean,
): Promise<ToolExecResult> {
  let { traceStore, importGraph, lastConflictCheckCount, latestRisk } = deps
  let checkpointCreated = checkpointAlreadyCreated

  // Canonicalize foreign tool aliases (task/agent/todowrite → Rivet names)
  // BEFORE any gate runs. Every downstream policy — plan-mode whitelist, deny
  // rules, approval, risk assessment, TDD gate — keys on tu.name; resolving
  // aliases inside registry.execute (after the gates) would let e.g. a deny
  // rule on `delegate_task` be bypassed by calling `task`.
  const canonicalToolName = deps.config.toolRegistry.resolveName(tu.name)
  const aliasNote = canonicalToolName !== tu.name
    ? `[NOTE: "${tu.name}" 自动映射为 "${canonicalToolName}" — 下次请直接调 ${canonicalToolName}]`
    : undefined
  if (canonicalToolName !== tu.name) {
    tu = { ...tu, name: canonicalToolName }
  }

  const params: ToolCallParams = {
    input: tu.input,
    toolUseId: tu.id,
    cwd: deps.cwd,
    onOutput: (chunk) => {
      callbacks.onToolResult(tu.id, tu.name, chunk)
   },
    // P6 follow-up: let tools (e.g. ast-edit) register internal file writes
    // so evidence/filesModified and cerebellar gate are aware.
    onFileWrite: (filePath) => deps.evidence.trackFileModified(filePath),
    // T4: structured per-worker delegation updates → subagent panel. Optional;
    // forwarded to the session layer alongside the text progress stream.
    onWorkerActivity: callbacks.onDelegationActivity
      ? (activity) => callbacks.onDelegationActivity!(activity)
      : undefined,
    onLeaveMark: deps.onLeaveMark,
    onPlanSteps: deps.onPlanSteps,
    onPlanClosed: deps.onPlanClosed,
    onSkillInvoked: deps.onSkillInvoked,
    onSkillCompleted: deps.onSkillCompleted,
    sessionModifiedFiles: [...deps.evidence.getState().filesModified],
    ownedFiles: deps.ownershipLedger?.getOwnedFiles(),
    baselineHead: deps.ownershipLedger?.getBaselineHead(),
    artifactStore: deps.artifactStore,
    jobs: deps.jobs,
    prewarmCache: deps.prewarm,
    contextWindow: deps.config.contextWindow,
    providerProfile: deps.config.providerProfile,
    sessionTurnCount: deps.sessionTurnCount,
    sessionId: deps.config.sessionId,
    reviewDepth: deps.config.reviewDepth,
    delegationDepth: deps.config.delegationDepth,
    abortSignal: deps.abortSignal,
    activePlanFilePath: deps.config.activePlanFilePath,
 }

  // Star signature: counter training-mode regression at token level (思路 E)
  const starSig = getStarSignature(tu.name)

  try {
    // Cerebellar Loop: read-before-edit gate
    const intervention = deps.getInterventionLevel?.() ?? 'none'
    if ((intervention === 'gate' || intervention === 'escalate') && (tu.name === 'edit_file' || tu.name === 'write_file')) {
      const recentReads = deps.trajectory.getEntries().slice(-3).some(e => e.tool === 'read_file')
      if (!recentReads) {
        const gateMsg = `Tool blocked by cerebellar gate: recent prediction error rate is elevated. Read the file before editing to ensure mental model is current.`
        callbacks.onToolResult(tu.id, tu.name, gateMsg, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: gateMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
     }
   }

    // TDD Gate: block edit/write tools when the model has edited files
    // without running tests. Pure decision function, stateless — the
    // EvidenceTracker holds the edit counter and test-verification log.
    const tddConfig: TddGateConfig = deps.config.tddGate ?? _TDD_GATE_CONFIG
    if (tddConfig.enabled && EDIT_TOOLS.has(tu.name)) {
      const gateState = deps.evidence.getGateState()
      const decision = evaluateTddGate(gateState, tu.name, tddConfig)
      if (decision.action === 'block') {
        callbacks.onToolResult(tu.id, tu.name, decision.message!, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: decision.message!, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
     }
   }

    // Destructive gate: 验证失败后 ≤3 个工具调用内的 git 清场命令当轮拦截
    // (首次拦截、原样重发放行)。TDD gate 之后、PreToolUse hook 之前。
    if (deps.destructiveGate && tu.name === 'bash') {
      const gateDecision = deps.destructiveGate.evaluate(tu.name, tu.input as Record<string, unknown>)
      if (gateDecision.block) {
        const blockedAt = Date.now()
        traceStore = recordTraceEvent(traceStore, {
          id: `${tu.id}:destructive-gate`,
          turn,
          kind: 'tool',
          name: 'destructive-gate:block',
          status: 'failed',
          startedAt: blockedAt,
          endedAt: blockedAt,
          durationMs: 0,
          summary: String((tu.input as Record<string, unknown>).command ?? '').slice(0, 200),
        })
        callbacks.onToolResult(tu.id, tu.name, gateDecision.message, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: gateDecision.message, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
      }
    }

    const shouldSampleToolInput = toolInputTraceDebugEnabled() || tu.name === 'grep'
    const beforeHookKeys = shouldSampleToolInput ? sortedInputKeys(tu.input) : undefined

    // PreToolUse hook
    const preHookResult = deps.config.hooks?.firePreToolUse({ toolName: tu.name, input: tu.input as Record<string, unknown> }) ?? {}
    if (preHookResult.block) {
      const blockMsg = `Tool blocked by hook: ${preHookResult.reason ?? 'no reason given'}`
      callbacks.onToolResult(tu.id, tu.name, blockMsg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: blockMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
   }
    if (preHookResult.input) {
      tu.input = preHookResult.input
      params.input = preHookResult.input
   }
    const afterHookKeys = shouldSampleToolInput ? sortedInputKeys(tu.input) : undefined

    // Multi-pass tool input repair
    const toolDef = deps.config.toolRegistry.get(tu.name)
    if (toolDef) {
      const repairResult = deps.repairPipeline.run(
        tu.input as Record<string, unknown>,
        { toolName: tu.name, schema: toolDef.definition.input_schema },
      )
      if (repairResult.telemetry.length > 0) {
        tu.input = repairResult.output
        params.input = repairResult.output
        const repairSummary = summarizeRepairTelemetry(repairResult.telemetry)
        if (repairSummary) {
          const now = Date.now()
          traceStore = recordTraceEvent(traceStore, {
            id: `${tu.id}:repair`,
            turn,
            kind: 'tool',
            name: `${tu.name}:repair`,
            status: 'passed',
            startedAt: now,
            endedAt: now,
            durationMs: 0,
            summary: repairSummary,
         })
       }
     }
   }
    const afterRepairKeys = shouldSampleToolInput ? sortedInputKeys(tu.input) : undefined

    // Reliability mode gate — Phase 2 degraded/minimal executor.
    const reliabilityDecision = deps.getReliabilityDecision?.() ?? null
    if (reliabilityDecision && !isToolAllowedInReliabilityMode(reliabilityDecision.mode, tu.name, tu.input)) {
      const msg = reliabilityBlockMessage(reliabilityDecision, tu.name)
      callbacks.onToolResult(tu.id, tu.name, msg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
   }

    // Strategy shift + doom loop check
    const trajectorySummary: TrajectorySummary[] = deps.trajectory.getEntries().map(e => ({
      tool: e.tool,
      target: e.target,
      status: e.status === 'retried-failed' || e.status === 'failed' ? 'failed' : 'success',
      errorClass: e.errorClass,
   }))
    const doomLevel = deps.getDoomLoopLevel()
    const hint = suggestStrategyShift(trajectorySummary, doomLevel)
    if (doomLevel === 'blocked') {
      // Block ONLY repeats of the call(s) that are actually looping — not every
      // tool. The looping fingerprints are recorded with outputClass 'error'
      // (a passing call breaks the loop and wouldn't be blocked), so compare the
      // current call's error-variant fingerprint against the offenders. Letting
      // different tools/inputs through is what refreshes the window out of
      // 'blocked'; blocking everything deadlocks the turn (blocked calls are
      // never recorded, so the window never changes — see offendingFingerprints).
      const goalActive = deps.isGoalActive ?? false
      const thresholds = getDoomLoopThresholds(goalActive)
      const exactOffenders = offendingFingerprints(traceStore.toolFingerprints, thresholds.exact.window, thresholds.exact.blockFreq, thresholds.exact.blockConsec)
      const classOffenders = offendingFingerprints(traceStore.bashClassFingerprints ?? [], thresholds.class.window, thresholds.class.blockFreq, thresholds.class.blockConsec)
      const curExactFp = fingerprintToolCall(tu.name, tu.input, 'error')
      const curExactFpTransient = fingerprintToolCall(tu.name, tu.input, 'error-transient')
      const curClassFp = fingerprintToolClass(tu.name, tu.input, 'error')
      const isOffendingCall = exactOffenders.has(curExactFp) || exactOffenders.has(curExactFpTransient) || (curClassFp != null && classOffenders.has(curClassFp))

      if (isOffendingCall) {
        const fps = traceStore.toolFingerprints
        const lastFp = fps.at(-1)
        const maxCount = lastFp ? fps.filter(f => f === lastFp).length : 0
        const isTransientLoop = !exactOffenders.has(curExactFp) && exactOffenders.has(curExactFpTransient)
        const baseMsg = hint ?? (isTransientLoop
          ? 'Repeated transient failures (timeout/api error). The operation keeps failing for infra reasons — try a different approach instead of retrying.'
          : 'Repeated identical failures detected.')
        const msg = [
          baseMsg,
          `Tool: ${tu.name} | Consecutive same-pattern failures: ${maxCount} | Fingerprint: ${curExactFp.slice(0, 8)}`,
          isTransientLoop
            ? 'Recovery: the target may be too large or the infra overloaded. Try splitting the task, using a different tool, or reducing scope.'
            : 'Recovery: try a different tool (e.g. read_file, todo), change the input, or modify the target path.',
        ].join('\n')
        callbacks.onToolResult(tu.id, tu.name, msg, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
      }
      // Different tool/input under 'blocked' — let it run. It will be recorded
      // and slide the offending fingerprints out of the detection window.
   }

    // Plan-mode gate — block write tools during planning phase (except active plan file)
    const writePath = (tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string'
      ? tu.input.file_path
      : undefined
    const planModeResult = checkPlanMode(deps.config.planModeState ?? 'off', tu.name, {
      cwd: deps.cwd,
      targetFilePath: writePath,
      activePlanFilePath: deps.config.activePlanFilePath,
    })
    if (!planModeResult.allowed) {
      const planMsg = planModeResult.reason ?? 'Plan Mode: write operations blocked'
      callbacks.onToolResult(tu.id, tu.name, planMsg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? planMsg + starSig : planMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
   }

    // Sensitive-area preflight — nudge, don't block. The model must read the
    // knowledge manifest before editing prompt/memory/recall/verification/ownership
    // paths, but existing approval and edit gates remain responsible for hard safety.
    if (writePath && deps.taskLedger && shouldRequireSensitivePreflight({ path: writePath, events: deps.taskLedger.getEvents() })) {
      callbacks.onToolResult(tu.id, tu.name, buildSensitivePreflightMessage(writePath), false)
   }

    // Approval gate — with sensorium-driven adaptive confidence
    const needsApproval = deps.config.toolRegistry.needsApproval(tu.name, params)
    const antibodies = deps.config.contextClaimStore?.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] }) ?? []
    const sensorium = deps.getSensorium?.() ?? null
    const risk = assessToolRisk(tu.name, tu.input, deps.getDoomLoopLevel(), antibodies, sensorium ?? undefined)
    latestRisk = risk
    const isHighRisk = risk.level === 'high'
    const approvalMode = deps.config.approvalMode ?? 'manual'
    const skipAllApproval = approvalMode === 'dangerously-skip-permissions'

    // Sensorium-driven auto-approve: high confidence + low risk → bypass approval
    const canAutoApprove = sensorium
      && sensorium.confidence >= CONFIDENCE_THRESHOLDS.autoApproveConfidence
      && (risk.level === 'none' || risk.level === 'low')
      && approvalMode === 'auto-safe'

    const allowRules = [
      ...(deps.config.permissions?.allow ?? []),
      ...(deps.config.permissionsOverlay?.allow ?? []),
    ]
    const denyRules = [
      ...(deps.config.permissions?.deny ?? []),
      ...(deps.config.permissionsOverlay?.deny ?? []),
    ]
    const bashAllowPrefixes = [
      ...(deps.config.permissions?.bash?.allowlist ?? []),
      ...(deps.config.permissionsOverlay?.bashAllow ?? []),
    ]
    const bashDenyPrefixes = [
      ...(deps.config.permissions?.bash?.denylist ?? []),
      ...(deps.config.permissionsOverlay?.bashDeny ?? []),
    ]

    // Deny rules always win, even in dangerously-skip-permissions.
    const denied = isToolDenied(tu.name, tu.input, denyRules)
    const bashDenied = tu.name === 'bash' && typeof tu.input.command === 'string'
      ? isBashCommandDenied(tu.input.command, bashDenyPrefixes)
      : false
    if (denied || bashDenied) {
      const reason = `Tool execution denied: ${tu.name} matches an active deny rule`
      callbacks.onToolResult(tu.id, tu.name, reason, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: reason, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
    }

    const allowlisted = isToolAllowed(tu.name, tu.input, allowRules)
    const bashAllowlisted = tu.name === 'bash' && typeof tu.input.command === 'string'
      ? isBashCommandAllowlisted(tu.input.command, bashAllowPrefixes)
      : false
    // Autonomy-first: when a real kernel sandbox boundary is in effect, an
    // in-workspace bash write is safe-by-construction (writes can't escape the
    // workspace, and B2 rollback makes them reversible), so it must NOT
    // interrupt an unattended run for approval. When no sandbox is available we
    // stay fail-closed for risky writes, but auto-safe mode auto-approves safe
    // writes (mkdir/touch/cp/echo>file) to avoid approval fatigue on Windows.
    const noSandbox = !isSandboxActive()
    const bashCommand = tu.name === 'bash' && typeof tu.input.command === 'string' ? tu.input.command : ''
    const safeWriteInNoSandbox = noSandbox
      && approvalMode === 'auto-safe'
      && bashCommand.length > 0
      && isSafeWriteOnly(bashCommand)
    const bashWriteRequiresApproval =
      requiresBashWriteApproval(tu.name, tu.input)
      && !allowlisted && !bashAllowlisted
      && !safeWriteInNoSandbox
      && noSandbox

    // Protection mode: during doom-loop, destructive git actions always require
    // approval. warn is the live window (blocked is short-circuited earlier).
    const protectionMode = deps.getDoomLoopLevel() !== 'none' && isDestructiveGitAction(tu.name, tu.input)

    // Out-of-workspace file op: the path is outside the workspace and not yet
    // granted. Instead of hard-blocking in execute(), route through the approval
    // flow — on approval we record a directory-subtree grant so the op proceeds.
    let pathGrantNeed = outOfWorkspaceFilePaths(deps.cwd, tu.name, tu.input)
    // In dangerously-skip-permissions the user opted out of all prompts: record
    // the grant directly so the op isn't blocked by the path guard.
    if (skipAllApproval && pathGrantNeed) {
      for (const p of pathGrantNeed.paths) grantPath(dirname(p), pathGrantNeed.mode)
      pathGrantNeed = null
    }

    const shouldAsk = skipAllApproval
      ? false
      : pathGrantNeed
        ? true
        : protectionMode
          ? true
          : bashWriteRequiresApproval
            ? true
            : allowlisted
              ? false
              : canAutoApprove
                ? false
                : approvalMode === 'manual'
                  ? needsApproval
                  : approvalMode === 'auto-safe'
                    ? isHighRisk
                    : false

    if (shouldAsk) {
      const approvalResult = await callbacks.onApprovalRequired(tu.id, tu.name, tu.input)
      const resolved: ApprovalResult = typeof approvalResult === 'boolean'
        ? { approved: approvalResult }
        : approvalResult
      const finalInput = applyApprovalEdit(tu.input, resolved)
      if (!finalInput) {
        // Record the denied call's fingerprint so the doom-loop detector can see
        // repeated identical denials. Denied calls short-circuit here, before the
        // post-exec recordToolFingerprint at the bottom, so without this the
        // anti-repeat window never sees them and the model re-emits the same
        // approval-blocked call forever (the classic "requires user approval" loop).
        // Use outputClass 'error' to match the offender fingerprint the doom-loop
        // gate compares against (see the doomLevel === 'blocked' branch above).
        traceStore = recordToolFingerprint(traceStore, fingerprintToolCall(tu.name, tu.input, 'error'), null)
        const target = writePath
          ? ` (${writePath})`
          : tu.name === 'bash' && typeof tu.input.command === 'string'
            ? ` (${tu.input.command.slice(0, 60)})`
            : ''
        // Instructive, non-retry denial: this is NOT a rejection of the change on
        // its merits — it needs explicit user approval the model cannot self-grant.
        // Re-emitting the identical call only re-hits the same gate, so tell the
        // model to stop and hand control back to the user instead of retrying.
        const noSandboxReason = bashWriteRequiresApproval && noSandbox
          ? '\n根因：当前环境无文件系统沙箱（Windows 原生 / 沙箱未启用），写命令需人工审批。这不是命令本身的问题——审批后即可执行。要减少审批频率，可切换到 auto-safe 模式（低风险写命令自动放行）或使用 WSL（Linux 子系统下有沙箱）。'
          : ''
        const denyMsg = [
          `Tool "${tu.name}"${target} was not executed: it requires explicit user approval, which you cannot grant yourself.${noSandboxReason}`,
          'This is NOT a rejection of the change itself. Do NOT re-emit the identical call — repeating it will keep hitting the same approval gate and make no progress.',
          'Instead: briefly state what you were about to do and why it needs approval, then stop and wait for the user to approve it (or adjust their instruction).',
        ].join('\n')
        callbacks.onToolResult(tu.id, tu.name, denyMsg, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: denyMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
     }
      if (finalInput !== tu.input) {
        tu.input = finalInput
        params.input = finalInput
     }
      // Thermocline 2: learn bash command prefix into session allowlist after approval
      if (tu.name === 'bash' && typeof tu.input.command === 'string') {
        learnBashPrefix(tu.input.command, deps.config.permissions)
     }
      // Learn a file-scoped approval so subsequent identical edits to the same
      // file don't re-prompt (a key driver of the "approve → edit → approve
      // again" fatigue that seeds retry loops). Manual mode only — auto-safe must
      // keep re-checking high-risk writes rather than trusting a one-off approve.
      if (approvalMode === 'manual' && (tu.name === 'edit_file' || tu.name === 'write_file') && typeof tu.input.file_path === 'string') {
        learnFileApproval(tu.name, tu.input.file_path, deps.config.permissionsOverlay)
     }
      // Out-of-workspace file op approved: record a directory-subtree grant so
      // both gates (validatePathSafe + sandbox) accept it. Recompute from the
      // (possibly edited) final input so an edited path is granted, not the stale one.
      const approvedGrant = outOfWorkspaceFilePaths(deps.cwd, tu.name, tu.input)
      if (approvedGrant) {
        for (const p of approvedGrant.paths) grantPath(dirname(p), approvedGrant.mode)
      }
   }

    // R2 — concurrent write conflict block (desktop multi-session). When a live
    // SessionRegistry is wired and another active session holds an exclusive
    // claim on the target file, fail-closed: refuse the write instead of
    // clobbering a peer session's in-flight edit. acquireClaim is idempotent for
    // the same session, so an uncontended write also stakes our claim here.
    // Only active when a registry is present — CLI / single-session / no-registry
    // paths are completely unaffected.
    if (
      deps.sessionRegistry &&
      deps.sessionId &&
      (tu.name === 'write_file' || tu.name === 'edit_file') &&
      typeof tu.input.file_path === 'string'
    ) {
      // Normalize to the same key form the post-write claim path uses (relative
      // to cwd when inside the workspace) so claims compare consistently.
      let claimPath = tu.input.file_path
      if (claimPath.startsWith(deps.cwd + '/') || claimPath.startsWith(deps.cwd + '\\')) {
        claimPath = claimPath.slice(deps.cwd.length + 1)
      }
      const acquired = deps.sessionRegistry.acquireClaim(deps.sessionId, claimPath, 'exclusive')
      if (!acquired) {
        const owner = deps.sessionRegistry.checkClaim(claimPath)
        const ownerTag = owner?.sessionId ? `（会话 ${owner.sessionId.slice(0, 8)}）` : ''
        const blockMsg =
          `文件「${claimPath}」正被另一个会话${ownerTag}独占编辑，已阻断本次写入以避免并发冲突。` +
          `请等待对方完成，或改写其它文件。`
        callbacks.onToolResult(tu.id, tu.name, blockMsg, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: blockMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
      }
    }

    // Checkpoint before the first MUTATING tool of the turn. Beyond file edits
    // this now covers bash (and apply_patch): any shell side effect must fall
    // inside the rollback window, so the snapshot baseline has to be taken
    // before bash runs — not only before write_file/edit_file.
    if (isMutatingTool(tu.name) && !checkpointCreated) {
      const cp = await createCheckpoint(deps.cwd, 'auto', deps.config.sessionId)
      checkpointCreated = true
      if (cp) callbacks.onCheckpoint?.(cp.hash)
   }

    if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
      recordAgentTouchedFile(deps.cwd, tu.input.file_path, deps.config.sessionId)
   }

    if (deps.config.fileHistory && (tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
      await deps.config.fileHistory.trackEdit(tu.input.file_path, tu.id)
   }

    // Execute via TurnHarness
    // P3-C: trigger speculative pre-execution for next likely tool
    const toolTarget = toolTargetFromInput(tu.name, tu.input)
    const priorReadLoopPlaceholders = countRecentReadLoopPlaceholders(deps.trajectory.getEntries(), toolTarget)
    deps.p3?.onToolStart(tu.name, toolTarget)

    // P3-C: check if we already have a speculative result for this tool call
    const speculativeHit = deps.p3?.checkSpeculativeCache(tu.name, toolTarget)

    const traceId = tu.id
    traceStore = startTraceEvent(traceStore, {
      id: traceId,
      turn,
      kind: 'tool',
      name: tu.name,
      startedAt: Date.now(),
      summary: JSON.stringify(tu.input).slice(0, 60),
      predictedSuccess: true,
   })
    let rawToolResult: import('../tools/types.js').ToolResult | undefined

    // VSW: for run_tests, ask the snapshot manager whether to isolate. §6 policy
    // decides; in the common single-clean-session case it returns null → params
    // stays unset → in-place single-phase verification (unchanged default). Any
    // failure here degrades to in-place — VSW must never break verification.
    if (tu.name === 'run_tests' && deps.verificationSnapshotManager) {
      try {
        const plan = deps.verificationSnapshotManager.prepare(deps.ownershipLedger?.getOwnedFiles() ?? [])
        if (plan) params.verificationSnapshot = { path: plan.path, snapshotRef: plan.snapshotRef }
      } catch {
        // degrade to in-place
      }
    }

    const harnessResult = await deps.harness.executeTool({
      id: tu.id,
      name: tu.name,
      input: tu.input,
      turn,
      execute: async () => {
        // P3-C: use speculative cache hit if available (read-only tools only)
        if (speculativeHit && (tu.name === 'read_file' || tu.name === 'grep' || tu.name === 'glob')) {
          rawToolResult = { content: speculativeHit }
          return { content: speculativeHit }
       }
        // P5+P6: read_file must always go through real execute to honor the
        // active contextWindow's read cap. The prewarm cache is shared with
        // P3 speculative reads which may have been populated under a different
        // (smaller) cap; serving cached content here would re-introduce the
        // truncation regression. fs.readFile + OS page cache is fast enough.
        const toolTimeout = toolDef?.timeoutMs?.(params) ?? DEFAULT_TOOL_TIMEOUT_MS
        // P0/H1: compose a per-tool timeout AbortController with the loop signal,
        // so a tool-level timeout cascades an abort into the underlying op
        // (child proc / fetch) instead of merely rejecting the wrapper Promise.
        const toolAbort = new AbortController()
        const composedSignal = deps.abortSignal
          ? AbortSignal.any([deps.abortSignal, toolAbort.signal])
          : toolAbort.signal
        const r = await withToolTimeout(
          deps.config.toolRegistry.execute(tu.name, { ...params, abortSignal: composedSignal }),
          tu.name,
          toolTimeout,
          deps.abortSignal,
          toolAbort,
        )
        rawToolResult = r
        return { content: r.content, isError: r.isError }
     },
      classify: (content) => classifyFailure(content).class,
      isConcurrencySafe: toolDef?.isConcurrencySafe() ?? false,
   })

    if (shouldSampleToolInput && shouldEmitToolInputTrace(tu.name, beforeHookKeys, afterHookKeys, afterRepairKeys)) {
      await emitToolInputTrace({
        cwd: deps.cwd,
        sessionId: deps.sessionId,
        message: `[tool-input-trace] id=${tu.id} name=${tu.name} isError=${harnessResult.isError}` +
        ` beforeHook=${JSON.stringify(beforeHookKeys ?? [])}` +
        ` afterHook=${JSON.stringify(afterHookKeys ?? [])}` +
        ` afterRepair=${JSON.stringify(afterRepairKeys ?? [])}`,
      })
    }

    // PostToolUse hook
    const postHookResult = deps.config.hooks?.firePostToolUse({
      toolName: tu.name,
      input: tu.input as Record<string, unknown>,
      result: harnessResult.content,
      isError: harnessResult.isError,
   }) ?? {}
    let finalContent = postHookResult.result ?? harnessResult.content
    // Normalize: strip trailing whitespace to produce stable byte sequences
    // for DeepSeek exact-prefix cache. Non-deterministic trailing whitespace
    finalContent = finalContent.trimEnd()

    // Foreign-alias teaching note: the call was transparently remapped at the
    // pipeline entry; surface the canonical name so the model learns it.
    if (aliasNote) {
      finalContent = `${aliasNote}\n${finalContent}`
    }

    // LSP: notify the language server that a file changed on disk.
    // Must happen BEFORE diagnostics so the server's view is current.
    if (!harnessResult.isError && (tu.name === 'edit_file' || tu.name === 'write_file' || tu.name === 'apply_patch')) {
      (deps.getLspManager?.() ?? deps.lspManager)?.changeFile(tu.input.file_path as string)
   }

    // T4: LSP diagnostics via lspManager (async file-level, ~2s timeout)
    const mgr = deps.getLspManager?.() ?? deps.lspManager
    if (!harnessResult.isError && mgr?.isReady() && shouldRunDiagnostics(tu.name, tu.input.file_path as string | undefined)) {
      try {
        const diagnostics = await mgr.getFileDiagnostics(tu.input.file_path as string)
        if (diagnostics.length > 0) {
          // 作用域收敛: only surface diagnostics from the edit's changed region to
          // the model — out-of-region errors collapse to a one-line nudge and
          // out-of-region warnings are dropped. Whole-file / cross-file type
          // errors are comprehensively caught by the post-commit typecheck-gate
          // (real tsc on all changed files) at delivery. The full list still goes
          // to uiContent so the human sees everything in the tool card.
          const { modelText, uiText } = filterDiagnosticsForEdit(diagnostics, rawToolResult?.changedRanges)
          const uiBase = rawToolResult?.uiContent ?? finalContent
          if (modelText) {
            finalContent = finalContent + `\n\n[LSP Diagnostics]\n${modelText}`
          }
          if (uiText && rawToolResult) {
            rawToolResult.uiContent = `${uiBase}\n\n[LSP Diagnostics]\n${uiText}`
          }
        }
      } catch {
        // Silent: LSP diagnostics are best-effort, never fail the turn
      }
   }

    // Capture bash/shell side effects into the rollback window. The per-edit
    // recorder above only sees write_file/edit_file; bash can create, delete or
    // rewrite arbitrary files. We diff the worktree against the turn's snapshot
    // baseline and attribute the changes to THIS session — never to paths a
    // different live session exclusively owns (parallel-branch safety).
    if (!harnessResult.isError && tu.name === 'bash' && checkpointCreated) {
      try {
        const guard = buildOwnershipGuard(deps)
        const bashCommand = typeof tu.input?.command === 'string' ? tu.input.command : undefined
        await recordBashSideEffects(deps.cwd, deps.config.sessionId, guard, bashCommand)
      } catch { /* best-effort: capture failure must not fail the turn */ }
    }

    if (!harnessResult.isError) {
      if (FIDELITY_EXEMPT_TOOLS.has(tu.name)) {
        // Fidelity-first: deliver the skill instructions verbatim. We still
        // account for the budget so later tools see the cost, but we never
        // rewrite the content (no artifact summary, no truncation, no preview).
        deps.turnBudget.consume(Math.ceil(finalContent.length / 4))
      } else {
        // Artifact intercept: persist long output to disk, replace with compact ref.
        // This must run BEFORE truncation — if we store an artifact, truncation is unnecessary.
        const successThreshold = deps.cacheAdvisor?.getArtifactThreshold(deps.phaseHint ?? 'execute', false)
        const budgetFraction = deps.turnBudget.maxTokensPerTurn > 0
          ? 1 - (deps.turnBudget.usedTokens / deps.turnBudget.maxTokensPerTurn)
          : 1
        finalContent = await artifactIntercept(finalContent, tu.name, tu.input, deps.artifactStore, false, successThreshold, budgetFraction, deps.config.contextWindow)
        // Track eviction for GhostRegistry
        const evictedId = extractArtifactId(finalContent)
        if (evictedId) deps.artifactIdsEvicted?.push(evictedId)
        finalContent = truncateSuccessfulToolResult(finalContent, deps.config)
        const contentChars = finalContent.length
        const tokenEstimate = Math.ceil(contentChars / 4)
        deps.turnBudget.consume(tokenEstimate)
        if (deps.turnBudget.isExhausted()) {
          const preview = finalContent.slice(0, 500)
          const refPath = rawToolResult?.rawPath ?? 'unknown'
          finalContent = `<stored ref="${refPath}" chars=${contentChars} tool="${tu.name}">\n${preview}\n...(turn budget exceeded — use read_file with offset/limit for full content)</stored>`
        }
      }
   } else {
      // Error results can also be very long (e.g. failed test output).
      // Artifact-intercept them too to keep message history append-only.
      const errorThreshold = deps.cacheAdvisor?.getArtifactThreshold(deps.phaseHint ?? 'execute', true)
      const budgetFraction = deps.turnBudget.maxTokensPerTurn > 0
        ? 1 - (deps.turnBudget.usedTokens / deps.turnBudget.maxTokensPerTurn)
        : 1
      finalContent = await artifactIntercept(finalContent, tu.name, tu.input, deps.artifactStore, true, errorThreshold, budgetFraction, deps.config.contextWindow)
      // Track eviction for GhostRegistry (error artifacts too)
      const evictedErrId = extractArtifactId(finalContent)
      if (evictedErrId) deps.artifactIdsEvicted?.push(evictedErrId)

      // P3-A: inject mistake hints for known error patterns
      if (deps.p3) {
        const hints = deps.p3.getMistakeHints(finalContent.slice(0, 300), `${tu.name} ${toolTarget}`)
        if (hints) finalContent = finalContent + '\n' + hints
     }
   }

    const readLoopSignal = buildReadLoopStrategySignal(tu.name, toolTarget, finalContent, priorReadLoopPlaceholders)
    if (readLoopSignal) finalContent = `${finalContent}${readLoopSignal}`

    // Trace recording
    traceStore = finishTraceEvent(traceStore, traceId, {
      status: harnessResult.isError ? 'failed' : 'passed',
      endedAt: Date.now(),
      summary: harnessResult.content.slice(0, 100),
   })
    // Record prediction outcome for the cerebellar prediction loop.
    // In verify phase (kaiyang-testing), run_tests returning RED is expected
    // TDD behavior — an information gain, not a cognitive prediction failure.
    // Skipping prediction recording here prevents the phasic penalty feedback
    // loop that causes "信心 0%" self-fulfilling doubt during TDD cycles.
    const isTestRun = tu.name === 'run_tests'
    const isVerifyPhase = (deps.phaseHint ?? 'execute') === 'verify'
    const isTddRed = isTestRun && isVerifyPhase && harnessResult.isError
    // Environment-class failures (command-not-found on the host — endemic on
    // Windows where `python`/POSIX tools are simply absent) are NOT competence
    // failures. Recording them as prediction errors craters momentum/EFE and trips
    // the cerebellar prediction-error gate, making the agent timid (低信念 → 不敢做事).
    // Skip prediction recording entirely, exactly like TDD-red information gain.
    const isEnvFailure = harnessResult.isError && rawToolResult?.errorClass === 'environment'
    if (!isTddRed && !isEnvFailure) {
      deps.recordPrediction?.(!harnessResult.isError)
   }
    let outputClass: string
    if (!harnessResult.isError) {
      outputClass = 'success'
    } else {
      const fc = classifyFailure(harnessResult.content)
      outputClass = isTransient(fc.class) ? 'error-transient' : 'error'
    }
    const fp = fingerprintToolCall(tu.name, tu.input, outputClass)
    // bash 类指纹：sed/head/python/tee 变体归并为同一命令类，堵 doom-loop 漏检
    const classFp = fingerprintToolClass(tu.name, tu.input, outputClass)
    traceStore = recordToolFingerprint(traceStore, fp, classFp)

    // P3-A: write path — when a tool resolves a prior failure of itself,
    // record the mistake into MistakeNotebook so getMistakeHints can find
    // it next time. Read path is already wired above (line ~558).
    if (!harnessResult.isError && deps.p3) {
      const resolution = detectMistakeResolution(traceStore, traceId, tu.name)
      if (resolution) {
        try {
          const inputDigest = JSON.stringify(tu.input).slice(0, 200)
          deps.p3.recordMistake(
            resolution.error,
            resolution.context,
            inputDigest,
            [tu.name],
          )
       } catch { /* non-critical: notebook learning is best-effort */ }

        // Immune adaptive learning: record successful repair fingerprint
        if (deps.immuneHook) {
          try {
            const fingerprint = `${tu.name}:${JSON.stringify(tu.input).slice(0, 100)}`
            deps.immuneHook.recordRepairSuccess(
              fingerprint,
              { type: 'quarantine', targetFile: undefined },
              turn,
            )
         } catch { /* non-critical: immune learning is best-effort */ }
       }
     }
   }

    callbacks.onToolResult(tu.id, tu.name, finalContent, harnessResult.isError, rawToolResult?.rawPath, rawToolResult?.uiContent)

    deps.recordToolHistory(tu.name, tu.input, harnessResult.isError, harnessResult.content, rawToolResult?.errorClass)

    // Destructive gate 窗口计数:只数实际执行到这里的工具(被拦截的调用在
    // evaluate 处已短路返回,不计数,窗口保持)。
    deps.destructiveGate?.noteToolExecuted()

    // B1 归属星轨：record tool events into TaskLedger
    if (deps.taskLedger) {
      let filePath = (tu.input.file_path ?? tu.input.path) as string | undefined
      // Normalize: if absolute path under cwd, convert to relative so it
      // matches git-reported paths in collectCurrentDirtyFiles.
      if (filePath && (filePath.startsWith(deps.cwd + '/') || filePath.startsWith(deps.cwd + '\\'))) {
        filePath = filePath.slice(deps.cwd.length + 1)
     }
      if (tu.name === 'read_file' && filePath) {
        deps.taskLedger.record({ type: 'file_read', path: filePath })
     } else if ((tu.name === 'write_file' || tu.name === 'edit_file') && filePath) {
        deps.taskLedger.record({ type: 'file_write', path: filePath })
        deps.ownershipLedger?.registerOwned(filePath)
        // P2 cross-session signal: auto-acquire exclusive claim on written file
        if (deps.sessionRegistry && deps.sessionId) {
          deps.sessionRegistry.acquireClaim(deps.sessionId, filePath, 'exclusive')
       }
        // Commit nudge: warn when uncommitted files accumulate
        const nudge = buildCommitNudge({ ownedFiles: deps.taskLedger.getOwnedFiles() })
        if (nudge) finalContent += nudge
     } else if (tu.name === 'plan_close' && filePath) {
        if (tu.input.apply === true && !harnessResult.isError) {
          deps.taskLedger.record({ type: 'file_write', path: filePath })
          deps.ownershipLedger?.registerOwned(filePath)
          if (deps.sessionRegistry && deps.sessionId) {
            deps.sessionRegistry.acquireClaim(deps.sessionId, filePath, 'exclusive')
         }
       } else {
          deps.taskLedger.record({ type: 'tool_exec', tool: tu.name, path: filePath })
       }
     } else if (tu.name === 'bash') {
        const cmd = (tu.input.command as string | undefined) ?? ''
        if (!harnessResult.isError && (cmd.startsWith('git ') || /\b(rm|mv|cp|touch|mkdir)\b/.test(cmd))) {
          deps.config.promptEngine.markGitDirty()
          // bash 写操作也追踪到 evidence——否则 CompletionCurtain 的 filesModified 为空。
          // 从命令里粗略提取文件路径（重定向目标、git add 文件等），best-effort。
          const redirectMatch = cmd.match(/>>?\s*([^\s|&;]+)/)
          if (redirectMatch?.[1]) deps.evidence.trackFileModified(redirectMatch[1]!)
       }
        if (cmd.startsWith('git ')) {
          deps.taskLedger.record({ type: 'git_action', tool: tu.name, meta: { command: cmd.slice(0, 200) } })
       } else if (/\b(tsc|typecheck|check|test|jest|vitest|mocha|pytest|eslint|lint|build)\b/.test(cmd)) {
          const testStatus = harnessResult.isError ? 'failed' : 'passed'
          deps.taskLedger.record({ type: 'verification', command: cmd.slice(0, 200), status: testStatus, meta: { scope: 'full' } })
          // bash 跑测试/typecheck/lint 也归零 TDD 门禁——否则 agent 用 bash npm test
          // 而非 run_tests 工具时门禁计数器永远不重置，第 4 次编辑必误报拦截。
          deps.evidence.trackVerification({
            command: cmd.slice(0, 200),
            status: testStatus === 'passed' ? 'passed' : 'failed',
            scope: 'full',
            exitCode: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0,
          })
          deps.destructiveGate?.noteVerification(testStatus === 'passed' ? 'passed' : 'failed')
       } else {
          deps.taskLedger.record({ type: 'tool_exec', tool: tu.name, meta: { command: cmd.slice(0, 200) } })
       }
     } else if (tu.name === 'run_tests') {
        const filter = typeof tu.input.filter === 'string' ? tu.input.filter : undefined
        const command = filter ? `run_tests ${filter}` : 'run_tests'
        const verification = rawToolResult?.verification
        const buildMeta = (v?: VerificationMetadata): Record<string, unknown> => {
          const m: Record<string, unknown> = { scope: v?.scope ?? (filter ? 'targeted' : 'full') }
          if (v) {
            m.exitCode = v.exitCode
            m.passed = v.passed
            m.failed = v.failed
            m.skipped = v.skipped
            m.durationMs = v.durationMs
            m.resolvedCommand = v.command
            m.recommendedCommand = v.command
            if (v.failureKind) m.failureKind = v.failureKind
            if (v.targetFiles) m.targetFiles = v.targetFiles
            // VSW: carry snapshot identity + phase so the gate can apply
            // staleness supersession and integration_conflict attribution.
            if (v.snapshotRef) m.snapshotRef = v.snapshotRef
            if (v.verificationPhase) m.verificationPhase = v.verificationPhase
          }
          return m
        }
        deps.taskLedger.record({ type: 'verification', command, status: harnessResult.isError ? 'failed' : 'passed', meta: buildMeta(verification) })
        // VSW two-phase: record the integration (Phase B) verification too so a
        // Phase B failure surfaces as a non-blocking integration_conflict.
        for (const extra of rawToolResult?.extraVerifications ?? []) {
          deps.taskLedger.record({ type: 'verification', command, status: extra.status, meta: buildMeta(extra) })
        }
     } else if (tu.name === 'deliver_task' && tu.input.commit === true && !harnessResult.isError) {
        // Successful scoped commit changed git state — invalidate the frozen
        // git-status snapshot so the next appendix rebuild shows the post-commit
        // reality. Without this the model sees stale "modified" files and
        // re-attempts the commit (cache-log 6c9b3bd6 root cause).
        deps.config.promptEngine.markGitDirty()
        deps.taskLedger.record({ type: 'git_action', tool: tu.name, meta: { command: 'deliver_task commit' } })
     } else {
        deps.taskLedger.record({ type: 'tool_exec', tool: tu.name, path: filePath })
     }
   }

    // GhostRegistry: track read_section as artifact access
    if (tu.name === 'read_section' && !harnessResult.isError) {
      const accessedId = tu.input.artifactId as string | undefined
      if (accessedId) deps.artifactIdsAccessed?.push(accessedId)
   }

    // Claim extraction + conflict detection
    if (deps.config.contextClaimStore && deps.sessionId) {
      const existingPaths = new Set(
        deps.config.contextClaimStore.listClaims({ kind: ['file_observation'] })
          .flatMap(c => c.evidence.filter(e => e.path).map(e => e.path!)),
      )
      const proposals = extractClaimsFromToolResult(
        { toolName: tu.name, input: tu.input as Record<string, unknown>, result: harnessResult.content, isError: harnessResult.isError },
        { sessionId: deps.sessionId, turn: deps.sessionTurnCount, eventId: `turn-${deps.sessionTurnCount}:${tu.name}:${tu.id}` },
        existingPaths,
      )
      let projectMemoryDirty = false
      for (const proposal of proposals) {
        const claim = deps.config.contextClaimStore.propose(proposal)
        // Auto-write project-scoped claims to .rivet/knowledge/memory.jsonl
        // so they survive across sessions and auto-inject into every prompt.
        if (proposal.scope === 'project') {
          appendProjectMemory(deps.cwd, claim)
          projectMemoryDirty = true
       }
     }
      // Compact once after the batch, not per-claim.
      if (projectMemoryDirty) compactProjectMemory(deps.cwd)
      if (proposals.some(p => p.kind === 'file_observation')) {
        const allClaims = deps.config.contextClaimStore.listClaims()
        if (allClaims.length !== lastConflictCheckCount) {
          lastConflictCheckCount = allClaims.length
          const conflicts = detectConflicts(allClaims)
          for (const conflict of conflicts) {
            deps.config.contextClaimStore.updateClaimStatus(
              conflict.olderClaimId, 'conflicted',
              `superseded by ${conflict.newerClaimId} on ${conflict.sharedPath}`,
            )
         }
       }
     }
   }

    // Repair hint + antibody
    if (!harnessResult.isError) {
      deps.repairHintTracker.recordSuccess(tu.name)
   } else {
      const failureClass = classifyFailure(harnessResult.content)
      deps.repairHintTracker.recordFailure(tu.name, failureClass.class)
      if (deps.config.contextClaimStore && deps.sessionId && failureClass.class !== 'unknown') {
        const proposal = createAntibodyProposal(failureClass, {
          toolName: tu.name,
          command: typeof tu.input.command === 'string' ? tu.input.command : undefined,
          sessionId: deps.sessionId,
          turn: deps.sessionTurnCount,
          eventId: `turn-${deps.sessionTurnCount}:${tu.name}:${tu.id}`,
       })
        deps.config.contextClaimStore.propose(proposal)
     }
   }

    // Activity status: notify TUI when tool is blocked by critical failure
    if (harnessResult.isError && callbacks.onPhaseChange) {
      const failureClass = classifyFailure(harnessResult.content)
      if (BLOCKED_CLASSES.has(failureClass.class)) {
        callbacks.onPhaseChange('blocked', {
          tool: tu.name,
          reason: failureClass.class,
          suggestion: failureClass.suggestion,
       })
     }
   }

    // Prewarm invalidation after writes
    if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError && typeof tu.input.file_path === 'string') {
      try {
        deps.prewarm.invalidate(validatePath(deps.cwd, tu.input.file_path as string))
     } catch {
        deps.prewarm.invalidate(tu.input.file_path as string)
     }
   }

    // Prewarm grep-matched files: grep→read_file is the most common tool sequence.
    // After grep succeeds, prewarm up to 5 matched file paths so the next
    // read_file hits the PrewarmCache instead of doing a cold fs read.
    if (tu.name === 'grep' && !harnessResult.isError) {
      const matchedFiles = extractGrepMatchPaths(finalContent, deps.cwd)
      if (matchedFiles.length > 0) {
        void batchPrewarm(deps.cwd, matchedFiles, deps.prewarm).catch(() => {})
      }
    }

    // Evidence tracking + import graph
    if (tu.name === 'read_file' && !harnessResult.isError) {
      deps.evidence.trackFileRead(tu.input.file_path as string)

      // compaction_fail signal: read_file returns pruned/diet content
      const hasPruned = finalContent.includes('[pruned]') || finalContent.includes('[diet:redundant]')
      if (hasPruned) {
        try {
          deps.immuneHook?.injectSignal({
            kind: 'compaction_fail',
            severity: 0.6,
            turn,
            source: 'tool-pipeline',
            context: `read_file returned pruned content for ${tu.input.file_path}`,
         })
       } catch { /* non-critical: signal injection is best-effort */ }
     }
   } else if ((tu.name === 'write_file' || tu.name === 'edit_file' || tu.name === 'hash_edit') && !harnessResult.isError) {
      deps.evidence.trackFileModified(tu.input.file_path as string)
      deps.config.promptEngine.markGitDirty()
      deps.config.contextClaimStore?.markClaimsStaleForFile(
        tu.input.file_path as string,
        `file modified by ${tu.name}`,
      )
      // Prefer meridian graph (persisted SQLite reverse BFS) over in-memory import-graph.
      const filePath = tu.input.file_path as string
      const db = deps.meridianIndexer?.getDb()
      if (db && !isAbsolute(filePath)) {
        const impact = analyzeImpact(db, [filePath])
        if (impact.direct.length > 0 || impact.tests.length > 0) {
          deps.evidence.trackImpact(impact.direct, impact.tests)
        }
      } else {
        if (!importGraph) {
          try {
            importGraph = buildImportGraph(deps.cwd)
          } catch {
            // Best-effort impact analysis — must never produce tool errors.
            // collectTsFiles already catches per-dir errors; this is a belt
            // for any remaining fs failure (e.g. root cwd itself unreadable).
          }
        }
        if (importGraph) {
          importGraph = invalidateFile(importGraph, deps.cwd, filePath)
          const hint = generateImpactHint(importGraph, filePath, deps.cwd)
          if (hint) {
            deps.evidence.trackImpact(hint.impactedFiles, hint.relatedTests)
          }
        }
      }
   } else if (tu.name === 'run_tests' && rawToolResult) {
      // Reconnect EvidenceTracker verification pipeline.
      // run_tests returns VerificationMetadata, but this was never fed into
      // EvidenceTracker — leaving deliveryStatus stuck at 'unverified',
      // buildBadge showing "Unverified changes", and
      // buildDeliveryGate.canClaimComplete always false.
      if (rawToolResult.verification) {
        deps.evidence.trackVerification(rawToolResult.verification)
        deps.destructiveGate?.noteVerification(rawToolResult.verification.status)
     }

      if (rawToolResult.verification && rawToolResult.verification.status !== 'passed') {
        const failures = classifyTestRun(harnessResult.content)
        if (failures.length > 0 && failures[0]!.confidence >= 0.7) {
          const failureClass = classifyFailure(harnessResult.content)
          deps.repairHintTracker.recordFailure(tu.name, failureClass.class)
          let diagnosedContent = `${finalContent}\n\nDiagnosis: ${failures[0]!.suggestion}`
          if (!harnessResult.isError) {
            diagnosedContent = truncateSuccessfulToolResult(diagnosedContent, deps.config)
         }
          const diagThreshold = deps.cacheAdvisor?.getArtifactThreshold(deps.phaseHint ?? 'execute', harnessResult.isError)
          const diagBudgetFrac = deps.turnBudget.maxTokensPerTurn > 0
            ? 1 - (deps.turnBudget.usedTokens / deps.turnBudget.maxTokensPerTurn)
            : 1
          diagnosedContent = await artifactIntercept(diagnosedContent, tu.name, tu.input, deps.artifactStore, harnessResult.isError, diagThreshold, diagBudgetFrac, deps.config.contextWindow)
          const diagEvictedId = extractArtifactId(diagnosedContent)
          if (diagEvictedId) deps.artifactIdsEvicted?.push(diagEvictedId)
          return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? diagnosedContent + starSig : diagnosedContent, is_error: harnessResult.isError }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
       }
     }
   }

    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? finalContent + starSig : finalContent, is_error: harnessResult.isError }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk, endTurn: rawToolResult?.endTurn === true ? true : undefined }
 } catch (err) {
    // AbortError: user cancelled — not a tool failure.
    // Skip failure recording so immune/doom-loop signals aren't polluted.
    if ((err as Error).name === 'AbortError') {
      // NEVER return empty content: a silent '' success made the model fly
      // blind on its most critical deliveries (session 803d897d: two
      // deliver_task results came back empty after user steering aborted the
      // batch, while the detached execute kept running and landed commits).
      // The model must know (a) the call was interrupted and (b) the work may
      // still have completed in the background.
      const abortedNote = `[interrupted] ${tu.name} was cancelled before its result could be returned. The underlying operation may still have completed in the background — verify actual state (e.g. git log, file contents, test output) before assuming it failed or retrying.`
      callbacks.onToolResult(tu.id, tu.name, abortedNote, false)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: abortedNote, is_error: false }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
   }
    const msg = err instanceof Error ? err.message : String(err)
    deps.repairHintTracker.recordFailure(tu.name, classifyFailure(msg).class)
    callbacks.onToolResult(tu.id, tu.name, msg, true)
    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
  }
}

/**
 * Extract unique file paths from grep output.
 * Grep output format: `relative/path.ts:42:  const x = 1`
 * We extract just the file path portion (before the first colon on each line).
 */
function extractGrepMatchPaths(grepOutput: string, cwd: string): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  const MAX_FILES = 5

  for (const line of grepOutput.split('\n')) {
    if (paths.length >= MAX_FILES) break
    // Match lines like "src/foo.ts:42:  content" or "src/foo.ts:content"
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) continue
    const filePath = line.slice(0, colonIdx)
    // Skip if it looks like a non-path (e.g. artifact markers, section headers)
    if (filePath.startsWith('[') || filePath.startsWith('Use ') || filePath.startsWith('...')) continue
    if (!seen.has(filePath)) {
      seen.add(filePath)
      paths.push(filePath)
    }
  }

  return paths
}


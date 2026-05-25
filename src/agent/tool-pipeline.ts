import type { AgentConfig, AgentCallbacks } from './loop.js'
import type { TurnBudget } from './turn-budget.js'
import type { ContentBlock } from '../api/types.js'
import type { ToolCallParams } from '../tools/types.js'
import type { TurnHarness } from './turn-harness.js'
import type { EvidenceTrackerPublic } from './evidence.js'
import type { TraceStore } from './trace-store.js'
import type { RepairHintTracker } from './repair-hint.js'
import type { ImportGraph } from './import-graph.js'
import { createCheckpoint, recordAgentTouchedFile } from './checkpoint.js'
import { validatePath } from '../tools/path-validate.js'
import { classifyFailure, classifyTestRun } from './failure-classifier.js'
import { extractClaimsFromToolResult } from '../context/claim-extractor.js'
import { detectConflicts } from '../context/conflict-detect.js'
import { createAntibodyProposal } from '../context/antibody.js'
import { buildImportGraph, invalidateFile } from './import-graph.js'
import { generateImpactHint } from './impact-hint.js'
import { shouldRunDiagnostics, runTypeCheck } from '../lsp/client.js'
import { startTraceEvent, finishTraceEvent, fingerprintToolCall, recordToolFingerprint, recordTraceEvent } from './trace-store.js'
import { summarizeRepairTelemetry } from './repair-pipeline.js'
import type { InterventionLevel } from './prediction-error.js'
import { assessToolRisk, CONFIDENCE_THRESHOLDS, requiresBashWriteApproval } from './approval-risk.js'
import type { Sensorium } from './sensorium.js'
import { isToolAllowed } from './permissions.js'
import { applyApprovalEdit, type ApprovalResult } from './approval-edit.js'
import { debugLog } from '../utils/debug.js'
import { suggestStrategyShift, type TrajectorySummary } from './strategy-shift.js'
import { PrewarmCache } from './prewarm.js'
import { compactThresholds, pruneThresholds } from '../compact/constants.js'
import { truncateToolResult } from './tool-result-truncate.js'
import { getStarSignature } from './star-signature.js'
import type { ImmuneHook } from './immune-hook.js'
import { detectMistakeResolution } from './mistake-detector.js'
import { isToolAllowedInReliabilityMode, reliabilityBlockMessage, type ReliabilityDecision } from './reliability-mode.js'
import type { ArtifactStore } from '../artifact/store.js'
import type { CacheAdvisor } from '../cache/advisor.js'
import type { TaskLedger } from './task-ledger.js'
import type { P3Integration } from './p3-integration.js'

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

const TOOL_TIMEOUT_MS = 120_000 // 2 minutes

function withToolTimeout<T>(
  promise: Promise<T>,
  toolName: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
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
  lastConflictCheckCount: number
  trajectory: { getEntries(): { tool: string; target: string; status: string; errorClass?: string }[] }
  getDoomLoopLevel(): import('./trace-store.js').DoomLoopLevel
  latestRisk: import('./approval-risk.js').RiskAssessment
  sessionTurnCount: number
  sessionId: string | undefined
  abortSignal?: AbortSignal
  recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, content: string): void
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
  /** Immune system hook for recording repair success (failed→passed transitions) */
  immuneHook?: ImmuneHook
  /** Optional cache advisor for adaptive artifact thresholds */
  cacheAdvisor?: CacheAdvisor
  /** Phase hint passed to cache advisor (e.g. 'explore', 'execute', 'verify'). Defaults to 'execute'. */
  phaseHint?: string
  /** Optional TaskLedger for B1 ownership tracking */
  taskLedger?: TaskLedger
  /** P3 integration facade for speculative execution + mistake hints */
  p3?: P3Integration
  /** Turn-scoped accumulator: artifact IDs evicted (created by artifactIntercept) */
  artifactIdsEvicted?: string[]
  /** Turn-scoped accumulator: artifact IDs accessed (read_section calls) */
  artifactIdsAccessed?: string[]
}

export interface ToolExecResult {
  toolResult: ContentBlock
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  checkpointCreated: boolean
  latestRisk: import('./approval-risk.js').RiskAssessment
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

/** Tools whose output is the agent's "eyes" — intercept only at very high thresholds. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'grep', 'glob', 'find_files', 'search', 'repo_map', 'inspect_project',
  // read_section is the model's escape hatch from artifact references. Its output
  // is content the model explicitly asked for (artifactId + section), already
  // capped by computeModelReadCap inside the tool. Wrapping it again here turned
  // every recovery attempt into [artifact:NEW_ID] -> read_section(NEW_ID) -> ...
  // an infinite nesting loop the model could only escape by requesting tiny
  // L1-L10 slices. (Diagnosed by tianshu v4 pro post-mortem 2026-05-25.)
  'read_section',
])

/** Heuristic: is this bash command read-only (cat, grep, find, git log/diff/status, ls, etc.)? */
function isBashReadOnly(input: Record<string, unknown>): boolean {
  const cmd = typeof input.command === 'string' ? input.command.trimStart() : ''
  return /^(cat|head|tail|grep|rg|find|ls|tree|wc|git\s+(log|diff|status|show|blame|rev-parse|branch)|echo|printf|type|which|file)\b/.test(cmd)
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
  // Read-class tools bypass artifact intercept entirely — rely on per-message budget + hard truncation.
  const isReadTool = READ_TOOLS.has(toolName) || (toolName === 'bash' && isBashReadOnly(toolInput))
  if (isReadTool) return content

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
    const floor = pruneThresholds(contextWindow).minChars
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
  if (content.startsWith('[artifact:')) return content // already an artifact ref

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
  const params: ToolCallParams = {
    input: tu.input,
    toolUseId: tu.id,
    cwd: deps.cwd,
    onOutput: (chunk) => {
      callbacks.onToolResult(tu.id, tu.name, chunk)
    },
    sessionModifiedFiles: [...deps.evidence.getState().filesModified],
    artifactStore: deps.artifactStore,
    contextWindow: deps.config.contextWindow,
    providerProfile: deps.config.providerProfile,
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
    deps.config.promptEngine.setStrategyShift(hint)
    if (doomLevel === 'blocked') {
      // 计算连续失败次数和 fingerprint 信息，让 agent 知道发生了什么
      const fps = traceStore.toolFingerprints
      const lastFp = fps.at(-1)
      const maxCount = lastFp ? fps.filter(f => f === lastFp).length : 0
      const baseMsg = hint ?? 'Repeated identical failures detected.'
      const msg = [
        baseMsg,
        `Tool: ${tu.name} | Consecutive same-pattern failures: ${maxCount} | Fingerprint: ${lastFp?.slice(0, 8) ?? 'unknown'}`,
        'Recovery: try a different tool (e.g. read_file, todo), change the input, or modify the target path.',
      ].join('\n')
      callbacks.onToolResult(tu.id, tu.name, msg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
    }

    // Approval gate — with sensorium-driven adaptive confidence
    const needsApproval = deps.config.toolRegistry.needsApproval(tu.name, params)
    const antibodies = deps.config.contextClaimStore?.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] }) ?? []
    const sensorium = deps.getSensorium?.() ?? null
    const risk = assessToolRisk(tu.name, tu.input, deps.getDoomLoopLevel(), antibodies, sensorium ?? undefined)
    latestRisk = risk
    const isHighRisk = risk.level === 'high'
    const approvalMode = deps.config.approvalMode ?? 'manual'

    // Sensorium-driven auto-approve: high confidence + low risk → bypass approval
    const canAutoApprove = sensorium
      && sensorium.confidence >= CONFIDENCE_THRESHOLDS.autoApproveConfidence
      && (risk.level === 'none' || risk.level === 'low')
      && approvalMode === 'auto-safe'

    const allowlisted = isToolAllowed(tu.name, tu.input, deps.config.permissions?.allow)
    const bashWriteRequiresApproval = requiresBashWriteApproval(tu.name, tu.input) && !allowlisted
    const shouldAsk = bashWriteRequiresApproval
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
        const denyMsg = 'Tool execution denied: requires user approval'
        callbacks.onToolResult(tu.id, tu.name, denyMsg, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: denyMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
      }
      if (finalInput !== tu.input) {
        tu.input = finalInput
        params.input = finalInput
      }
    }

    // Checkpoint before first write
    if ((tu.name === 'write_file' || tu.name === 'edit_file') && !checkpointCreated) {
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
    const toolTarget = (tu.input.file_path ?? tu.input.path ?? tu.input.command ?? '') as string
    deps.p3?.onToolStart(tu.name)

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
        const r = await withToolTimeout(
          deps.config.toolRegistry.execute(tu.name, params),
          tu.name,
          deps.abortSignal,
        )
        rawToolResult = r
        return { content: r.content, isError: r.isError }
      },
      classify: (content) => classifyFailure(content).class,
      isConcurrencySafe: toolDef?.isConcurrencySafe() ?? false,
    })

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
    // can cause ~0.5% cache miss from otherwise identical tool results.
    finalContent = finalContent.trimEnd()

    // LSP diagnostics
    if (deps.config.lspEnabled && !harnessResult.isError && shouldRunDiagnostics(tu.name, tu.input.file_path as string | undefined)) {
      const check = runTypeCheck(deps.cwd, tu.input.file_path as string)
      if (check.formatted) {
        finalContent = finalContent + `

[LSP Diagnostics]
${check.formatted}`
      }
    }

    if (!harnessResult.isError) {
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

    // Trace recording
    traceStore = finishTraceEvent(traceStore, traceId, {
      status: harnessResult.isError ? 'failed' : 'passed',
      endedAt: Date.now(),
      summary: harnessResult.content.slice(0, 100),
    })
    deps.recordPrediction?.(!harnessResult.isError)
    const fp = fingerprintToolCall(tu.name, tu.input, harnessResult.isError ? 'error' : 'success')
    traceStore = recordToolFingerprint(traceStore, fp)

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

    deps.recordToolHistory(tu.name, tu.input, harnessResult.isError, harnessResult.content)

    // B1 归属星轨：record tool events into TaskLedger
    if (deps.taskLedger) {
      const filePath = (tu.input.file_path ?? tu.input.path) as string | undefined
      if (tu.name === 'read_file' && filePath) {
        deps.taskLedger.record({ type: 'file_read', path: filePath })
      } else if ((tu.name === 'write_file' || tu.name === 'edit_file') && filePath) {
        deps.taskLedger.record({ type: 'file_write', path: filePath })
      } else if (tu.name === 'bash' && !harnessResult.isError) {
        const cmd = (tu.input.command as string | undefined) ?? ''
        if (cmd.startsWith('git ')) {
          deps.taskLedger.record({ type: 'git_action', tool: tu.name, meta: { command: cmd.slice(0, 200) } })
        } else if (/\b(test|jest|vitest|mocha|pytest)\b/.test(cmd)) {
          deps.taskLedger.record({ type: 'verification', command: cmd.slice(0, 200), status: harnessResult.isError ? 'failed' : 'passed' })
        } else {
          deps.taskLedger.record({ type: 'tool_exec', tool: tu.name, meta: { command: cmd.slice(0, 200) } })
        }
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
      for (const proposal of proposals) {
        deps.config.contextClaimStore.propose(proposal)
      }
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
      deps.config.promptEngine.setStrategyShift(null)
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
    } else if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError) {
      deps.evidence.trackFileModified(tu.input.file_path as string)
      deps.config.contextClaimStore?.markClaimsStaleForFile(
        tu.input.file_path as string,
        `file modified by ${tu.name}`,
      )
      if (!importGraph) {
        importGraph = buildImportGraph(deps.cwd)
      }
      if (importGraph) {
        importGraph = invalidateFile(importGraph, deps.cwd, tu.input.file_path as string)
        const hint = generateImpactHint(importGraph, tu.input.file_path as string, deps.cwd)
        if (hint) {
          deps.evidence.trackImpact(hint.impactedFiles, hint.relatedTests)
          deps.config.promptEngine.setImpactHint(hint.summary)
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

    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? finalContent + starSig : finalContent, is_error: harnessResult.isError }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.repairHintTracker.recordFailure(tu.name, classifyFailure(msg).class)
    callbacks.onToolResult(tu.id, tu.name, msg, true)
    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
  }
}

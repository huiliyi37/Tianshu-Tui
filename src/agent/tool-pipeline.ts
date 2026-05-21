import type { AgentConfig, AgentCallbacks } from './loop.js'
import type { TurnBudget } from './turn-budget.js'
import type { ContentBlock } from '../api/types.js'
import type { ToolCallParams } from '../tools/types.js'
import type { TurnHarness } from './turn-harness.js'
import type { EvidenceTracker } from './evidence.js'
import type { TraceStore } from './trace-store.js'
import type { RepairHintTracker } from './repair-hint.js'
import type { ImportGraph } from './import-graph.js'
import { createCheckpoint, recordAgentTouchedFile } from './checkpoint.js'
import { validatePath } from '../tools/path-validate.js'
import { canUsePrewarmForRead } from './prewarm-file.js'
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
import { suggestStrategyShift, type TrajectorySummary } from './strategy-shift.js'
import { PrewarmCache } from './prewarm.js'
import { compactThresholds } from '../compact/constants.js'
import { truncateToolResult } from './tool-result-truncate.js'
import { isToolAllowedInReliabilityMode, reliabilityBlockMessage, type ReliabilityDecision } from './reliability-mode.js'

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
  evidence: EvidenceTracker
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
  getInterventionLevel?(): import('./prediction-error.js').InterventionLevel
  recordPrediction?(correct: boolean): void
  /** Current sensorium snapshot — enables confidence-driven adaptive approval. */
  getSensorium?(): Sensorium | null
  /** Current reliability mode decision — blocks risky tools before approval/execution. */
  getReliabilityDecision?(): ReliabilityDecision | null
  /** Turn-level token budget — degrades tool results when exhausted. */
  turnBudget: TurnBudget
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
  }

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
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
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
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
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
        if (tu.name === 'read_file' && canUsePrewarmForRead(tu.input)) {
          try {
            const canonicalPath = validatePath(deps.cwd, tu.input.file_path as string)
            const cached = deps.prewarm.get(canonicalPath)
            if (cached) {
              rawToolResult = { content: cached.content, uiContent: cached.uiContent }
              return { content: cached.content }
            }
          } catch { /* fall through */ }
        }
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

    // Trace recording
    traceStore = finishTraceEvent(traceStore, traceId, {
      status: harnessResult.isError ? 'failed' : 'passed',
      endedAt: Date.now(),
      summary: harnessResult.content.slice(0, 100),
    })
    deps.recordPrediction?.(!harnessResult.isError)
    const fp = fingerprintToolCall(tu.name, tu.input, harnessResult.isError ? 'error' : 'success')
    traceStore = recordToolFingerprint(traceStore, fp)

    callbacks.onToolResult(tu.id, tu.name, finalContent, harnessResult.isError, rawToolResult?.rawPath, rawToolResult?.uiContent)

    deps.recordToolHistory(tu.name, tu.input, harnessResult.isError, harnessResult.content)

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
          return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: diagnosedContent, is_error: harnessResult.isError }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
        }
      }
    }

    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: finalContent, is_error: harnessResult.isError }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.repairHintTracker.recordFailure(tu.name, classifyFailure(msg).class)
    callbacks.onToolResult(tu.id, tu.name, msg, true)
    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
  }
}

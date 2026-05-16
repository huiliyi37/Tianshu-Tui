import type { AgentConfig, AgentCallbacks } from './loop.js'
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
import { assessToolRisk } from './approval-risk.js'
import { isToolAllowed } from './permissions.js'
import { applyApprovalEdit, type ApprovalResult } from './approval-edit.js'
import { suggestStrategyShift, type TrajectorySummary } from './strategy-shift.js'
import { PrewarmCache } from './prewarm.js'
import { compactThresholds } from '../compact/constants.js'
import { truncateToolResult } from './tool-result-truncate.js'

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
  recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, content: string): void
}

export interface ToolExecResult {
  toolResult: ContentBlock
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  checkpointCreated: boolean
  latestRisk: import('./approval-risk.js').RiskAssessment
}

function truncateSuccessfulToolResult(content: string, contextWindow: number | undefined): string {
  return truncateToolResult(content, compactThresholds(contextWindow ?? 1_000_000).toolResultMaxTokens)
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
  }

  try {
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
      const msg = hint ?? 'Tool execution blocked: repeated identical failures detected. Change strategy before retrying.'
      callbacks.onToolResult(tu.id, tu.name, msg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
    }

    // Approval gate
    const needsApproval = deps.config.toolRegistry.needsApproval(tu.name, params)
    const antibodies = deps.config.contextClaimStore?.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] }) ?? []
    const risk = assessToolRisk(tu.name, tu.input, deps.getDoomLoopLevel(), antibodies)
    latestRisk = risk
    const isHighRisk = risk.level === 'high'
    const approvalMode = deps.config.approvalMode ?? 'manual'

    const allowlisted = isToolAllowed(tu.name, tu.input, deps.config.permissions?.allow)
    const shouldAsk = allowlisted
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
        const r = await deps.config.toolRegistry.execute(tu.name, params)
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
      finalContent = truncateSuccessfulToolResult(finalContent, deps.config.contextWindow)
    }

    // Trace recording
    traceStore = finishTraceEvent(traceStore, traceId, {
      status: harnessResult.isError ? 'failed' : 'passed',
      endedAt: Date.now(),
      summary: harnessResult.content.slice(0, 100),
    })
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
            diagnosedContent = truncateSuccessfulToolResult(diagnosedContent, deps.config.contextWindow)
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

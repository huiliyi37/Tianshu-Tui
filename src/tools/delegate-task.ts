import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ClaimProposal } from '../context/claims.js'
import { profileRegistry } from '../agent/profile-registry.js'
import { validatePathSafe } from './path-validate.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export interface DelegateTaskCoordinator {
  delegate(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun>
}

/** Dynamic profile validation — accepts built-in + user-loaded profiles */
const profileStringSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `Unknown profile "${val}". Available: ${profileRegistry.getProfileNames().join(', ')}` }),
)

const delegateTaskInputSchema = z.object({
  objective: z.string().min(1),
  kind: z.enum(['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal']).optional(),
  profile: profileStringSchema.optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
})

function formatUiContent(run: CoordinatorRun): string {
  if (run.status === 'skipped') return 'delegate_task skipped: objective did not pass budget gate'
  const passed = run.results.filter(r => r.status === 'passed').length
  const blocked = run.results.filter(r => r.status === 'blocked').length
  return `delegate_task completed: ${passed} passed, ${blocked} blocked, model=${run.selectedModel ?? 'unknown'}`
}

/** Progressive timeout: single-task workers start fast and grow with session maturity.
 *    turn 0-1 (cold open)  → 30 s
 *    turn 2-4 (warming)    → 75 s
 *    turn 5+  (mature)     → 180 s
 */
function progressiveTaskTimeout(sessionTurnCount?: number): number {
  const turn = sessionTurnCount ?? 10
  if (turn <= 1) return 30_000
  if (turn <= 4) return 75_000
  return 180_000
}

export function createDelegateTaskTool(
  coordinator: DelegateTaskCoordinator,
  getClaimStore?: () => ContextClaimStore | undefined,
  getSessionId?: () => string | undefined,
): Tool {
  return {
    definition: {
      name: 'delegate_task',
      description: 'Delegate a bounded task to a worker agent. Supports code search, review, planning, verification, and patching.',
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Specific objective for the worker.' },
          kind: { type: 'string', enum: ['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal'], description: 'Worker task type. Default: code_search.' },
          profile: { type: 'string', enum: profileRegistry.getProfileNames(), description: 'Worker profile. Default: code_scout.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to focus on.' },
          symbols: { type: 'array', items: { type: 'string' }, description: 'Optional symbols to focus on.' },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = delegateTaskInputSchema.safeParse(params.input)
      if (!parsed.success) {
        return {
          content: `Invalid delegate_task input: ${parsed.error.message}`,
          isError: true,
        }
      }

      // Pre-flight: validate file paths are within project root
      if (parsed.data.files && parsed.data.files.length > 0) {
        const outOfProject: string[] = []
        for (const f of parsed.data.files) {
          const v = validatePathSafe(params.cwd, f)
          if (!v.ok) outOfProject.push(f)
        }
        if (outOfProject.length > 0) {
          return {
            content: [
              `delegate_task blocked: ${outOfProject.length} file(s) are outside the project directory.`,
              `Offending paths: ${outOfProject.join(', ')}`,
              `Workers cannot access files outside the project root (${params.cwd}).`,
              `If you need to analyze external code, copy it into the project first or use bash to cat the file content inline.`,
            ].join('\n'),
            isError: true,
          }
        }
      }

      const run = await coordinator.delegate({
        parentTurnId: params.toolUseId,
        objective: parsed.data.objective,
        kind: parsed.data.kind ?? 'code_search',
        profile: (parsed.data.profile ?? 'code_scout') as import('../agent/work-order.js').WorkerProfile,
        scope: {
          files: parsed.data.files,
          symbols: parsed.data.symbols,
        },
        reviewDepth: params.reviewDepth,
      }, params.abortSignal)

      // Extract worker findings into claim store
      if (run.status === 'completed') {
        const claimStore = getClaimStore?.()
        const sid = getSessionId?.()
        if (claimStore && sid) {
          const createdAt = Date.now()
          for (const result of run.results) {
            if (result.status !== 'passed') continue
            const evidencePaths = result.changedFiles.slice(0, 3)
            for (const finding of result.findings) {
              const claimText = typeof finding === 'string' ? finding : finding.claim
              const confidence = typeof finding === 'string' ? 0.7
                : finding.confidence === 'high' ? 0.85
                : finding.confidence === 'medium' ? 0.7
                : 0.55
              const proposal: ClaimProposal = {
                kind: 'worker_finding',
                scope: 'session',
                text: claimText,
                confidence,
                fitness: confidence >= 0.85 ? 5 : confidence >= 0.7 ? 3 : 2,
                source: { actor: 'worker', sessionId: sid, turn: params.sessionTurnCount ?? 0, eventId: `${params.toolUseId}:worker` },
                evidence: [{
                  id: `${params.toolUseId}:finding`,
                  kind: 'worker',
                  summary: typeof finding === 'string' ? finding : finding.evidence,
                  path: evidencePaths[0],
                  createdAt,
                }],
                createdAt,
                tags: ['worker', result.workOrderId],
              }
              claimStore.propose(proposal)
            }
          }
        }
      }

      return {
        content: run.packet,
        uiContent: formatUiContent(run),
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    timeoutMs: (params) => progressiveTaskTimeout(params?.sessionTurnCount),
  }
}

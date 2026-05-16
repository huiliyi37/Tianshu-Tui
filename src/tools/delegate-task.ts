import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ClaimProposal } from '../context/claims.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export interface DelegateTaskCoordinator {
  delegate(request: DelegationRequest): Promise<CoordinatorRun>
}

const delegateTaskInputSchema = z.object({
  objective: z.string().min(1),
  kind: z.enum(['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal']).optional(),
  profile: z.enum(['code_scout', 'doc_scout', 'planner', 'reviewer', 'verifier', 'patcher']).optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
})

function formatUiContent(run: CoordinatorRun): string {
  if (run.status === 'skipped') return 'delegate_task skipped: objective did not pass budget gate'
  const passed = run.results.filter(r => r.status === 'passed').length
  const blocked = run.results.filter(r => r.status === 'blocked').length
  return `delegate_task completed: ${passed} passed, ${blocked} blocked, model=${run.selectedModel ?? 'unknown'}`
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
          profile: { type: 'string', enum: ['code_scout', 'doc_scout', 'planner', 'reviewer', 'verifier', 'patcher'], description: 'Worker profile. Default: code_scout.' },
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

      const run = await coordinator.delegate({
        parentTurnId: params.toolUseId,
        objective: parsed.data.objective,
        kind: parsed.data.kind ?? 'code_search',
        profile: parsed.data.profile ?? 'code_scout',
        scope: {
          files: parsed.data.files,
          symbols: parsed.data.symbols,
        },
      })

      // Extract worker findings into claim store
      if (run.status === 'completed') {
        const claimStore = getClaimStore?.()
        const sid = getSessionId?.()
        if (claimStore && sid) {
          const createdAt = Date.now()
          for (const result of run.results) {
            if (result.status !== 'passed') continue
            for (const finding of result.findings) {
              const claimText = typeof finding === 'string' ? finding : finding.claim
              const proposal: ClaimProposal = {
                kind: 'worker_finding',
                scope: 'session',
                text: claimText,
                confidence: 0.75,
                fitness: 4,
                source: { actor: 'worker', sessionId: sid, turn: 0, eventId: `${params.toolUseId}:worker` },
                evidence: [{ id: `${params.toolUseId}:finding`, kind: 'worker', summary: claimText, createdAt }],
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
  }
}

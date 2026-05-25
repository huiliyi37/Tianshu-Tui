import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { AggregationPolicy } from '../agent/work-order.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ClaimProposal } from '../context/claims.js'
import { validatePathSafe } from './path-validate.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export interface DelegateBatchCoordinator {
  delegateBatch(requests: DelegationRequest[], policy?: AggregationPolicy): Promise<CoordinatorRun>
}

const taskSchema = z.object({
  objective: z.string().min(1),
  kind: z.enum(['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal']).optional(),
  profile: z.enum(['code_scout', 'doc_scout', 'planner', 'reviewer', 'verifier', 'patcher']).optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
})

const inputSchema = z.object({
  tasks: z.array(taskSchema).min(1).max(5),
  policy: z.enum(['all_required', 'first_success', 'majority', 'primary_decides']).optional(),
})

function extractClaimsFromRun(run: CoordinatorRun, toolUseId: string, claimStore: ContextClaimStore, sessionId: string): void {
  const createdAt = Date.now()
  for (const result of run.results) {
    if (result.status !== 'passed') continue
    const evidencePaths = result.changedFiles.slice(0, 3)
    result.findings.forEach((finding, findingIndex) => {
      const claimText = typeof finding === 'string' ? finding : finding.claim
      const confidence = typeof finding === 'string' ? 0.7
        : finding.confidence === 'high' ? 0.85
        : finding.confidence === 'medium' ? 0.7
        : 0.55
      const eventId = `${toolUseId}:worker:${result.workOrderId}:${findingIndex}`
      const proposal: ClaimProposal = {
        kind: 'worker_finding',
        scope: 'session',
        text: claimText,
        confidence,
        fitness: confidence >= 0.85 ? 5 : confidence >= 0.7 ? 3 : 2,
        source: { actor: 'worker', sessionId, turn: 0, eventId },
        evidence: [{
          id: `${eventId}:finding`,
          kind: 'worker',
          summary: typeof finding === 'string' ? finding : finding.evidence,
          path: evidencePaths[0],
          createdAt,
        }],
        createdAt,
        tags: ['worker', result.workOrderId],
      }
      claimStore.propose(proposal)
    })
  }
}

export function createDelegateBatchTool(
  coordinator: DelegateBatchCoordinator,
  getClaimStore?: () => ContextClaimStore | undefined,
  getSessionId?: () => string | undefined,
): Tool {
  return {
    definition: {
      name: 'delegate_batch',
      description: 'Run multiple worker tasks in parallel. Max 5 tasks per batch.',
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                objective: { type: 'string' },
                kind: { type: 'string', enum: ['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal'] },
                profile: { type: 'string', enum: ['code_scout', 'doc_scout', 'planner', 'reviewer', 'verifier', 'patcher'] },
                files: { type: 'array', items: { type: 'string' } },
                symbols: { type: 'array', items: { type: 'string' } },
              },
              required: ['objective'],
            },
            description: 'Array of tasks to run in parallel (max 5).',
          },
          policy: { type: 'string', enum: ['all_required', 'first_success', 'majority', 'primary_decides'], description: 'Aggregation policy. Default: primary_decides.' },
        },
        required: ['tasks'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true }

      // Pre-flight: validate file paths are within project root for all tasks
      const outOfProject: { taskIdx: number; paths: string[] }[] = []
      for (let i = 0; i < parsed.data.tasks.length; i++) {
        const t = parsed.data.tasks[i]!
        if (t.files && t.files.length > 0) {
          const bad = t.files.filter(f => !validatePathSafe(params.cwd, f).ok)
          if (bad.length > 0) outOfProject.push({ taskIdx: i, paths: bad })
        }
      }
      if (outOfProject.length > 0) {
        const details = outOfProject
          .map(o => `  task[${o.taskIdx}]: ${o.paths.join(', ')}`)
          .join('\n')
        return {
          content: [
            `delegate_batch blocked: ${outOfProject.length} task(s) reference files outside the project directory.`,
            details,
            `Workers cannot access files outside the project root (${params.cwd}).`,
            `If you need to analyze external code, copy it into the project first or use bash to cat the file content inline.`,
          ].join('\n'),
          isError: true,
        }
      }

      const requests: DelegationRequest[] = parsed.data.tasks.map((t, i) => ({
        parentTurnId: `${params.toolUseId}:${i}`,
        objective: t.objective,
        kind: t.kind ?? 'code_search',
        profile: t.profile ?? 'code_scout',
        scope: { files: t.files, symbols: t.symbols },
      }))

      const run = await coordinator.delegateBatch(requests, parsed.data.policy ?? 'primary_decides')

      // Extract worker findings into claim store
      if (run.status === 'completed') {
        const claimStore = getClaimStore?.()
        const sid = getSessionId?.()
        if (claimStore && sid) {
          extractClaimsFromRun(run, params.toolUseId, claimStore, sid)
        }
      }

      const passed = run.results.filter(r => r.status === 'passed').length
      return {
        content: run.packet,
        uiContent: `delegate_batch: ${passed}/${run.results.length} passed`,
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

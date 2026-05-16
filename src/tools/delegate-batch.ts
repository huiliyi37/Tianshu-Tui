import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { AggregationPolicy } from '../agent/work-order.js'
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

export function createDelegateBatchTool(coordinator: DelegateBatchCoordinator): Tool {
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

      const requests: DelegationRequest[] = parsed.data.tasks.map((t, i) => ({
        parentTurnId: `${params.toolUseId}:${i}`,
        objective: t.objective,
        kind: t.kind ?? 'code_search',
        profile: t.profile ?? 'code_scout',
        scope: { files: t.files, symbols: t.symbols },
      }))

      const run = await coordinator.delegateBatch(requests, parsed.data.policy ?? 'primary_decides')
      const passed = run.results.filter(r => r.status === 'passed').length
      return {
        content: run.packet,
        uiContent: `delegate_batch: ${passed}/${run.results.length} passed`,
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

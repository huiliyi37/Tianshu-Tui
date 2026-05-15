import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export interface DelegateTaskCoordinator {
  delegate(request: DelegationRequest): Promise<CoordinatorRun>
}

const delegateTaskInputSchema = z.object({
  objective: z.string().min(1),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
})

function formatUiContent(run: CoordinatorRun): string {
  if (run.status === 'skipped') return 'delegate_task skipped: objective did not pass budget gate'
  const passed = run.results.filter(r => r.status === 'passed').length
  const blocked = run.results.filter(r => r.status === 'blocked').length
  return `delegate_task completed: ${passed} passed, ${blocked} blocked, model=${run.selectedModel ?? 'unknown'}`
}

export function createDelegateTaskTool(coordinator: DelegateTaskCoordinator): Tool {
  return {
    definition: {
      name: 'delegate_task',
      description: 'Run a bounded read-only worker for code search, planning, or review and return structured worker results.',
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Specific read-only objective for the worker.' },
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
        kind: 'code_search',
        profile: 'code_scout',
        scope: {
          files: parsed.data.files,
          symbols: parsed.data.symbols,
        },
      })

      return {
        content: run.packet,
        uiContent: formatUiContent(run),
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

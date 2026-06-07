import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import { aggregationPolicySchema, workOrderKindSchema, type AggregationPolicy } from '../agent/work-order.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ClaimProposal } from '../context/claims.js'
import { profileRegistry } from '../agent/profile-registry.js'
import { validatePathSafe } from './path-validate.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export interface DelegateBatchCoordinator {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
}

/** Dynamic profile validation — accepts built-in + user-loaded profiles */
const profileStringSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `Unknown profile "${val}". Available: ${profileRegistry.getProfileNames().join(', ')}` }),
)

const taskSchema = z.object({
  objective: z.string().min(1),
  kind: workOrderKindSchema.optional(),
  profile: profileStringSchema.optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
})

const inputSchema = z.object({
  tasks: z.array(taskSchema).min(1).max(5),
  policy: aggregationPolicySchema.optional(),
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

/** Progressive timeout: early turns get short budget so the first user
 *  response isn't blocked for 2 minutes.  As the session matures, workers
 *  get more time for deeper analysis.
 *    turn 0-1 (cold open)  → 45 s  — quick scout only
 *    turn 2-4 (warming)    → 90 s  — 2-3 focused tasks
 *    turn 5+  (mature)     → 180 s — full parallel depth
 */
function progressiveBatchTimeout(sessionTurnCount?: number): number {
  const turn = sessionTurnCount ?? 10 // default to mature when unknown
  if (turn <= 1) return 45_000
  if (turn <= 4) return 90_000
  return 180_000
}

/** Progressive task cap: don't fan out 5 workers on a cold session.
 *    turn 0-1 (cold open)  → 1 task  — single focused scout
 *    turn 2-4 (warming)    → 3 tasks — moderate parallelism
 *    turn 5+  (mature)     → 5 tasks — full batch
 */
export function progressiveTaskCap(sessionTurnCount?: number): number {
  const turn = sessionTurnCount ?? 10
  if (turn <= 1) return 1
  if (turn <= 4) return 3
  return 5
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
                kind: { type: 'string', enum: [...workOrderKindSchema.options] },
                profile: { type: 'string', enum: profileRegistry.getProfileNames() },
                files: { type: 'array', items: { type: 'string' } },
                symbols: { type: 'array', items: { type: 'string' } },
              },
              required: ['objective'],
            },
            description: 'Array of tasks to run in parallel (max 5).',
          },
          policy: { type: 'string', enum: [...aggregationPolicySchema.options], description: 'Aggregation policy. Default: primary_decides.' },
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
        profile: (t.profile ?? 'code_scout') as import('../agent/work-order.js').WorkerProfile,
        scope: { files: t.files, symbols: t.symbols },
        reviewDepth: params.reviewDepth,
      }))

      // Progressive task cap: trim to the allowed slice on early turns
      const cap = progressiveTaskCap(params.sessionTurnCount)
      let trimmedNote = ''
      let dispatched = requests
      if (requests.length > cap) {
        const dropped = requests.slice(cap).map(r => r.objective)
        dispatched = requests.slice(0, cap)
        trimmedNote = `\n\n[batch trimmed] Session is early (turn ${params.sessionTurnCount ?? '?'}). Dispatched ${cap}/${requests.length} tasks. Deferred: ${dropped.map(o => `"${o.slice(0, 60)}"`).join(', ')}. Re-dispatch later tasks in a subsequent turn if needed.`
      }

      let progressReported = 0
      let run: CoordinatorRun
      try {
        run = await coordinator.delegateBatch(
          dispatched,
          parsed.data.policy ?? 'primary_decides',
          params.abortSignal,
          (completed, total) => {
            if (completed > progressReported) {
              progressReported = completed
              params.onOutput?.(`⏳ batch progress: ${completed}/${total} workers done\n`)
            }
          },
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [
            `delegate_batch failed: ${msg}`,
            '',
            '⚠️ Do NOT retry this batch with the same parameters — the failure is persistent.',
            '',
            'Recovery options (pick one):',
            '1. Use inline tools instead: read_file, grep, glob, repo_graph for exploration',
            '2. Use delegate_task (singular) for a single focused task with a 30s timeout',
            '3. Reduce batch to 1-2 tasks with simpler, more specific objectives',
            '4. If timeout: subagents exceeded their time budget — simplify the objective text',
          ].join('\n'),
          isError: true,
        }
      }

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
        content: run.packet + trimmedNote,
        uiContent: `delegate_batch: ${passed}/${run.results.length} passed`,
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    timeoutMs: (params) => progressiveBatchTimeout(params?.sessionTurnCount),
  }
}

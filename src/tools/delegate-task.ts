import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ClaimProposal } from '../context/claims.js'
import { DEFAULT_DELEGATE_PROFILE, profileRegistry, delegationToolTimeoutMs } from '../agent/profile-registry.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { validatePathSafe } from './path-validate.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { createActivityStreamer, activityProgressLine } from './worker-activity-stream.js'
import type { WorkerActivityEvent } from '../agent/coordinator.js'

export interface DelegateTaskCoordinator {
  delegate(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun>
}

/** Dynamic profile validation — accepts built-in + user-loaded profiles */
const profileStringSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `Unknown profile "${val}". Available: ${profileRegistry.getProfileNames().join(', ')}` }),
)

/** Dynamic star-domain (authority) validation — accepts built-in + user-loaded domains.
 *  Injects the domain's persona (volatileBlock) + methodology (systemPromptSuffix)
 *  into the worker, and intersects the worker's tools with the domain whitelist. */
const authorityStringSchema = z.string().refine(
  (val) => starDomainRegistry.getDomainIds().includes(val),
  (val) => ({ message: `Unknown authority "${val}". Available: ${starDomainRegistry.getDomainIds().join(', ')}` }),
)

const delegateTaskInputSchema = z.object({
  objective: z.string().min(1),
  kind: z.enum(['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal']).optional(),
  profile: profileStringSchema.optional(),
  authority: authorityStringSchema.optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  resume: z.string().optional().describe(
    'Optional worker ID to resume instead of creating a new worker. When provided, the worker continues from its previous session history. The objective should describe the continuation task.',
  ),
})

function formatUiContent(run: CoordinatorRun): string {
  if (run.status === 'skipped') return 'delegate_task skipped: objective did not pass budget gate'
  const passed = run.results.filter(r => r.status === 'passed').length
  const blocked = run.results.filter(r => r.status === 'blocked').length
  const base = `delegate_task completed: ${passed} passed, ${blocked} blocked, model=${run.selectedModel ?? 'unknown'}`
  if (run.escalated) return `⚠️ ${base}\n[escalated] 子代理连续失败，建议改为内联执行`
  return base
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
          authority: { type: 'string', description: 'Optional star-domain persona (e.g. tianquan, tianji, yuheng). Injects that expert\'s perspective + methodology and restricts tools to its whitelist.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to focus on.' },
          symbols: { type: 'array', items: { type: 'string' }, description: 'Optional symbols to focus on.' },
          resume: { type: 'string', description: 'Worker ID to resume. The worker continues from its previous session context instead of starting fresh. Use the workOrderId from a previous delegate_task result.' },
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

      // T9 P3 text stream + T4 structured per-worker updates (subagent panel).
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      const onActivity = (textStreamer || params.onWorkerActivity)
        ? (ev: WorkerActivityEvent) => {
            textStreamer?.(ev)
            params.onWorkerActivity?.({
              workOrderId: ev.workOrderId,
              parentToolId: params.toolUseId,
              profile: ev.profile,
              authority: ev.authority,
              status: 'running',
              progressLine: activityProgressLine(ev),
            })
          }
        : undefined

      const run = await coordinator.delegate({
        parentTurnId: params.toolUseId,
        objective: parsed.data.objective,
        kind: parsed.data.kind ?? 'code_search',
        profile: (parsed.data.profile ?? DEFAULT_DELEGATE_PROFILE) as import('../agent/work-order.js').WorkerProfile,
        authority: parsed.data.authority,
        scope: {
          files: parsed.data.files,
          symbols: parsed.data.symbols,
        },
        reviewDepth: params.reviewDepth,
        delegationDepth: params.delegationDepth ?? 0,
        sessionTurn: params.sessionTurnCount,
        onActivity,
        resumeWorkOrderId: parsed.data.resume,
      }, params.abortSignal)

      // T4: terminal per-worker status for the subagent panel.
      if (params.onWorkerActivity) {
        for (const r of run.results) {
          params.onWorkerActivity({
            workOrderId: r.workOrderId,
            parentToolId: params.toolUseId,
            authority: parsed.data.authority,
            status: r.status,
            progressLine: r.summary.slice(0, 80),
            model: r.model,
            provider: r.provider,
            usage: r.usage,
            artifactId: r.diffArtifactId,
            changedFiles: r.changedFiles.length > 0 ? r.changedFiles : undefined,
          })
        }
      }

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
    // P0: outer tool timeout must dominate the worker's internal budget
    // (profile defaultTimeoutMs or ladder) so the worker's graceful
    // blocked+partial-output path always wins the race.
    timeoutMs: (params) => delegationToolTimeoutMs(
      params?.sessionTurnCount,
      [params?.input?.profile as string | undefined],
    ),
  }
}

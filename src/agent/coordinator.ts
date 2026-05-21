import type { ModelCapabilityCard, CapabilityTask } from '../model/capability.js'
import { recommendModelForTask } from '../model/capability.js'
import type { ProviderConfig } from '../config/schema.js'
import { filterToolRegistry, ToolRegistry } from '../tools/registry.js'
import { ProviderHealthTracker } from './provider-health.js'
import {
  createReadOnlyWorkOrder,
  createWriteWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  READ_ONLY_WORKER_TOOLS,
  WRITE_WORKER_TOOLS,
  type AggregationPolicy,
  type WorkOrder,
  type WorkOrderKind,
  type WorkerProfile,
  type WorkerResult,
  type WorkOrderScope,
} from './work-order.js'
import { buildPrimaryWorkerPacket } from './worker-prompts.js'
import { runWorkerSession, type WorkerSessionConfig, type WorkerSessionRun } from './worker-session.js'
import { runHandsSession, type HandsSessionConfig, type HandsSessionRun } from './hands-session.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { classifyProfile } from './coordination-policy.js'
import { aggregateResults } from './aggregation.js'
import { CoordinatorState } from './coordinator-state.js'
import { WorkOrderQueue } from './work-queue.js'
import { CollaborationProtocol, type CollaborationConfig } from './collaboration-protocol.js'
import type { LockIntent } from './semantic-lock.js'

export interface DelegationRequest {
  parentTurnId: string
  objective: string
  kind: WorkOrderKind
  profile: WorkerProfile
  scope: WorkOrderScope
}

export interface CoordinatorRun {
  status: 'completed' | 'skipped'
  order?: WorkOrder
  selectedModel?: string
  results: WorkerResult[]
  packet: string
  aggregationPolicy?: AggregationPolicy
}

export type WorkerRuntimeFactory = (
  order: WorkOrder,
  card: ModelCapabilityCard,
  workerRegistry: ToolRegistry,
) => WorkerSessionConfig

export interface WorkerRouteConfig {
  profiles: Record<string, { provider: string; model: string }>
  routing: Record<string, string>
  providers?: Record<string, ProviderConfig>
}

export interface DelegationCoordinatorConfig {
  baseToolRegistry: ToolRegistry
  modelCards: ModelCapabilityCard[]
  maxWorkers: number
  runtimeFactory: WorkerRuntimeFactory
  routing?: WorkerRouteConfig
  runWorker?: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  runHands?: (config: HandsSessionConfig) => Promise<HandsSessionRun>
  cwd?: string
  activeClaims?: () => import('../context/claims.js').ContextClaim[]
  /** Optional provider health tracker for Physarum-style routing.
   *  When set, cold-tier providers are excluded from model selection. */
  providerHealth?: ProviderHealthTracker
  /** Optional session registry for cross-process file claim coordination. */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** Current session ID for claim management. */
  sessionId?: string
  /** Optional collaboration protocol for semantic locking and merge coordination. */
  collaboration?: CollaborationConfig
}

export function shouldDelegateObjective(objective: string, scope: WorkOrderScope): boolean {
  const words = objective.trim().split(/\s+/).filter(Boolean).length
  return words >= 6 || (scope.files?.length ?? 0) >= 2 || (scope.symbols?.length ?? 0) >= 2
}

function workerFailureResult(order: WorkOrder, error: unknown): WorkerResult {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Worker failed: ${reason}`,
    findings: [],
    artifacts: [{ kind: 'risk', title: 'Worker execution failed', content: reason }],
    changedFiles: [],
    risks: [`worker failed: ${reason}`],
    nextActions: ['Primary should continue without trusting this worker result'],
    evidenceStatus: 'blocked',
  }
}

export class DelegationCoordinator {
  private runWorker: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  private runHands: (config: HandsSessionConfig) => Promise<HandsSessionRun>
  private state: CoordinatorState
  private collaboration: CollaborationProtocol | null

  constructor(private config: DelegationCoordinatorConfig) {
    this.runWorker = config.runWorker ?? runWorkerSession
    this.runHands = config.runHands ?? runHandsSession
    this.state = new CoordinatorState(config.maxWorkers)
    this.collaboration = config.collaboration ? new CollaborationProtocol(config.collaboration) : null
  }

  getState(): CoordinatorState {
    return this.state
  }

  private selectModelForTask(task: CapabilityTask): ModelCapabilityCard {
    if (this.config.routing) {
      const routeName = this.config.routing.routing[task]
      if (routeName && this.config.routing.profiles[routeName]) {
        const routeProfile = this.config.routing.profiles[routeName]

        // Physarum routing: skip cold-tier providers
        const skipCold = this.config.providerHealth?.getWeights()
          .find(h => h.providerId === routeProfile.provider && h.tier === 'cold')
        if (!skipCold) {
          const provider = this.config.routing.providers?.[routeProfile.provider]
          const routeModelExists = !provider || provider.models.some(m => m.id === routeProfile.model || m.alias === routeProfile.model)
          const routeHasCredentials = !provider || provider.auth?.type === 'oauth' || Boolean(provider.apiKey || (provider.apiKeyEnv && process.env[provider.apiKeyEnv]))
          if (routeModelExists && routeHasCredentials) {
            const routed = this.config.modelCards.find(c => c.model === routeProfile.model)
            if (routed) return routed
          }
        }
      }
    }
    return recommendModelForTask(task, this.config.modelCards)
  }

  async delegate(request: DelegationRequest): Promise<CoordinatorRun> {
    if (!shouldDelegateObjective(request.objective, request.scope)) {
      return {
        status: 'skipped',
        results: [],
        packet: buildPrimaryWorkerPacket([]),
      }
    }

    const writeProfiles: WorkerProfile[] = ['patcher', 'verifier']
    const isWrite = writeProfiles.includes(request.profile)
    const order = isWrite
      ? createWriteWorkOrder({
          parentTurnId: request.parentTurnId,
          kind: request.kind,
          profile: request.profile,
          objective: request.objective,
          scope: request.scope,
        })
      : createReadOnlyWorkOrder({
          parentTurnId: request.parentTurnId,
          kind: request.kind,
          profile: request.profile,
          objective: request.objective,
          scope: request.scope,
        })

    return this.delegateOrder(order)
  }

  private async delegateOrder(order: WorkOrder): Promise<CoordinatorRun> {
    const role = classifyProfile(order.profile)
    const isWrite = order.allowedTools.some(t => !(READ_ONLY_WORKER_TOOLS as readonly string[]).includes(t))
    this.state.recordEvent({ type: 'queued', workOrderId: order.id, timestamp: Date.now() })

    // Acquire semantic lock via CollaborationProtocol if configured
    if (this.collaboration && this.config.sessionId && order.scope.files?.length) {
      const intent: LockIntent = {
        operation: isWrite ? 'edit' : 'refactor',
        files: order.scope.files,
        description: order.objective,
      }
      const lockResult = this.collaboration.acquireLock(this.config.sessionId, intent)
      if (!lockResult.acquired) {
        return {
          status: 'completed',
          order,
          results: [{
            workOrderId: order.id,
            status: 'blocked',
            summary: `Semantic lock conflict: ${lockResult.conflictingFiles.join(', ')} held by another session`,
            findings: [],
            artifacts: [{ kind: 'risk', title: 'Lock conflict', content: `Files locked by another session: ${lockResult.conflictingFiles.join(', ')}` }],
            changedFiles: [],
            risks: [`semantic lock conflict: ${lockResult.conflictingFiles.join(', ')}`],
            nextActions: ['Wait for other session to release locks, or use non-overlapping file scope'],
            evidenceStatus: 'blocked',
          }],
          packet: buildPrimaryWorkerPacket([]),
        }
      }
    }

    const task = mapWorkOrderKindToCapabilityTask(order.kind)
    const selected = this.selectModelForTask(task)
    const toolSet = isWrite ? WRITE_WORKER_TOOLS : READ_ONLY_WORKER_TOOLS
    const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, toolSet)
    const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)

    this.state.recordEvent({ type: 'running', workOrderId: order.id, timestamp: Date.now() })

    let run: { result: WorkerResult }
    if (role === 'hands') {
      // Check file claims before dispatching write worker
      if (this.config.sessionRegistry && this.config.sessionId && order.scope.files?.length) {
        const registry = this.config.sessionRegistry
        const sid = this.config.sessionId
        const conflictedFiles: string[] = []
        for (const f of order.scope.files) {
          if (!registry.acquireClaim(sid, f, 'exclusive')) {
            conflictedFiles.push(f)
          }
        }
        if (conflictedFiles.length > 0) {
          // Release any claims we did acquire
          for (const f of order.scope.files) {
            if (!conflictedFiles.includes(f)) registry.releaseClaim(sid, f)
          }
          return {
            status: 'completed',
            order,
            results: [{
              workOrderId: order.id,
              status: 'blocked',
              summary: `File claim conflict: ${conflictedFiles.join(', ')} held by another session`,
              findings: [],
              artifacts: [{ kind: 'risk', title: 'Claim conflict', content: `Files claimed by another session: ${conflictedFiles.join(', ')}` }],
              changedFiles: [],
              risks: [`file claim conflict: ${conflictedFiles.join(', ')}`],
              nextActions: ['Wait for other session to release claims, or use read-only profile'],
              evidenceStatus: 'blocked',
            }],
            packet: buildPrimaryWorkerPacket([]),
          }
        }
      }

      const activeClaims = this.config.activeClaims?.() ?? workerConfig.activeClaims ?? []
      const cwd = this.config.cwd ?? workerConfig.cwd
      const handsRun = await this.runHands({
        order,
        wtCoordinator: new WorktreeCoordinator(cwd),
        cwd,
        maxTurns: workerConfig.maxTurns,
        contextWindow: workerConfig.contextWindow,
        compact: workerConfig.compact,
        activeClaims,
        runAgent: async (prompt, callbacks, workerCwd) => {
          const sessionRun = await this.runWorker({
            ...workerConfig,
            order,
            cwd: workerCwd,
            activeClaims,
          })
          callbacks.onTurnComplete(sessionRun.usage, 1, true)
          return JSON.stringify(sessionRun.result)
        },
      })
      run = { result: handsRun.result }
    } else {
      run = await this.runWorker(workerConfig)
    }

    // Release semantic lock after worker completes
    if (this.collaboration && this.config.sessionId) {
      this.collaboration.releaseLocks(this.config.sessionId)
    }

    this.state.recordEvent({ type: run.result.status === 'passed' ? 'passed' : run.result.status === 'blocked' ? 'blocked' : 'failed', workOrderId: order.id, timestamp: Date.now() })

    if (this.state.shouldEscalate()) {
      this.state.recordEvent({ type: 'escalated', workOrderId: order.id, timestamp: Date.now() })
      return {
        status: 'completed',
        order,
        selectedModel: selected.model,
        results: [{ ...run.result, status: 'blocked' as const, summary: `Escalated: ${this.state.getSummary().failed} consecutive failures` }],
        packet: buildPrimaryWorkerPacket([run.result]),
      }
    }

    const results = aggregateResults([run.result], 'primary_decides')

    return {
      status: 'completed',
      order,
      selectedModel: selected.model,
      results,
      packet: buildPrimaryWorkerPacket(results),
    }
  }

  async delegateBatch(requests: DelegationRequest[], policy: AggregationPolicy = 'primary_decides'): Promise<CoordinatorRun> {
    const runnables = requests.filter(r => shouldDelegateObjective(r.objective, r.scope))
    if (runnables.length === 0) {
      return { status: 'skipped', results: [], packet: buildPrimaryWorkerPacket([]) }
    }

    const writeProfiles: WorkerProfile[] = ['patcher', 'verifier']
    const queue = new WorkOrderQueue(this.config.maxWorkers)

    // Pre-create work orders for deduplication and dependency ordering
    const orders: WorkOrder[] = []
    for (const r of runnables) {
      const isWrite = writeProfiles.includes(r.profile)
      const order = isWrite
        ? createWriteWorkOrder({
            parentTurnId: r.parentTurnId,
            kind: r.kind,
            profile: r.profile,
            objective: r.objective,
            scope: r.scope,
          })
        : createReadOnlyWorkOrder({
            parentTurnId: r.parentTurnId,
            kind: r.kind,
            profile: r.profile,
            objective: r.objective,
            scope: r.scope,
          })
      if (queue.enqueue(order)) {
        orders.push(order)
      }
    }

    // Process queue with concurrency control
    const allResults: WorkerResult[] = []
    const inflight: Promise<void>[] = []

    const processNext = async (): Promise<void> => {
      const order = queue.dequeue()
      if (!order) return
      queue.markInFlight(order)
      try {
        const run = await this.delegateOrder(order)
        allResults.push(...run.results)
        queue.markCompleted(order)
      } catch (error) {
        allResults.push(workerFailureResult(order, error))
        queue.markFailed(order)
      }
      // Recurse: try to process next pending order (respecting concurrency limit)
      await processNext()
    }

    // Start initial batch of workers
    for (let i = 0; i < this.config.maxWorkers; i++) {
      inflight.push(processNext())
    }
    await Promise.all(inflight)

    const aggregated = aggregateResults(allResults, policy)
    return {
      status: 'completed',
      results: aggregated,
      packet: buildPrimaryWorkerPacket(aggregated),
      aggregationPolicy: policy,
    }
  }
}

import type { ModelCapabilityCard, CapabilityTask } from '../model/capability.js'
import { recommendModelForTask } from '../model/capability.js'
import { filterToolRegistry, ToolRegistry } from '../tools/registry.js'
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
import { aggregateResults } from './aggregation.js'
import { CoordinatorState } from './coordinator-state.js'

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
}

export interface DelegationCoordinatorConfig {
  baseToolRegistry: ToolRegistry
  modelCards: ModelCapabilityCard[]
  maxWorkers: number
  runtimeFactory: WorkerRuntimeFactory
  routing?: WorkerRouteConfig
  runWorker?: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
}

export function shouldDelegateObjective(objective: string, scope: WorkOrderScope): boolean {
  const words = objective.trim().split(/\s+/).filter(Boolean).length
  return words >= 6 || (scope.files?.length ?? 0) >= 2 || (scope.symbols?.length ?? 0) >= 2
}

export class DelegationCoordinator {
  private runWorker: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  private state: CoordinatorState

  constructor(private config: DelegationCoordinatorConfig) {
    this.runWorker = config.runWorker ?? runWorkerSession
    this.state = new CoordinatorState(config.maxWorkers)
  }

  getState(): CoordinatorState {
    return this.state
  }

  private selectModelForTask(task: CapabilityTask): ModelCapabilityCard {
    if (this.config.routing) {
      const routeName = this.config.routing.routing[task]
      if (routeName && this.config.routing.profiles[routeName]) {
        const routeProfile = this.config.routing.profiles[routeName]
        const routed = this.config.modelCards.find(c => c.model === routeProfile.model)
        if (routed) return routed
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
    this.state.recordEvent({ type: 'queued', workOrderId: order.id, timestamp: Date.now() })

    const task = mapWorkOrderKindToCapabilityTask(order.kind)
    const selected = this.selectModelForTask(task)
    const toolSet = isWrite ? WRITE_WORKER_TOOLS : READ_ONLY_WORKER_TOOLS
    const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, toolSet)
    const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)

    this.state.recordEvent({ type: 'running', workOrderId: order.id, timestamp: Date.now() })
    const run = await this.runWorker(workerConfig)
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

    const allResults: WorkerResult[] = []
    for (let i = 0; i < runnables.length; i += this.config.maxWorkers) {
      const chunk = runnables.slice(i, i + this.config.maxWorkers)
      const runs = await Promise.all(chunk.map(r => this.delegate(r)))
      allResults.push(...runs.flatMap(r => r.results))
    }
    const aggregated = aggregateResults(allResults, policy)

    return {
      status: 'completed',
      results: aggregated,
      packet: buildPrimaryWorkerPacket(aggregated),
      aggregationPolicy: policy,
    }
  }
}

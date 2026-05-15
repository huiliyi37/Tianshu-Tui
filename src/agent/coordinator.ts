import type { ModelCapabilityCard } from '../model/capability.js'
import { recommendModelForTask } from '../model/capability.js'
import { filterToolRegistry, ToolRegistry } from '../tools/registry.js'
import {
  createReadOnlyWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  READ_ONLY_WORKER_TOOLS,
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

export interface DelegationCoordinatorConfig {
  baseToolRegistry: ToolRegistry
  modelCards: ModelCapabilityCard[]
  maxWorkers: number
  runtimeFactory: WorkerRuntimeFactory
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

  async delegate(request: DelegationRequest): Promise<CoordinatorRun> {
    if (!shouldDelegateObjective(request.objective, request.scope)) {
      return {
        status: 'skipped',
        results: [],
        packet: buildPrimaryWorkerPacket([]),
      }
    }

    const order = createReadOnlyWorkOrder({
      parentTurnId: request.parentTurnId,
      kind: request.kind,
      profile: request.profile,
      objective: request.objective,
      scope: request.scope,
    })
    this.state.recordEvent({ type: 'queued', workOrderId: order.id, timestamp: Date.now() })

    const task = mapWorkOrderKindToCapabilityTask(order.kind)
    const selected = recommendModelForTask(task, this.config.modelCards)
    const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, READ_ONLY_WORKER_TOOLS)
    const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)

    this.state.recordEvent({ type: 'running', workOrderId: order.id, timestamp: Date.now() })
    const run = await this.runWorker(workerConfig)
    this.state.recordEvent({ type: run.result.status === 'passed' ? 'passed' : run.result.status === 'blocked' ? 'blocked' : 'failed', workOrderId: order.id, timestamp: Date.now() })

    const results = [run.result]

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

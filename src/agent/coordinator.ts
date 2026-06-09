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
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import { precipitateDomainLessons } from './domain-lesson-precipitate.js'
import { inferModelTierFromCard, recommendModelTier, type ModelRiskTier, type ModelTier, type ModelTierRecommendation } from './model-tier-policy.js'
import { buildHistoricalModelTierState, recommendModelTierArm, type ModelTierBanditRecommendation } from './model-tier-bandit.js'
import { evaluateModelTierGate, type ModelTierGateDecision } from './model-tier-gate.js'
import {
  buildModelTierGatedDecisionEvent,
  buildModelTierShadowEvent,
  persistModelTierGatedDecision,
  persistModelTierShadow,
  type ModelTierGatedDecisionEvent,
  type ModelTierShadowEvent,
} from './model-tier-shadow.js'
import {
  buildGatedInfluenceAuditEvent,
  persistGatedInfluenceAudit,
  type GatedInfluenceAuditEvent,
} from './gated-influence-audit.js'

export interface DelegationRequest {
  parentTurnId: string
  objective: string
  kind: WorkOrderKind
  profile: WorkerProfile
  scope: WorkOrderScope
  /** Review-router re-entrancy depth to pass into worker tool contexts. */
  reviewDepth?: number
  /** Work order IDs this task depends on — propagated to WorkOrder.dependencies. */
  dependencies?: string[]
  /** Logical group identifier for related tasks (e.g. team wave). */
  groupId?: string
  /** Star domain authority for cognitive injection (V3 Component A).
   *  When set, the domain's systemPromptSuffix is injected into the worker prompt
   *  and allowedTools are intersected with the domain's toolWhitelist.
   *  Custom domains are loaded at startup, so this must remain an open string. */
  authority?: string
  /** Team planner risk tier for shadow-only model tier recommendation. */
  riskTier?: ModelRiskTier
}

export interface CoordinatorRun {
  status: 'completed' | 'skipped'
  order?: WorkOrder
  selectedModel?: string
  /** Batch-only metadata: selected worker model per work order. Telemetry only; never affects dispatch. */
  workerModels?: Array<{ workOrderId: string; model: string }>
  /** Append-only tier recommendation telemetry; shadow-only and never affects dispatch. */
  modelTierShadows?: ModelTierShadowEvent[]
  /** Append-only gated tier decisions; applied only behind explicit feature flag and hard gates. */
  modelTierGatedDecisions?: ModelTierGatedDecisionEvent[]
  /** Unified append-only Shadow→Gated audit events; never used as a decision source. */
  gatedInfluenceAudits?: GatedInfluenceAuditEvent[]
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
  /** AbortSignal to propagate to workers — fires when the tool-level timeout
   *  rejects the outer promise, so zombie workers are cleaned up immediately
   *  instead of waiting for their internal 180s timeout. */
  abortSignal?: AbortSignal
  /** V3 Component B: domain knowledge store for precipitate/recall lifecycle.
   *  When provided, coordinator auto-precipitates lessons from worker results. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Optional append-only store for P3/P4-d model tier shadow telemetry and reward history. */
  modelTierShadowStore?: import('./model-tier-shadow.js').ModelTierShadowStore | null
  /** P4-d gated worker tier influence flag. Defaults to shadow-only. */
  modelTierBanditEnabled?: boolean
  /** Append-only unified gated influence audit store. Defaults to modelTierShadowStore when omitted. */
  gatedInfluenceAuditStore?: import('./gated-influence-audit.js').GatedInfluenceAuditStore | null
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

  private selectModelForTask(task: CapabilityTask, preferredTier?: ModelTier): ModelCapabilityCard {
    const eligibleCards = preferredTier
      ? this.config.modelCards.filter(card => inferModelTierFromCard(card) === preferredTier)
      : this.config.modelCards
    const cards = eligibleCards.length > 0 ? eligibleCards : this.config.modelCards

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
            const routed = cards.find(c => c.model === routeProfile.model)
            if (routed) return routed
          }
        }
      }
    }
    return recommendModelForTask(task, cards)
  }

  private buildTierRecommendation(order: WorkOrder): ModelTierRecommendation {
    return recommendModelTier({
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      riskTier: order.riskTier,
      objective: order.objective,
      consecutiveFailures: this.state.getSummary().failed,
    })
  }

  private buildTierShadow(order: WorkOrder, selected: ModelCapabilityCard, recommendation: ModelTierRecommendation): ModelTierShadowEvent {
    return buildModelTierShadowEvent({
      sessionId: this.config.sessionId ?? 'unknown',
      workOrderId: order.id,
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      recommendedTier: recommendation.tier,
      actualModel: selected.model,
      actualTier: inferModelTierFromCard(selected),
      reason: recommendation.reason,
    })
  }

  private evaluateTierInfluence(recommendation: ModelTierRecommendation): { candidate: ModelTierBanditRecommendation; gate: ModelTierGateDecision } {
    const state = buildHistoricalModelTierState(this.config.modelTierShadowStore)
    const candidate = recommendModelTierArm(state)
    const gate = evaluateModelTierGate({
      state,
      candidateArm: candidate.arm,
      ruleRecommendation: recommendation,
      recentFalseGreenRate: state.recentFalseGreenRate,
      scopeHealthSeverity: state.worstScopeHealthSeverity,
      featureFlagEnabled: this.config.modelTierBanditEnabled === true,
    })
    return { candidate, gate }
  }

  async delegate(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun> {
    // Per-call abort signal override — allows the tool pipeline to propagate
    // its timeout signal to the coordinator without mutating config.
    const savedSignal = this.config.abortSignal
    if (abortSignal) this.config.abortSignal = abortSignal
    try {
      if (!shouldDelegateObjective(request.objective, request.scope)) {
        return {
          status: 'skipped',
          results: [],
          packet: buildPrimaryWorkerPacket([]),
        }
      }

      const isWrite = classifyProfile(request.profile) === 'hands'
      // Derive stable WorkOrder ID from parentTurnId when it follows the
      // pattern "prefix:team:T1" — this lets WorkOrderQueue resolve
      // dependencies that reference stable team task IDs.
      const stableId = /\bteam:/.test(request.parentTurnId)
        ? request.parentTurnId.split(':').slice(-2).join(':')
        : undefined
      const order = isWrite
        ? createWriteWorkOrder({
            id: stableId,
            parentTurnId: request.parentTurnId,
            kind: request.kind,
            profile: request.profile,
            objective: request.objective,
            scope: request.scope,
            reviewDepth: request.reviewDepth,
            dependencies: request.dependencies,
            authority: request.authority,
            riskTier: request.riskTier,
          })
        : createReadOnlyWorkOrder({
            id: stableId,
            parentTurnId: request.parentTurnId,
            kind: request.kind,
            profile: request.profile,
            objective: request.objective,
            scope: request.scope,
            reviewDepth: request.reviewDepth,
            dependencies: request.dependencies,
            authority: request.authority,
            riskTier: request.riskTier,
          })

      return await this.delegateOrder(order)
    } finally {
      this.config.abortSignal = savedSignal
    }
  }

  private async delegateOrder(order: WorkOrder): Promise<CoordinatorRun> {
    // Abort guard: if the caller's abort signal fires (e.g. tool-level timeout),
    // reject immediately instead of waiting for the worker's internal 180s timeout.
    // This prevents zombie workers from blocking the main agent loop.
    if (this.config.abortSignal?.aborted) {
      return {
        status: 'completed',
        order,
        results: [workerFailureResult(order, new Error('Delegation aborted: caller signal fired'))],
        packet: buildPrimaryWorkerPacket([]),
      }
    }

    const role = classifyProfile(order.profile)
    const isWrite = role === 'hands'
    this.state.recordEvent({ type: 'queued', workOrderId: order.id, timestamp: Date.now() })

    const task = mapWorkOrderKindToCapabilityTask(order.kind)

    // Scope budget check for exploration workers (code_search, doc_research, plan)
    if (order.kind === 'code_search' || order.kind === 'doc_research' || order.kind === 'plan') {
      if (order.scope.maxFiles !== undefined && (order.scope.files?.length ?? 0) > order.scope.maxFiles) {
        return {
          status: 'completed',
          order,
          results: [{
            workOrderId: order.id,
            status: 'blocked',
            summary: `Scope budget exceeded: ${order.scope.files!.length} files exceeds maxFiles=${order.scope.maxFiles}`,
            findings: [],
            artifacts: [{ kind: 'risk', title: 'Scope budget exceeded', content: `Requested ${order.scope.files!.length} files but maxFiles=${order.scope.maxFiles}` }],
            changedFiles: [],
            risks: [`scope budget: ${order.scope.files!.length} > ${order.scope.maxFiles} maxFiles`],
            nextActions: ['Reduce file scope or increase maxFiles budget'],
            evidenceStatus: 'blocked',
          }],
          packet: buildPrimaryWorkerPacket([]),
        }
      }
    }

    const tierRecommendation = this.buildTierRecommendation(order)
    const tierInfluence = this.evaluateTierInfluence(tierRecommendation)
    const selected = this.selectModelForTask(task, tierInfluence.gate.applied ? tierInfluence.gate.effectiveTier : undefined)
    const selectedTier = inferModelTierFromCard(selected)
    const tierShadow = this.buildTierShadow(order, selected, tierRecommendation)
    const tierGatedDecision = buildModelTierGatedDecisionEvent({
      sessionId: this.config.sessionId ?? 'unknown',
      workOrderId: order.id,
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      ruleTier: tierRecommendation.tier,
      candidateTier: tierInfluence.candidate.tier,
      applied: tierInfluence.gate.applied,
      gateOpen: tierInfluence.gate.gateOpen,
      reason: `${tierInfluence.gate.reason}; ${tierInfluence.candidate.reason}`,
      selectedModel: selected.model,
      selectedTier,
    })
    const gatedInfluenceAudit = buildGatedInfluenceAuditEvent({
      source: 'model_tier_bandit',
      sessionId: this.config.sessionId ?? 'unknown',
      targetId: order.id,
      gateOpen: tierInfluence.gate.gateOpen,
      applied: tierInfluence.gate.applied,
      reason: tierInfluence.gate.reason,
      evidenceWindow: {
        ...tierInfluence.gate.evidenceWindow,
        candidateConfidence: tierInfluence.candidate.confidence,
        candidateScore: tierInfluence.candidate.score,
        selectedTier,
      },
      vetoSignals: tierInfluence.gate.vetoSignals,
    })
    persistModelTierShadow(this.config.modelTierShadowStore, tierShadow)
    persistModelTierGatedDecision(this.config.modelTierShadowStore, tierGatedDecision)
    persistGatedInfluenceAudit(this.config.gatedInfluenceAuditStore ?? this.config.modelTierShadowStore, gatedInfluenceAudit)
    // Use the work order's allowedTools (from ProfileRegistry) instead of hardcoded sets
    const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, order.allowedTools)
    const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)
    workerConfig.reviewDepth = order.reviewDepth
    workerConfig.domainKnowledgeStore = this.config.domainKnowledgeStore
    // Propagate parent abort signal so worker stops immediately on abort
    // instead of waiting for its internal budget timeout (中间层 #1).
    workerConfig.abortSignal = this.config.abortSignal

    this.state.recordEvent({ type: 'running', workOrderId: order.id, timestamp: Date.now() })

    let run: { result: WorkerResult; transcript?: WorkerSessionRun['transcript'] }

    // Wrap worker execution with abort signal so the caller unblocks immediately
    // when the tool-level timeout fires, instead of waiting for the worker's
    // internal 180s timeout. The worker's own agent.abort() will fire from its
    // internal timer, but we don't block on it.
    //
    // IMPORTANT: wrapAbort guarantees listener cleanup. If the worker resolves
    // before the signal fires, the 'abort' listener is removed to prevent
    // accumulation across repeated delegate calls in a long session.
    const abortSignal = this.config.abortSignal

    const wrapAbort = <T>(p: Promise<T>): Promise<T> => {
      if (!abortSignal) return p
      if (abortSignal.aborted) return Promise.reject(new Error('Delegation aborted: caller signal already fired'))

      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error('Delegation aborted: caller signal fired'))
        abortSignal.addEventListener('abort', onAbort, { once: true })

        p.then(
          (result) => {
            abortSignal.removeEventListener('abort', onAbort)
            resolve(result)
          },
          (err) => {
            abortSignal.removeEventListener('abort', onAbort)
            reject(err)
          },
        )
      })
    }

    let semanticLockAcquired = false
    // Acquire semantic lock via CollaborationProtocol only after all pre-dispatch
    // validation has passed. Otherwise early blocked returns (e.g. scope budget)
    // would need cleanup too and could leak fail-closed locks.
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
      semanticLockAcquired = true
    }

    try {
      if (role === 'hands') {
        const acquiredClaimFiles: string[] = []
        try {
          // Check file claims before dispatching write worker
          if (this.config.sessionRegistry && this.config.sessionId && order.scope.files?.length) {
            const registry = this.config.sessionRegistry
            const sid = this.config.sessionId
            const conflictedFiles: string[] = []
            for (const f of order.scope.files) {
              if (registry.acquireClaim(sid, f, 'exclusive')) {
                acquiredClaimFiles.push(f)
              } else {
                conflictedFiles.push(f)
              }
            }
            if (conflictedFiles.length > 0) {
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
          // Write workers (patcher/verifier) execute in an isolated git worktree.
          // Worktree lifecycle is managed by runHands → runHandsSession: create
          // before agent runs, collect diff after, cleanup on exit.
          // NOTE: The host agent framework (Claude Code etc.) may still sandbox
          // subagent write operations (edit_file/write_file/bash) even when Rivet
          // correctly provisions write tools and worktree isolation. This is a
          // host-layer constraint, not a Rivet work-order or worktree bug.
          const handsRun = await wrapAbort(this.runHands({
            order,
            wtCoordinator: new WorktreeCoordinator(cwd),
            cwd,
            maxTurns: workerConfig.maxTurns,
            contextWindow: workerConfig.contextWindow,
            compact: workerConfig.compact,
            activeClaims,
            domainKnowledgeStore: this.config.domainKnowledgeStore,
            runAgent: async (prompt, callbacks, workerCwd) => {
              const sessionRun = await this.runWorker({
                ...workerConfig,
                order,
                cwd: workerCwd,
                activeClaims,
                domainKnowledgeStore: this.config.domainKnowledgeStore,
              })
              callbacks.onTurnComplete(sessionRun.usage, 1, true)
              return JSON.stringify(sessionRun.result)
            },
          }))
          run = { result: handsRun.result }
        } finally {
          if (this.config.sessionRegistry && this.config.sessionId) {
            for (const file of acquiredClaimFiles) {
              this.config.sessionRegistry.releaseClaim(this.config.sessionId, file)
            }
          }
        }
      } else {
        const workerRun = await wrapAbort(this.runWorker(workerConfig))
        run = { result: workerRun.result, transcript: workerRun.transcript }
      }
    } finally {
      if (semanticLockAcquired && this.collaboration && this.config.sessionId) {
        this.collaboration.releaseLocks(this.config.sessionId)
      }
    }

    this.state.recordEvent({ type: run.result.status === 'passed' ? 'passed' : run.result.status === 'blocked' ? 'blocked' : 'failed', workOrderId: order.id, timestamp: Date.now() })

    if (this.state.shouldEscalate()) {
      this.state.recordEvent({ type: 'escalated', workOrderId: order.id, timestamp: Date.now() })
      return {
        status: 'completed',
        order,
        selectedModel: selected.model,
        modelTierShadows: [tierShadow],
        modelTierGatedDecisions: [tierGatedDecision],
        gatedInfluenceAudits: [gatedInfluenceAudit],
        results: [{ ...run.result, status: 'blocked' as const, summary: `Escalated: ${this.state.getSummary().failed} consecutive failures` }],
        packet: buildPrimaryWorkerPacket([run.result]),
      }
    }

    const profileMap = new Map([[order.id, order.profile]])
    const transcriptMap = run.transcript ? new Map([[order.id, run.transcript]]) : undefined
    const results = aggregateResults([run.result], 'primary_decides', profileMap, transcriptMap)

    // V3 Component B-loop: precipitate domain lessons from results
    if (order.authority && this.config.domainKnowledgeStore) {
      precipitateDomainLessons(this.config.domainKnowledgeStore, {
        domainId: order.authority,
        results,
        objective: order.objective,
      })
    }

    return {
      status: 'completed',
      order,
      selectedModel: selected.model,
      modelTierShadows: [tierShadow],
      modelTierGatedDecisions: [tierGatedDecision],
      gatedInfluenceAudits: [gatedInfluenceAudit],
      results,
      packet: buildPrimaryWorkerPacket(results),
    }
  }

  async delegateBatch(
    requests: DelegationRequest[],
    policy: AggregationPolicy = 'primary_decides',
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun> {
    // Per-call abort signal override
    const savedSignal = this.config.abortSignal
    if (abortSignal) this.config.abortSignal = abortSignal
    try {
      const runnables = requests.filter(r => shouldDelegateObjective(r.objective, r.scope))
      if (runnables.length === 0) {
        return { status: 'skipped', results: [], packet: buildPrimaryWorkerPacket([]) }
      }

    const queue = new WorkOrderQueue(this.config.maxWorkers)

    // Pre-create work orders for deduplication and dependency ordering
    const orders: WorkOrder[] = []
    for (const r of runnables) {
      const isWrite = classifyProfile(r.profile) === 'hands'
      const stableId = /\bteam:/.test(r.parentTurnId)
        ? r.parentTurnId.split(':').slice(-2).join(':')
        : undefined
      const order = isWrite
        ? createWriteWorkOrder({
            id: stableId,
            parentTurnId: r.parentTurnId,
            kind: r.kind,
            profile: r.profile,
            objective: r.objective,
            scope: r.scope,
            reviewDepth: r.reviewDepth,
            dependencies: r.dependencies,
            authority: r.authority,
            riskTier: r.riskTier,
          })
        : createReadOnlyWorkOrder({
            id: stableId,
            parentTurnId: r.parentTurnId,
            kind: r.kind,
            profile: r.profile,
            objective: r.objective,
            scope: r.scope,
            reviewDepth: r.reviewDepth,
            dependencies: r.dependencies,
            authority: r.authority,
            riskTier: r.riskTier,
          })
      if (queue.enqueue(order)) {
        orders.push(order)
      }
    }

    // Process queue with concurrency control
    const allResults: WorkerResult[] = []
    const workerModels: NonNullable<CoordinatorRun['workerModels']> = []
    const modelTierShadows: ModelTierShadowEvent[] = []
    const modelTierGatedDecisions: ModelTierGatedDecisionEvent[] = []
    const gatedInfluenceAudits: GatedInfluenceAuditEvent[] = []
    const inflight: Promise<void>[] = []
    let completedCount = 0

    const processNext = async (): Promise<void> => {
      const order = queue.dequeue()
      if (!order) return
      queue.markInFlight(order)
      try {
        const run = await this.delegateOrder(order)
        allResults.push(...run.results)
        if (run.modelTierShadows) modelTierShadows.push(...run.modelTierShadows)
        if (run.modelTierGatedDecisions) modelTierGatedDecisions.push(...run.modelTierGatedDecisions)
        if (run.gatedInfluenceAudits) gatedInfluenceAudits.push(...run.gatedInfluenceAudits)
        if (run.selectedModel) {
          workerModels.push({ workOrderId: order.id, model: run.selectedModel })
        }
        queue.markCompleted(order)
      } catch (error) {
        allResults.push(workerFailureResult(order, error))
        queue.markFailed(order)
      }
      completedCount++
      onProgress?.(completedCount, orders.length)
      // Recurse: try to process next pending order (respecting concurrency limit)
      await processNext()
    }

    // Start initial batch of workers
    for (let i = 0; i < this.config.maxWorkers; i++) {
      inflight.push(processNext())
    }
    await Promise.all(inflight)

    const profileMap = new Map(orders.map(o => [o.id, o.profile] as const))
    const aggregated = aggregateResults(allResults, policy, profileMap)
    return {
      status: 'completed',
      results: aggregated,
      packet: buildPrimaryWorkerPacket(aggregated),
      aggregationPolicy: policy,
      ...(workerModels.length > 0 ? { workerModels } : {}),
      ...(modelTierShadows.length > 0 ? { modelTierShadows } : {}),
      ...(modelTierGatedDecisions.length > 0 ? { modelTierGatedDecisions } : {}),
      ...(gatedInfluenceAudits.length > 0 ? { gatedInfluenceAudits } : {}),
    }
    // NOTE: If delegateBatch is ever changed from serial (processNext recursion)
    // to true concurrent execution, the finally-based signal restoration below
    // will race with in-flight orders — they'll lose access to the signal
    // mid-flight. In that case, pass abortSignal per-call to delegateOrder
    // instead of mutating config.abortSignal.
    } finally {
      this.config.abortSignal = savedSignal
    }
  }
}

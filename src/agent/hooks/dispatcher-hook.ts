import type { AfterPerceptionRuntimeHook } from '../runtime-hooks.js'
import type { TaskContract } from '../../context/task-contract.js'
import type { Sensorium } from '../sensorium.js'
import type { DelegationCoordinator, DelegationRequest } from '../coordinator.js'
import type { WorkOrderKind, WorkerProfile } from '../work-order.js'
import type { DomainArea } from '../work-order.js'
import { decomposeByDataContract } from '../dispatcher.js'
import { matchDomain } from '../star-domain.js'
import { profileRegistry } from '../profile-registry.js'
import { shouldDelegateObjective as _shouldDelegate } from '../coordinator.js'

export interface DispatcherHookDeps {
  /** Lazy getter for coordinator — called each turn so stale references are never used. */
  coordinator: () => DelegationCoordinator | null
  getTaskContract: () => TaskContract | undefined
  getSensorium: () => Sensorium | null
  complexityThreshold?: number
  /** Kill-switch: disable auto-delegation entirely. Default: true (enabled). */
  enabled?: boolean
  /** Minimum turns between auto-delegation spawns. Default: 3. */
  cooldownTurns?: number
}

export function createDispatcherHook(deps: DispatcherHookDeps): AfterPerceptionRuntimeHook {
  /** Per-contract.id dedup: track which contracts have been dispatched. */
  const dispatchedIds = new Set<string>()
  /** Last turn an auto-delegation was spawned. */
  let lastDispatchTurn = -Infinity

  return {
    phase: 'afterPerception',
    name: 'task-dispatcher',
    async run(ctx) {
      // Kill-switch: respect config.agent.autoDelegateEnabled
      if (deps.enabled === false) return
      const coordinator = deps.coordinator()
      if (!coordinator) return

      // 冷却: skip if last auto-delegation was within cooldownTurns
      const cooldown = deps.cooldownTurns ?? 3
      if (ctx.snapshot.turn - lastDispatchTurn < cooldown) return

      const contract = deps.getTaskContract()
      if (!contract || !contract.isActionable) return

      // Per-contract.id dedup: each contract only auto-dispatches once
      if (dispatchedIds.has(contract.id)) return

      // 复用 shouldDelegateObjective 门槛（内联判断，TaskContract.scope 与 WorkOrderScope 结构不同）
      const wordCount = contract.objective.trim().split(/\s+/).filter(Boolean).length
      const fileCount = contract.scope.mentionedFiles?.length ?? 0
      if (wordCount < 6 && fileCount < 2) return

      const sensorium = deps.getSensorium()
      const threshold = deps.complexityThreshold ?? 0.3
      if (sensorium && sensorium.complexity < threshold) return

      const subtasks = decomposeByDataContract(contract)
      if (subtasks.length <= 1) return

      // 转换为 DelegationRequest[]，喂入现有 coordinator
      const requests: DelegationRequest[] = subtasks.map(st => ({
        parentTurnId: `dispatcher-${contract.id}`,
        objective: st.objective,
        kind: inferWorkOrderKind(st.domain),
        profile: inferWorkerProfile(st.domain),
        scope: st.scope,
        authority: st.authority,
      }))

      // 通过现有 coordinator 执行（复用模型路由、工具过滤、session 隔离）
      // TaskBoard 通过 queue 事件自动更新，不需要手动调用
      for (const req of requests) {
        coordinator.delegate(req).catch(error => {
          const msg = error instanceof Error ? error.message : String(error)
          ctx.effects.emitPhaseChange('worker-failed', { reason: msg })
        })
      }

      dispatchedIds.add(contract.id)
      lastDispatchTurn = ctx.snapshot.turn
      ctx.effects.emitPhaseChange('task-decomposed', {
        reason: `${subtasks.length} subtasks by data-flow analysis`,
        suggestion: subtasks.map(t => `${t.domain}:${t.authority}`).join(', '),
      })
    },
  }
}

function inferWorkOrderKind(domain: DomainArea): WorkOrderKind {
  if (domain === 'tests') return 'verify'
  if (domain === 'docs') return 'doc_research'
  // Auto-delegation is read-only only. Frontend/backend/tools/config
  // all get code_search (exploration), never patch_proposal (write).
  // Write operations require explicit delegate_task from primary agent.
  return 'code_search'
}

function inferWorkerProfile(domain: DomainArea): WorkerProfile {
  // Try registry first — user-defined profiles may declare defaultKind
  for (const p of profileRegistry.list()) {
    if (p.defaultKind === domain) return p.name as WorkerProfile
  }
  // Built-in fallbacks
  if (domain === 'tests') return 'verifier'
  if (domain === 'docs') return 'doc_scout'
  return 'code_scout'
}

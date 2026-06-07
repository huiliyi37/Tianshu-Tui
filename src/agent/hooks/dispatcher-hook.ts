import type { AfterPerceptionRuntimeHook } from '../runtime-hooks.js'
import type { TaskContract } from '../../context/task-contract.js'
import type { Sensorium } from '../sensorium.js'
import type { DelegationCoordinator, DelegationRequest } from '../coordinator.js'
import type { WorkOrderKind, WorkerProfile } from '../work-order.js'
import type { DomainArea } from '../work-order.js'
import { decomposeByDataContract } from '../dispatcher.js'
import { matchDomain } from '../star-domain.js'
import { profileRegistry } from '../profile-registry.js'

export interface DispatcherHookDeps {
  coordinator: DelegationCoordinator
  getTaskContract: () => TaskContract | undefined
  getSensorium: () => Sensorium | null
  complexityThreshold?: number
}

export function createDispatcherHook(deps: DispatcherHookDeps): AfterPerceptionRuntimeHook {
  let dispatched = false

  return {
    phase: 'afterPerception',
    name: 'task-dispatcher',
    async run(ctx) {
      if (dispatched) return

      const contract = deps.getTaskContract()
      if (!contract || !contract.isActionable) return

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
        deps.coordinator.delegate(req).catch(error => {
          const msg = error instanceof Error ? error.message : String(error)
          ctx.effects.emitPhaseChange('worker-failed', { reason: msg })
        })
      }

      dispatched = true
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
  // frontend/backend/tools/config 都可能需要修改代码
  return 'patch_proposal'
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

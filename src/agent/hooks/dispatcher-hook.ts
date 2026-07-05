import type { AfterPerceptionRuntimeHook } from '../runtime-hooks.js'
import type { TaskContract } from '../../context/task-contract.js'
import type { Sensorium } from '../sensorium.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { decomposeByDataContract } from '../dispatcher.js'

export interface DispatcherHookDeps {
  getTaskContract: () => TaskContract | undefined
  getSensorium: () => Sensorium | null
  /** Unified advisory bus — the delegation suggestion is routed here (prefix-cache safe).
   *  Without it the hook only emits the UI phase-change signal. */
  advisoryBus?: AdvisoryBus
  complexityThreshold?: number
  /** Local kill-switch once registered. NB: delegation advisory is system-level
   *  opt-in — this hook is only registered when config.agent.autoDelegateEnabled is
   *  true (default false). This flag is a per-instance override on top of that. */
  enabled?: boolean
  /** Minimum turns between advisory emissions. Default: 3. */
  cooldownTurns?: number
}

/**
 * Delegation advisor — model-driven, not an actor.
 *
 * When an actionable, sufficiently-complex TaskContract decomposes into >1
 * cross-domain subtask, this hook submits a single advisory suggesting the
 * primary agent explicitly call delegate_batch (with dependency hints). It
 * never spawns workers itself — the delegation decision stays with the model,
 * which keeps the prefix cache stable and reuses the coordinator's existing
 * dependency queue, file-conflict serialization, and aggregation.
 */
export function createDispatcherHook(deps: DispatcherHookDeps): AfterPerceptionRuntimeHook {
  /** Per-contract.id dedup: track which contracts have already been advised. */
  const advisedIds = new Set<string>()
  /** Last turn an advisory was emitted. */
  let lastAdvisoryTurn = -Infinity

  return {
    phase: 'afterPerception',
    name: 'task-dispatcher',
    async run(ctx) {
      // Kill-switch
      if (deps.enabled === false) return

      // 冷却: skip if last advisory was within cooldownTurns
      const cooldown = deps.cooldownTurns ?? 3
      if (ctx.snapshot.turn - lastAdvisoryTurn < cooldown) return

      const contract = deps.getTaskContract()
      if (!contract || !contract.isActionable) return

      // Per-contract.id dedup: each contract is advised at most once
      if (advisedIds.has(contract.id)) return

      // 复用 shouldDelegateObjective 门槛（内联判断，TaskContract.scope 与 WorkOrderScope 结构不同）
      const wordCount = contract.objective.trim().split(/\s+/).filter(Boolean).length
      const fileCount = contract.scope.mentionedFiles?.length ?? 0
      if (wordCount < 6 && fileCount < 2) return

      const sensorium = deps.getSensorium()
      const threshold = deps.complexityThreshold ?? 0.3
      if (sensorium && sensorium.complexity < threshold) return

      const subtasks = decomposeByDataContract(contract)
      if (subtasks.length <= 1) return

      // 建议模型显式委派——不替它行动。依赖箭头来自 decomposeByDataContract 的 dependsOn
      // （A←[B] 表示 A 依赖 B，B 必须先跑）。C2: 每个子任务的 authority（星域人格）
      // 已由 dispatcher 算出（缺省天梁），透传进建议参数，否则自动委派的执行子任务
      // 会丢失人格注入（team 路径的 patcher 硬绑 tianliang，这里对齐）。
      const depHint = subtasks
        .map(st => {
          const base = `${st.domain}(authority:${st.authority})`
          return st.dependsOn.length > 0
            ? `${base}←[${st.dependsOn.map(d => subtasks[d]?.domain ?? `#${d}`).join(',')}]`
            : base
        })
        .join('; ')

      deps.advisoryBus?.submit({
        key: `delegation-advisor:${contract.id}`,
        priority: 0.5,
        category: 'delegation',
        ttl: 2,
        content: `【天梁】检测到可并行拆分为 ${subtasks.length} 个子任务（${depHint}）。如需并行推进，显式调 delegate_batch，按上面顺序列 tasks，每个 task 带上括号内的 authority（星域人格注入），并用 dependsOn 传被依赖任务的 0-based 下标（被指向方先跑）；只读探查用 code_search profile。`,
      })

      advisedIds.add(contract.id)
      lastAdvisoryTurn = ctx.snapshot.turn
      ctx.effects.emitPhaseChange('task-decomposed', {
        reason: `${subtasks.length} subtasks by data-flow analysis`,
        suggestion: subtasks.map(t => t.domain).join(', '),
      })
    },
  }
}

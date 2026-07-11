import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Gate-Block Guard（被拦不弃守护）— postTurn hook。
 *
 * 失败模式：工具被系统闸门（TDD/destructive/deny/doom-loop/reliability/…）
 * 连续拦截后，模型倾向放弃深入排查、快速收窄结论（"工具层不可用"式脑补）。
 *
 * 机制：tool-pipeline 在每个 gate 拦截点经 onGateBlocked 上报，loop 持
 * turn 级计数；本 hook postTurn 读取——单 turn 被拦 ≥ threshold（默认 2）
 * 次时提交 discipline advisory，指出被拦不是死路、逐条执行拦截文案里的
 * 替代路径。
 *
 * per-key cooldown（天权补充）：同 key 触发后 N 轮（默认 3）内不重发。
 * 冷却放 hook 侧（发射端）而非依赖 advisory-bus 渲染层去重——spam 源是
 * hook 每 turn 重新 submit ttl=1 条目，必须在发射端拦。连续被拦场景
 * （如反复 git stash 被 destructive-gate 拦）由此不叠加。
 *
 * expect 谓词：2 轮内出现探针工具（read_file/grep/glob/list_dir/run_tests）
 * = 模型转向了取证路径 = 采纳。
 */

export interface GateBlockGuardHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 读取并清零本 turn 的被拦事件（kind 列表）。loop 持 counter，pipeline 累计。 */
  drainBlockedKinds: () => string[]
  /** 单 turn 被拦次数触发阈值，默认 2。 */
  threshold?: number
  /** per-key 冷却轮数，默认 3。 */
  cooldownTurns?: number
}

/** 采纳判定的探针工具集——被拦后转向取证 = 采纳。 */
const PROBE_TOOLS = ['read_file', 'grep', 'glob', 'list_dir', 'run_tests']

export function createGateBlockGuardHook(deps: GateBlockGuardHookDeps): PostTurnRuntimeHook {
  const threshold = deps.threshold ?? 2
  const cooldown = deps.cooldownTurns ?? 3
  let lastFiredTurn = -Infinity

  return {
    phase: 'postTurn',
    name: 'gate-block-guard',
    run(ctx: RuntimeHookContext): void {
      // 每轮必 drain（清零 turn 级计数），冷却期内也要清，否则计数跨 turn 累积。
      const kinds = deps.drainBlockedKinds()
      if (kinds.length < threshold) return

      const turn = ctx.snapshot.turn
      if (turn - lastFiredTurn < cooldown) return
      lastFiredTurn = turn

      const kindSummary = [...new Set(kinds)].join('/')
      deps.advisoryBus.submit({
        key: 'gate-block-guard',
        priority: 0.6,
        tier: 'operational',
        category: 'discipline',
        content: `本轮 ${kinds.length} 次工具调用被系统闸门拦截（${kindSummary}）。被拦不是死路也不是失败证据——逐条执行拦截文案里给出的替代路径；无替代路径时转只读取证（read_file/grep）+ .rivet/scratch/ 探针继续排查。不要因被拦收窄结论或放弃深入。`,
        ttl: 1,
        expect: { kind: 'tool_appears', tools: PROBE_TOOLS, withinTurns: 2 },
      })
    },
  }
}

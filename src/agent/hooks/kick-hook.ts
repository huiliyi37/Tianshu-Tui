import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import { buildKickActions, shouldEscalateFromKick, shouldKick } from '../dissipative-kick.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'

export interface KickRuntimeHookDeps {
  deposit: (deposit: PheromoneDeposit) => Promise<void>
}

export function createKickRuntimeHook(deps: KickRuntimeHookDeps): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'dissipative-kick',
    async run(ctx) {
      const sensorium = ctx.snapshot.sensorium
      if (!sensorium || !shouldKick(sensorium)) return

      const recentFailed = ctx.snapshot.recentToolHistory
        .filter(h => h.status === 'failed')
        .map(h => h.target)
        .filter((target): target is string => Boolean(target))

      const kickActions = buildKickActions(sensorium, ctx.snapshot.cwd, recentFailed)

      for (const path of kickActions.deadEndPaths) {
        await deps.deposit({ path, signal: 'dead-end', strength: 0.9 })
      }

      const fullMessage = kickActions.alternativeFrameworks.length > 0
        ? `${kickActions.injectedMessage}\n\n**替代框架：**\n${kickActions.alternativeFrameworks.map(f => `- ${f}`).join('\n')}`
        : kickActions.injectedMessage

      if (fullMessage) {
        ctx.effects.injectUserMessage(fullMessage)
      }

      if (shouldEscalateFromKick(sensorium)) {
        ctx.effects.emitPhaseChange('tianshu-encore', {
          reason: 'Dissipative kick: stagnation detected',
          suggestion: 'Escalate to stronger model or reframe the problem',
        })
      }
    },
  }
}

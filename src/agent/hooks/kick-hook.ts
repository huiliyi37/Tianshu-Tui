import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import { buildKickActions, shouldEscalateFromKick, shouldKick } from '../dissipative-kick.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'
import type { AdvisoryBus } from '../advisory-bus.js'

export interface KickRuntimeHookDeps {
  deposit: (deposit: PheromoneDeposit) => Promise<void>
  /** Number of turns to wait before allowing another kick. Default 3. */
  cooldownTurns?: number
  /** When true, convergence already injected this turn — skip to avoid duplicate "you're stuck" messages. */
  wasConvergenceTriggered?: () => boolean
  /** A1: unified advisory bus — kick messages route through Bus instead of injectUserMessage. */
  advisoryBus?: AdvisoryBus
}

export function createKickRuntimeHook(deps: KickRuntimeHookDeps): PreTurnRuntimeHook {
  const cooldown = deps.cooldownTurns ?? 3
  let lastKickTurn = -Infinity

  return {
    phase: 'preTurn',
    name: 'dissipative-kick',
    async run(ctx) {
      const sensorium = ctx.snapshot.sensorium
      if (!sensorium || !shouldKick(sensorium)) return

      // Mutual exclusion: if convergence already injected this turn, skip
      // to avoid duplicate "you're stuck" messages.
      if (deps.wasConvergenceTriggered?.()) return

      // Cooldown: skip if we kicked within the last N turns
      const currentTurn = ctx.snapshot.turn
      if (currentTurn - lastKickTurn < cooldown) return

      lastKickTurn = currentTurn

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
        if (deps.advisoryBus) {
          deps.advisoryBus.submit({
            key: 'dissipative-kick',
            priority: 0.55,
            tier: 'operational',
            category: 'discipline',
            content: fullMessage,
          })
        } else {
          ctx.effects.injectUserMessage(fullMessage)
        }
      }

      const escalate = shouldEscalateFromKick(sensorium)

      // R4 — externalize the course-correction. The kick just injected a
      // reframing into the agent's context; surface it as a structured signal so
      // the desktop can render a "改道" card and the user sees stuck → nudge →
      // (the agent's next action). Only emit when there's a concrete reframing.
      if (kickActions.injectedMessage) {
        ctx.effects.emitDecisionShift({
          source: 'kick',
          domain: '天璇',
          reason: kickActions.injectedMessage,
          methods: kickActions.alternativeFrameworks,
          severity: escalate ? 'warn' : 'info',
        })
      }

      if (escalate) {
        ctx.effects.emitPhaseChange('tianshu-encore', {
          reason: 'Dissipative kick: stagnation detected',
          suggestion: 'Escalate to stronger model or reframe the problem',
        })
      }
    },
  }
}

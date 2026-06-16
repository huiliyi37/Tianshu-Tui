import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import type { PheromoneRef } from '../sensorium.js'
import { compressDeadEnds, formatDeadEndRules } from '../../context/dead-end-rules.js'
import type { DeadEndEntry } from '../../context/dead-end-rules.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { shouldKick } from '../dissipative-kick.js'

export interface SignalConsumerRuntimeHookOptions {
  /** Avoid repeating identical injected hints across turns. Default true. */
  dedupe?: boolean
  /** When provided, dead-end signals route through the advisory bus instead of injectUserMessage. */
  advisoryBus?: AdvisoryBus
}

export function createSignalConsumerRuntimeHook(options: SignalConsumerRuntimeHookOptions = {}): PreTurnRuntimeHook {
  const dedupe = options.dedupe ?? true
  const emitted = new Set<string>()

  function once(key: string, emit: () => void): void {
    if (dedupe && emitted.has(key)) return
    emitted.add(key)
    emit()
  }

  return {
    phase: 'preTurn',
    name: 'signal-consumer',
    run(ctx) {
      const strategy = ctx.snapshot.strategy
      const pressure = ctx.snapshot.sensoriumInput?.pressureResult
      const pheromones = ctx.snapshot.sensoriumInput?.pheromones ?? []

      if (strategy?.explorationBreadth !== undefined && strategy.explorationBreadth > 0.6) {
        once('search-breadth:wide', () => {
          ctx.effects.injectUserMessage('<search-breadth mode="wide" />')
        })
      }

      if (strategy?.commitThreshold !== undefined && strategy.commitThreshold > 0.8) {
        once('phase:cautious:high-commit-threshold', () => {
          ctx.effects.emitPhaseChange('cautious', { reason: 'high commit threshold' })
        })
      }

      if (pressure?.suggestion === 'task_decomposition') {
        once('pressure:task-decomposition', () => {
          ctx.effects.injectUserMessage('<天梁-感知 type="decomposition">检测到任务过大，建议拆分为子步骤后逐一完成。天梁的分波执行节奏：先完成一个子目标并验证，再推进下一步。</天梁-感知>')
        })
      }

      const deadEnds = pheromones.filter(p => p.signal === 'dead-end' && p.strength > 0)
      if (deadEnds.length > 0) {
        // Kick mutual exclusion: if sensorium shows the kick condition
        // (momentum < 0.2 && stability < 0.3), the kick hook will fire this
        // turn and inject its own reframing — suppress dead-end advisory
        // to avoid redundant "you're stuck" noise.
        if (ctx.snapshot.sensorium && shouldKick(ctx.snapshot.sensorium)) return

        const recentTargets = ctx.snapshot.recentToolHistory.map(t => t.target).filter(Boolean)
        const hasFileContext = recentTargets.length > 0
        const relevant = hasFileContext
          ? deadEnds.filter(p => {
              for (const rt of recentTargets) {
                if (p.path.includes(rt) || rt.includes(p.path)) return true
              }
              return false
            })
          : deadEnds
        if (relevant.length === 0) return
        const seen = new Set<string>()
        const entries: DeadEndEntry[] = []
        for (const p of relevant) {
          if (!seen.has(p.path)) {
            seen.add(p.path)
            entries.push({ path: p.path, context: p.context })
          }
        }
        const rules = compressDeadEnds(entries)
        if (rules.length > 0) {
          const key = `dead-end:${rules.map(r => r.kind).sort().join('|')}`
          once(key, () => {
            if (options.advisoryBus) {
              options.advisoryBus.submit({
                key,
                priority: 0.65,
                category: 'dead_end',
                content: formatDeadEndRules(rules),
                ttl: 2,
              })
            } else {
              ctx.effects.injectUserMessage(formatDeadEndRules(rules))
            }
          })
        }
      }
    },
  }
}

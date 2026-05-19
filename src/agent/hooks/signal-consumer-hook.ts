import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import type { PheromoneRef } from '../sensorium.js'
import { compressDeadEnds, formatDeadEndRules } from '../../context/dead-end-rules.js'
import type { DeadEndEntry } from '../../context/dead-end-rules.js'

export interface SignalConsumerRuntimeHookOptions {
  /** Avoid repeating identical injected hints across turns. Default true. */
  dedupe?: boolean
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
          ctx.effects.injectUserMessage('⚠ 检测到任务过大，建议拆分为子步骤后逐一完成。')
        })
      }

      const deadEnds = pheromones.filter(p => p.signal === 'dead-end' && p.strength > 0)
      if (deadEnds.length > 0) {
        const seen = new Set<string>()
        const entries: DeadEndEntry[] = []
        for (const p of deadEnds) {
          if (!seen.has(p.path)) {
            seen.add(p.path)
            entries.push({ path: p.path, context: p.context })
          }
        }
        const rules = compressDeadEnds(entries)
        if (rules.length > 0) {
          const key = `dead-end:${rules.map(r => r.kind).sort().join('|')}`
          once(key, () => {
            ctx.effects.injectUserMessage(formatDeadEndRules(rules))
          })
        }
      }
    },
  }
}

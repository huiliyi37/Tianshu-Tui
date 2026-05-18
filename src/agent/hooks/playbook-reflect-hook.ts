import type { PostTurnRuntimeHook } from '../runtime-hooks.js'
import { extractBullets, shouldReflect } from '../playbook.js'
import type { RetrospectInput } from '../retrospect.js'
import { generateRetrospect } from '../retrospect.js'
import type { PlaybookStore } from '../playbook-store.js'
import type { DoomLoopLevel } from '../trace-store.js'

export interface PlaybookReflectHookDeps {
  store: PlaybookStore
  buildRetrospectInput: () => RetrospectInput
  getDoomLoopLevel: () => DoomLoopLevel
}

export function createPlaybookReflectHook(deps: PlaybookReflectHookDeps): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'playbook-reflect',
    run(ctx) {
      const { vigor, sensorium } = ctx.snapshot
      if (!vigor || !sensorium) return
      if (!shouldReflect(vigor, sensorium, deps.getDoomLoopLevel())) return

      const report = generateRetrospect(deps.buildRetrospectInput())
      const bullets = extractBullets(report)
      if (bullets.length === 0) return

      deps.store.addBullets(bullets)
      ctx.effects.emitPhaseChange('playbook-reflect', {
        reason: 'difficult session reflected',
        suggestion: `${bullets.length} lesson(s) stored`,
      })
    },
  }
}

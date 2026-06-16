import type { PostTurnRuntimeHook } from '../runtime-hooks.js'
import { writePresence, type CompanionPresenceEntry } from '../companion-presence.js'

export interface CompanionHeartbeatHookDeps {
  cwd: string
  getSessionId: () => string | undefined
  getDomainId: () => string | null
  getCognitiveSnapshot: () => { vigor: number; stability: number; season: string } | null
  getObjective: () => string | null
}

export function createCompanionHeartbeatHook(deps: CompanionHeartbeatHookDeps): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'companion-heartbeat',
    run() {
      const sessionId = deps.getSessionId()
      const domainId = deps.getDomainId()
      if (!sessionId || !domainId) return

      const snapshot = deps.getCognitiveSnapshot()
      const objective = deps.getObjective()

      const entry: CompanionPresenceEntry = {
        sessionId,
        starDomain: domainId,
        objective: (objective ?? '').slice(0, 120),
        updatedAt: Date.now(),
        ...(snapshot ? { cognitiveState: snapshot } : {}),
      }

      try {
        writePresence(deps.cwd, entry)
      } catch {
        // Non-critical — presence write failure should not interrupt the turn
      }
    },
  }
}

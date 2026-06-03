import type { AgentLoop } from './loop.js'
import { runThetaCheck } from './theta-check.js'

export const THETA_MAX_SESSION = 40;
export const THETA_MAX_PER_TURN = 2;

/**
 * Request a theta (typecheck) check with gating and backoff.
 * Extracted from AgentLoop.requestThetaCheck.
 */
export function requestThetaCheck(
  self: AgentLoop,
  reason: string,
): void {
if (self.thetaCheckInFlight) return

    // Gate 1: session-level cap
    if (self.thetaTelemetry.requestedCount >= THETA_MAX_SESSION) return

    // Gate 2: per-turn cap
    if (self.thetaRequestsThisTurn >= THETA_MAX_PER_TURN) return

    // Gate 3: consecutive-timeout backoff
    if (self.thetaTelemetry.consecutiveTimeouts > 0) {
      const currentTurn = self.session.getTurnCount()
      if (currentTurn < self.thetaTelemetry.cooldownUntilTurn) return
    }

    self.thetaCheckInFlight = true
    self.thetaRequestsThisTurn++
    self.thetaTelemetry = {
      ...self.thetaTelemetry,
      lastReason: reason,
      requestedCount: self.thetaTelemetry.requestedCount + 1,
    }
    runThetaCheck(self.cwd).then(result => {
      for (const errFile of result.errors) {
        self.repairHintTracker.recordFailure(errFile, 'type_error')
      }
      const timedOut = result.timedOut
      const consecutiveTimeouts = timedOut
        ? self.thetaTelemetry.consecutiveTimeouts + 1
        : 0
      const cooldownTurns = consecutiveTimeouts === 0 ? 0
        : Math.min(4, consecutiveTimeouts)
      self.thetaTelemetry = {
        ...self.thetaTelemetry,
        lastDurationMs: result.durationMs,
        lastErrorCount: result.errors.length,
        lastTimedOut: timedOut,
        consecutiveTimeouts,
        cooldownUntilTurn: cooldownTurns > 0
          ? self.session.getTurnCount() + cooldownTurns
          : 0,
      }
    }).catch(() => {
      self.thetaTelemetry = {
        ...self.thetaTelemetry,
        lastDurationMs: null,
        lastErrorCount: 0,
        lastTimedOut: false,
        consecutiveTimeouts: 0,
        cooldownUntilTurn: 0,
      }
    }).finally(() => {
      self.thetaCheckInFlight = false
    })
}

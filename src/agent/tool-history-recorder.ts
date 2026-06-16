import type { AgentLoop } from './loop.js'
import type { HealthSignal } from './trajectory-health.js'
import { createHash } from 'node:crypto'

/**
 * Record tool execution history and trigger deferred post-tool processing.
 * Extracted from AgentLoop.recordToolHistory.
 */
export function recordToolHistory(
  self: AgentLoop,
  name: string,
  input: Record<string, unknown>,
  isError: boolean,
  result: string,
): void {
const target = typeof input?.path === 'string'
      ? input.path
      : typeof input?.file_path === 'string'
        ? input.file_path
        : typeof input?.command === 'string'
          ? input.command.slice(0, 50)
          : name
    self.recentToolHistory.push({
      tool: name,
      target,
      status: isError ? 'failed' : 'success',
      error: isError ? result.slice(0, 50) : undefined,
    })
    if (self.recentToolHistory.length > 5) self.recentToolHistory.shift()

    // P3-E/H: invalidate plan cache + JIT on file mutations (sync — needed before next API call)
    if (!isError && (name === 'edit_file' || name === 'write_file')) {
      self.p3.invalidatePlanCache(target)
      self.p3.invalidateJIT(target)
    }

    // T2-02 P2: Record successful tool sequences to PlanCache on task delivery
    if (!isError && name === 'deliver_task') {
      try {
        const steps = self.p3.extractPlanSteps(self.recentToolHistory)
        if (steps.length >= 2) {
          const taskDesc = self.recentToolHistory
            .map(e => `${e.tool}:${e.target}`)
            .join(' → ')
          self.p3.recordPlan(taskDesc, steps)
        }
      } catch { /* PlanCache recording is non-critical */ }
    }

    // P3-D Atropos: assess trajectory health → auto-escalate Flash→Pro on repeated failures (sync)
    let trajectoryHealth: HealthSignal = 'healthy'
    if (self.config.onModelSwitch && self.config.getCurrentModel) {
      const currentModelId = self.config.getCurrentModel()
      const tier: 'flash' | 'pro' = currentModelId.includes('pro') ? 'pro' : 'flash'
      if (tier === 'flash') {
        const recentEvents = self.traceStore.events.slice(-10).map(e => ({
          status: (e.status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed',
          turn: e.turn,
        }))
        trajectoryHealth = self.p3.assessHealth(recentEvents, self.session.getTurnCount(), tier)
        if (trajectoryHealth === 'escalate') {
          const proModel = currentModelId.replace('flash', 'pro')
          try { self.config.onModelSwitch(proModel) } catch { /* non-fatal */ }
        }
      }
    }

    // ── Deferred post-tool processing ──
    // Immune/Physarum analysis and P3 pattern mining are deferred to
    // setImmediate so they never block tool result delivery.
    const fp = self.traceStore.toolFingerprints[self.traceStore.toolFingerprints.length - 1] ?? name
    const capturedTurn = self.session.getTurnCount()
    const capturedDoom = self.getDoomLoopLevel()
    const capturedTokens = self.session.getEstimatedTokens()
    setImmediate(() => {
      // P3 pattern mining (deferred)
      try { self.p3.onToolComplete(name, target, isError, isError ? result.slice(0, 200) : undefined) } catch { /* non-critical */ }

      // Physarum + Immune (deferred)
      try {
        const immuneResult = self.immuneHook.run({
          toolName: name,
          fingerprint: fp,
          turn: capturedTurn,
          doomLevel: capturedDoom,
          targetFile: target,
          tokenUsage: capturedTokens,
          trajectoryHealth,
          isError,
        })
        if (immuneResult.contextHint) {
          self._lastImmuneHint = immuneResult.contextHint
        }
      } catch { /* immune failure is non-critical */ }
    })

    // Record timestamp for event-loop gap detection
    self.lastToolCompleteTime = Date.now()

    // ── Sensorimotor learning: deferred (SHA-256 + DB INSERT is non-critical) ──
    setImmediate(() => {
      try {
        const db = self.config.meridianIndexer?.getDb()
        if (db) {
          const sensorium = self.sensorium
          const contextSig = createHash('sha256')
            .update(JSON.stringify({
              confidence: sensorium?.confidence ?? 0.5,
              complexity: sensorium?.complexity ?? 0.5,
              season: self.currentSeason ?? 'genesis',
              vigor: self.vigorState?.vigor ?? 0.5,
            }))
            .digest('hex').slice(0, 16)
          db.recordSensorimotorExperience(
            contextSig,
            name,
            !isError,
            0, // duration not tracked at this level
            self.session.getTurnCount(),
          )
        }
      } catch { /* sensorimotor recording is non-critical */ }
    })
}

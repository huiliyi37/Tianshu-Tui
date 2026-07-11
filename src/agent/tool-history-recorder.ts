import type { AgentLoop } from './loop.js'
import type { HealthSignal } from './trajectory-health.js'
import type { ToolErrorClass } from '../tools/types.js'
import { createHash } from 'node:crypto'
import { TYPECHECK_CMD_RE } from './typecheck-gate.js'
import { toolTargetFromInput } from './tool-target.js'
import { isUiFilePath, isVisualVerifyTool } from './hooks/render-verify-hook.js'

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
  errorClass?: ToolErrorClass,
): void {
    // Environment-class failures (host lacks the command — common on Windows) are
    // not competence failures. The immune system must not amplify them into
    // quarantine/doom, otherwise benign command-name differences make the agent
    // recoil. Visible status stays honest; only the immune amplifier is neutralised.
    const immuneError = errorClass === 'environment' ? false : isError
    const target = toolTargetFromInput(name, input ?? {})
    // Deterministic argsHash: tool name + sorted input keys → SHA-256 first 8 hex chars.
    const argsHash = createHash('sha256')
      .update(`${name}:${JSON.stringify(input, Object.keys(input).sort())}`)
      .digest('hex')
      .slice(0, 8)
    self.recentToolHistory.push({
      tool: name,
      target,
      status: isError ? 'failed' : 'success',
      argsHash,
      error: isError ? result.slice(0, 50) : undefined,
      ...(isError && errorClass ? { errorClass } : {}),
    })
    if (self.recentToolHistory.length > 5) self.recentToolHistory.shift()

    // P3-E/H: invalidate plan cache + JIT on file mutations (sync — needed before next API call)
    if (!isError && (name === 'edit_file' || name === 'write_file')) {
      self.p3.invalidatePlanCache(target)
      self.p3.invalidateJIT(target)
    }

    // Component C (typecheck-reminder) signals — robust task-level flags, NOT the
    // 5-entry window. A TS write marks edits as unverified-by-typecheck; a real
    // typecheck bash clears it. esbuild/tsx (run_tests) does NOT type-check.
    if (!isError) {
      if ((name === 'edit_file' || name === 'write_file' || name === 'hash_edit' || name === 'apply_patch')
        && /\.(ts|tsx)$/.test(target)) {
        self.touchedTsFiles = true
        self.sawTypecheckThisTask = false
      } else if (name === 'bash' && typeof input?.command === 'string' && TYPECHECK_CMD_RE.test(input.command)) {
        self.sawTypecheckThisTask = true
      }
    }

    // W5 (render-verify): track UI file edits and visual verification tool usage.
    if (!isError) {
      if ((name === 'edit_file' || name === 'write_file' || name === 'hash_edit' || name === 'apply_patch')
        && isUiFilePath(target)) {
        self.touchedUiFiles = true
      } else if (isVisualVerifyTool(name)) {
        self.sawVisualVerify = true
      }
    }

    // T2-02 P2: Record successful tool sequences to PlanCache on task delivery.
    // Key = the task's user input — the SAME distribution the lookup side uses
    // (turn-step-producer feeds userInput into planCacheSuggest). The old key
    // was the tool-chain string ("edit_file:src/a.ts → …"), whose keywords
    // almost never overlap a natural-language task description, so cache hit
    // rate was structurally near zero. Tool-chain string kept only as fallback
    // when no user message exists (e.g. programmatic runs).
    if (!isError && name === 'deliver_task') {
      try {
        const steps = self.p3.extractPlanSteps(self.recentToolHistory)
        if (steps.length >= 2) {
          const taskDesc = self.initialUserMessage?.trim()
            || self.recentToolHistory.map(e => `${e.tool}:${e.target}`).join(' → ')
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
          isError: immuneError,
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

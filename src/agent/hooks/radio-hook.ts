/**
 * Tianshu Radio — Runtime hook for phase transition + milestone + stuck detection
 * + phase-aware heartbeat + domain voice.
 *
 * Emits Chinese radio messages via `emitPhaseChange` on:
 * - Session start (first tool call)
 * - Phase class transitions (explore/plan/execute/verify/deliver)
 * - Heartbeat: periodic in-phase presence (every 6 turns)
 * - Test pass / test fail milestones
 * - Stuck-in-phase anomaly (8+ consecutive turns in same phase class)
 *
 * v2: All messages pass through applyDomainVoice for personality-aware tone.
 *     Heartbeat messages use phase-aware templates (not bare "第N轮").
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { Sensorium } from '../sensorium.js'
import type { StarPhase } from '../star-event.js'
import { mapSensoriumToPhase, PHASE_SHORT_LABELS } from '../star-event.js'
import { extractTemplateVars, formatRadioMessage, formatHeartbeatMessage, type PhaseClass } from '../radio-templates.js'
import { applyDomainVoice, type DomainVoiceId } from '../domain-voice.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUCK_THRESHOLD = 8
const COOLDOWN_TURNS = 5
const TEST_FAIL_COOLDOWN = 2
const HEARTBEAT_INTERVAL = 6

// ---------------------------------------------------------------------------
// Phase classification
// ---------------------------------------------------------------------------

const PHASE_CLASS_MAP: Record<StarPhase, PhaseClass> = {
  'tianxuan-locating': 'explore',
  'tianshu-planning': 'plan',
  'tianshu-encore': 'plan',
  'tianji-decomposing': 'plan',
  'tianquan-contracting': 'plan',
  'yuheng-implementing': 'execute',
  'kaiyang-testing': 'verify',
  'yaoguang-delivering': 'deliver',
}

function classifyPhase(phase: StarPhase): PhaseClass {
  return PHASE_CLASS_MAP[phase]
}

// ---------------------------------------------------------------------------
// StarPhaseContext construction
// ---------------------------------------------------------------------------

function isWritingTool(name: string): boolean {
  return name === 'edit_file' || name === 'write_file'
}

/**
 * Is the tool actually running tests (not merely targeting a test file)?
 * Used for isRunningTests in StarPhaseContext — only checks tool name
 * to avoid false positives like `bash` with target `npm test`.
 */
function isTestRunnerTool(name: string): boolean {
  if (name === 'run_tests') return true
  if (name.includes('test')) return true
  return false
}

/**
 * Is this a test-related tool (for milestone detection)?
 * Also matches `bash` commands — the caller filters by success/failure.
 */
function isTestRelatedTool(name: string): boolean {
  return name === 'bash' || isTestRunnerTool(name)
}

function buildStarPhaseContext(
  ctx: RuntimeHookContext,
  tool: RuntimeToolEvent,
  hasEnteredHighComplexity: boolean,
) {
  return {
    turn: ctx.snapshot.turn,
    isWriting: isWritingTool(tool.name),
    isRunningTests: isTestRunnerTool(tool.name),
    isFinalTurn: false, // Not determinable from single postTool hook
    shouldEscalate: ctx.snapshot.strategy?.shouldEscalate ?? false,
    hasEnteredHighComplexity,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface RadioHookDeps {
  chronicle?: {
    addRadio: (message: string, turn: number) => void
    addPhaseTransition: (input: { fromPhase: string; toPhase: string; turn: number; summary: string }) => void
  }
  /** Returns the current star domain id. null when no domain matched. */
  getDomainId?: () => DomainVoiceId
}

export function createRadioHook(deps?: RadioHookDeps): PostToolRuntimeHook {
  // Internal state
  let lastPhase: PhaseClass | null = null
  let lastEmitTurn = -Infinity
  let lastStuckEmitTurn = -Infinity
  let hasEmittedStart = false
  let hasEnteredHighComplexity = false
  let samePhaseTurnCount = 0

  /** Apply domain voice to a message. No-op when getDomainId is absent. */
  function voice(msg: string): string {
    const domainId = deps?.getDomainId?.() ?? null
    return applyDomainVoice(msg, domainId)
  }

  return {
    phase: 'postTool',
    name: 'tianshu-radio',

    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      const { snapshot, effects } = ctx

      // 1. Skip if sensorium unavailable
      if (!snapshot.sensorium) return

      // Track high complexity for StarPhaseContext
      if (snapshot.sensorium.complexity > 0.5) {
        hasEnteredHighComplexity = true
      }

      // 2. Compute current star phase and classify
      const phaseCtx = buildStarPhaseContext(ctx, tool, hasEnteredHighComplexity)
      const starPhase = mapSensoriumToPhase(snapshot.sensorium, phaseCtx)
      const currentPhase = classifyPhase(starPhase)
      const turn = snapshot.turn

      // Track same-phase consecutive turns for heartbeat
      if (currentPhase === lastPhase) {
        samePhaseTurnCount++
      } else {
        samePhaseTurnCount = 1
      }

      // 3. First call — emit session_start
      if (!hasEmittedStart) {
        hasEmittedStart = true
        lastPhase = currentPhase
        lastEmitTurn = turn
        const msg = voice('[天枢] 收到任务，开始分析。')
        effects.emitPhaseChange('tianshu-radio', { reason: msg })
        deps?.chronicle?.addRadio(msg, turn)
        return
      }

      // 4. Phase class transition
      if (lastPhase !== null && currentPhase !== lastPhase) {
        const transition = `${lastPhase}→${currentPhase}`
        const toolHistory = snapshot.recentToolHistory.map(e => ({
          tool: e.tool,
          target: e.target ?? '',
          status: e.status,
        }))
        const vars = extractTemplateVars(toolHistory)
        vars.phaseName = PHASE_SHORT_LABELS[starPhase]
        vars.turnCount = turn
        const message = voice(formatRadioMessage({ transition, vars }))

        const prevPhase = lastPhase
        lastPhase = currentPhase
        lastEmitTurn = turn
        effects.emitPhaseChange('tianshu-radio', { reason: message })
        deps?.chronicle?.addRadio(message, turn)
        deps?.chronicle?.addPhaseTransition({ fromPhase: prevPhase, toPhase: currentPhase, turn, summary: message })
        return
      }

      // 5. Stuck detection (same phase class for STUCK_THRESHOLD+ turns)
      //    Uses its own lastStuckEmitTurn so heartbeat messages don't
      //    suppress the stuck warning.
      if (turn - lastStuckEmitTurn >= COOLDOWN_TURNS) {
        const history = snapshot.recentToolHistory
        let consecutive = 0
        for (let i = history.length - 1; i >= 0; i--) {
          const entry = history[i]
          if (!entry) break
          if (classifyPhase(mapSensoriumToPhase(snapshot.sensorium, {
            ...phaseCtx,
            isWriting: isWritingTool(entry.tool),
            isRunningTests: isTestRunnerTool(entry.tool),
          })) === currentPhase) {
            consecutive++
          } else {
            break
          }
        }

        if (consecutive >= STUCK_THRESHOLD) {
          const vars = extractTemplateVars([])
          vars.phaseName = PHASE_SHORT_LABELS[starPhase]
          vars.turnCount = consecutive
          const message = voice(formatRadioMessage({ transition: 'stuck', vars }))

          lastStuckEmitTurn = turn
          effects.emitPhaseChange('tianshu-radio', { reason: message })
          deps?.chronicle?.addRadio(message, turn)
          return
        }
      }

      // 6. Heartbeat — periodic in-phase presence signal
      if (
        samePhaseTurnCount >= HEARTBEAT_INTERVAL &&
        samePhaseTurnCount % HEARTBEAT_INTERVAL === 0 &&
        turn - lastEmitTurn >= COOLDOWN_TURNS
      ) {
        const toolHistory = snapshot.recentToolHistory.map(e => ({
          tool: e.tool,
          target: e.target ?? '',
          status: e.status,
        }))
        const vars = extractTemplateVars(toolHistory)
        vars.phaseName = PHASE_SHORT_LABELS[starPhase]
        vars.turnCount = turn
        const message = voice(formatHeartbeatMessage(currentPhase, vars))

        lastEmitTurn = turn
        effects.emitPhaseChange('tianshu-radio', { reason: message })
        deps?.chronicle?.addRadio(message, turn)
        return
      }

      // 6. Test fail milestone (failed bash/test tool, with cooldown)
      if (
        !tool.success &&
        isTestRelatedTool(tool.name) &&
        turn - lastEmitTurn >= TEST_FAIL_COOLDOWN
      ) {
        const toolHistory = snapshot.recentToolHistory.map(e => ({
          tool: e.tool,
          target: e.target ?? '',
          status: e.status,
        }))
        const vars = extractTemplateVars(toolHistory)
        vars.failCount = Math.max(vars.failCount, 1)
        vars.errorBrief = vars.errorBrief || '命令执行失败'
        const message = voice(formatRadioMessage({ transition: 'test_fail', vars }))

        lastEmitTurn = turn
        effects.emitPhaseChange('tianshu-radio', { reason: message })
        deps?.chronicle?.addRadio(message, turn)
        return
      }

      // 7. Test pass milestone (successful test tool in verify phase)
      if (
        tool.success &&
        isTestRunnerTool(tool.name) &&
        currentPhase === 'verify'
      ) {
        lastEmitTurn = turn
        const msg = voice('[天枢] ✓ 测试通过。')
        effects.emitPhaseChange('tianshu-radio', { reason: msg })
        deps?.chronicle?.addRadio(msg, turn)
        return
      }
    },
  }
}

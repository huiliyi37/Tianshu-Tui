import type { Sensorium } from './sensorium.js'

// ─── Types ──────────────────────────────────────────────────────────

/**
 * KickActions — a stagnation breakthrough instruction set.
 * Generated when the agent is stuck (momentum < 0.2 && stability < 0.3).
 *
 * Unlike strategy-shift (which suggests a different approach within the
 * same problem frame), the dissipative kick reframes the problem entirely.
 *
 * Actions are executed by the primary AgentLoop via existing mechanisms:
 * - deadEndPaths → StigmergyStore.deposit('dead-end')
 * - switchToExploration → increases explorationBreadth
 * - shouldEscalate → triggers tianshu-encore phase
 * - injectedMessage → injected as user guidance
 */
export interface KickActions {
  /** File paths to mark as dead-end pheromone signals */
  deadEndPaths: string[]
  /** Hint: switch to tonic exploration mode (wide search) */
  switchToExploration: boolean
  /** Hint: escalate to stronger model for re-planning */
  shouldEscalate: boolean
  /** Suggested alternative problem framings */
  alternativeFrameworks: string[]
  /** Message to inject into the conversation for the LLM */
  injectedMessage: string
}

// ─── Trigger ────────────────────────────────────────────────────────

/**
 * Determine if a dissipative kick should be triggered.
 *
 * Conditions: momentum < 0.2 AND stability < 0.3
 * → agent is making repeated mistakes + strategy isn't adapting
 *
 * This is the V4-level reframe. V2-level is strategy-shift (same frame).
 */
export function shouldKick(s: Sensorium): boolean {
  return s.momentum < 0.2 && s.stability < 0.3
}

// ─── Action Builder ─────────────────────────────────────────────────

/**
 * Build kick actions based on the current sensorium state.
 *
 * Pure function — deterministic, no side effects.
 * The caller (AgentLoop) is responsible for executing the actions.
 *
 * @param s - Current Sensorium snapshot
 * @param _cwd - Working directory (reserved for future import-graph use)
 * @param recentlyFailedFiles - File paths that have failed recently
 */
export function buildKickActions(
  s: Sensorium,
  _cwd: string,
  recentlyFailedFiles: string[] = [],
): KickActions {
  const deadEndPaths = recentlyFailedFiles.length > 0
    ? recentlyFailedFiles
    : []

  const parts: string[] = [
    '**天璇-感知：当前策略进入低效状态。停下来，换个角度看。**',
  ]

  if (s.confidence < 0.3) {
    parts.push('- 测试验证率低，建议先写最小测试验证当前改动是否正确')
  }

  if (s.complexity > 0.5) {
    parts.push('- 涉及多文件改动，建议拆分任务：先完成一个子目标并验证，再进行下一步')
  }

  if (s.pressure > 0.7) {
    parts.push('- 上下文快满了，建议立即提交当前完成的部分，用 checkpoint 清理上下文')
  }

  parts.push('- 重新阅读用户原始请求，确认当前方向是否偏离')
  parts.push('- 天璇胶囊（docs/seed-capsule-tianxuan.md）有换视角方法论可供 recall')

  return {
    deadEndPaths,
    switchToExploration: true,
    shouldEscalate: s.confidence < 0.2 && s.complexity > 0.5,
    alternativeFrameworks: [
      're-read original request',
      'simplest viable approach',
      'decompose into sub-tasks',
    ],
    injectedMessage: parts.join('\n'),
  }
}

// ─── Escalation From Kick ───────────────────────────────────────────

/**
 * Determine if a kick should trigger model escalation (tianshu-encore).
 *
 * More conservative than normal escalation (confidence < 0.3 && momentum < 0.2).
 * Kick escalation requires confidence < 0.2 AND complexity > 0.5 —
 * i.e., it's not just failing, it's failing at a complex multi-file task.
 */
export function shouldEscalateFromKick(s: Sensorium): boolean {
  return s.confidence < 0.2 && s.complexity > 0.5
}

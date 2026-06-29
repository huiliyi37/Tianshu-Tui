import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { requiresBashWriteApproval } from './approval-risk.js'
import type { RecoveryTrigger, RecoveryTriggerResult } from './recovery-trigger.js'

export type ReliabilityMode = 'full' | 'degraded' | 'minimal'

export interface ReliabilityDecision {
  mode: ReliabilityMode
  reason: string
  blockedTools: string[]
  evidence?: string[]
}

const READ_ONLY_MINIMAL_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'diff',
  'inspect_project',
  'repo_map',
  'related_tests',
  'recall',
  'ask_user_question',
])

function decision(
  mode: ReliabilityMode,
  reason: string,
  blockedTools: string[] = [],
  evidence?: string[],
): ReliabilityDecision {
  return { mode, reason, blockedTools, ...(evidence && evidence.length > 0 ? { evidence } : {}) }
}

export function modeForRecoveryTrigger(
  trigger: RecoveryTriggerResult | null | undefined,
  goalActive?: boolean,
  /** Triggers that have already fired at error level this session.
   *  Recurring firings are capped at degraded to prevent permanent lock-in
   *  from conditions that never self-resolve (e.g. orphan tool_use blocks). */
  suppressedTriggers?: Set<RecoveryTrigger>,
): ReliabilityDecision {
  if (!trigger) return decision('full', 'no recovery trigger')

  // One-shot suppression: if this trigger already fired at error this session,
  // cap it at degraded so the agent retains edit_file + scratch write access.
  // The first occurrence already alerted the user; persistent lock-in from
  // non-self-resolving conditions (session_integrity, resource_pressure) is
  // counterproductive — it forces the user to kill the session.
  if (trigger.severity === 'error' && suppressedTriggers?.has(trigger.trigger)) {
    return decision('degraded',
      `${trigger.summary} (recurring — capped at degraded)`,
      ['bash_write', 'high_risk'],
      trigger.evidence)
  }

  if (trigger.trigger === 'resource_pressure') {
    return trigger.severity === 'error'
      ? decision('minimal', trigger.summary, ['bash', 'write_file', 'edit_file'], trigger.evidence)
      : decision('degraded', trigger.summary, ['bash_write', 'high_risk'], trigger.evidence)
  }

  if (trigger.trigger === 'context_thrashing' && trigger.severity === 'error') {
    return decision('minimal', trigger.summary, ['bash', 'write_file', 'edit_file'], trigger.evidence)
  }

  if (trigger.trigger === 'doom_loop_blocked') {
    // Goal mode already relaxes doom-loop thresholds (GOAL_DOOM_THRESHOLDS);
    // if it still fires, the agent is genuinely stuck — but degrading tool access
    // in a long autonomous task is more disruptive than a false positive.
    // Stay full so the agent can self-correct; the relaxed thresholds already
    // filter out most routine repetition.
    if (goalActive) return decision('full', trigger.summary)
    return decision('degraded', trigger.summary, ['bash_write', 'high_risk'], trigger.evidence)
  }

  if (trigger.trigger === 'session_integrity' && trigger.severity === 'error') {
    return decision('minimal', trigger.summary, ['bash', 'write_file', 'edit_file'], trigger.evidence)
  }

  if (trigger.severity === 'warn') {
    return decision('degraded', trigger.summary, ['bash_write', 'high_risk'], trigger.evidence)
  }

  return decision('degraded', trigger.summary, ['bash_write', 'high_risk'], trigger.evidence)
}

/**
 * Whether a write targets a scratch location (OS temp dir or a `.rivet/scratch`
 * sub-tree). These are low-risk, self-contained writes that enable the
 * "write a diagnostic file → read it back" self-rescue path. Allowing them in
 * degraded mode gives a stuck agent an escape hatch without reopening writes to
 * the workspace proper — the degraded lock-out is otherwise a dead-end when the
 * agent needs to materialise output it cannot otherwise see.
 */
export function isScratchScopedWrite(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'write_file') return false
  const raw = typeof input.file_path === 'string' ? input.file_path
    : typeof input.path === 'string' ? input.path
      : ''
  if (!raw) return false
  const target = resolve(raw)
  const tmp = resolve(tmpdir())
  // Windows: paths are case-insensitive — normalise to lowercase for comparison.
  // Without this, C:\Users\... vs c:\users\... would fail startsWith,
  // breaking the scratch-write self-rescue escape hatch on Windows.
  const cmp = process.platform === 'win32'
    ? (p: string) => p.toLowerCase()
    : (p: string) => p
  const underTmp = cmp(target) === cmp(tmp) || cmp(target).startsWith(cmp(tmp) + sep)
  const underScratch = /[/\\]\.rivet[/\\]scratch(?:[/\\]|$)/.test(target)
  return underTmp || underScratch
}

export function isToolAllowedInReliabilityMode(
  mode: ReliabilityMode,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (mode === 'full') return true

  if (mode === 'minimal') {
    // Scratch writes (temp dir / .rivet/scratch) are allowed even in minimal
    // mode as a last-resort self-rescue: write a diagnostic → read it back.
    if (isScratchScopedWrite(toolName, input)) return true
    return READ_ONLY_MINIMAL_TOOLS.has(toolName)
  }

  // degraded: block new file creation and shell writes, but allow edit_file
  // so debug workflows (fix → verify) can continue under resource pressure.
  // edit_file is low-risk: it modifies existing files with small diffs, no new processes.
  // Scratch writes (temp dir / .rivet/scratch) stay allowed as a self-rescue
  // escape hatch: write a diagnostic file then read it back.
  if (isScratchScopedWrite(toolName, input)) return true
  if (toolName === 'write_file') return false
  if (requiresBashWriteApproval(toolName, input)) return false
  return true
}

export function reliabilityBlockMessage(
  decision: ReliabilityDecision,
  toolName: string,
): string {
  return [
    `Tool execution blocked by reliability mode: ${decision.mode}`,
    `Tool: ${toolName}`,
    `Reason: ${decision.reason}`,
    ...(decision.evidence && decision.evidence.length > 0
      ? [`Evidence: ${decision.evidence.join('; ')}`]
      : []),
    decision.mode === 'minimal'
      ? 'Allowed tools: read_file, grep, glob, diff, inspect_project, repo_map, related_tests, recall, ask_user_question. Self-rescue: write_file to the OS temp dir or .rivet/scratch/ is still permitted.'
      : 'Degraded mode blocks write_file and bash commands with write side effects. edit_file is still allowed for debug fixes. Self-rescue: write_file to the OS temp dir or .rivet/scratch/ is still permitted, then read_file it back — use this to materialise output you cannot otherwise see (e.g. a rawPath dump).',
    decision.mode === 'minimal'
      ? 'This mode triggers on critical resource pressure, context thrashing, or session integrity issues. If this is a false alarm, use RIVET_RELIABILITY_OVERRIDE=full.'
      : 'This mode triggers on repeated failures, moderate resource pressure, or repeated interrupts. Try a different approach or tool; as a last resort, start a fresh session.',
    'To override: set RIVET_RELIABILITY_OVERRIDE=full in your environment and restart.',
  ].join('\n')
}

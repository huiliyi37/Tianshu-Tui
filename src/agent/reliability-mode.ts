import { requiresBashWriteApproval } from './approval-risk.js'
import type { RecoveryTriggerResult } from './recovery-trigger.js'

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

export function modeForRecoveryTrigger(trigger: RecoveryTriggerResult | null | undefined): ReliabilityDecision {
  if (!trigger) return decision('full', 'no recovery trigger')

  if (trigger.trigger === 'resource_pressure') {
    return trigger.severity === 'error'
      ? decision('minimal', trigger.summary, ['bash', 'write_file', 'edit_file'], trigger.evidence)
      : decision('degraded', trigger.summary, ['bash_write', 'high_risk'], trigger.evidence)
  }

  if (trigger.trigger === 'context_thrashing' && trigger.severity === 'error') {
    return decision('minimal', trigger.summary, ['bash', 'write_file', 'edit_file'], trigger.evidence)
  }

  if (trigger.trigger === 'doom_loop_blocked') {
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

export function isToolAllowedInReliabilityMode(
  mode: ReliabilityMode,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (mode === 'full') return true

  if (mode === 'minimal') {
    return READ_ONLY_MINIMAL_TOOLS.has(toolName)
  }

  // degraded: block new file creation and shell writes, but allow edit_file
  // so debug workflows (fix → verify) can continue under resource pressure.
  // edit_file is low-risk: it modifies existing files with small diffs, no new processes.
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
      ? 'Allowed tools: read_file, grep, glob, diff, inspect_project, repo_map, related_tests, recall, ask_user_question.'
      : 'Degraded mode blocks write_file and bash commands with write side effects. edit_file is still allowed for debug fixes.',
    'Suggested recovery: compact, reduce task scope, or start a fresh session if pressure persists.',
  ].join('\n')
}

import { requiresBashWriteApproval } from './approval-risk.js'
import type { RecoveryTriggerResult } from './recovery-trigger.js'

export type ReliabilityMode = 'full' | 'degraded' | 'minimal'

export interface ReliabilityDecision {
  mode: ReliabilityMode
  reason: string
  blockedTools: string[]
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

function decision(mode: ReliabilityMode, reason: string, blockedTools: string[] = []): ReliabilityDecision {
  return { mode, reason, blockedTools }
}

export function modeForRecoveryTrigger(trigger: RecoveryTriggerResult | null | undefined): ReliabilityDecision {
  if (!trigger) return decision('full', 'no recovery trigger')

  if (trigger.trigger === 'resource_pressure') {
    return trigger.severity === 'error'
      ? decision('minimal', trigger.summary, ['bash', 'write_file', 'edit_file'])
      : decision('degraded', trigger.summary, ['bash_write', 'high_risk'])
  }

  if (trigger.trigger === 'context_thrashing' && trigger.severity === 'error') {
    return decision('minimal', trigger.summary, ['bash', 'write_file', 'edit_file'])
  }

  if (trigger.trigger === 'doom_loop_blocked') {
    return decision('degraded', trigger.summary, ['bash_write', 'high_risk'])
  }

  if (trigger.trigger === 'session_integrity' && trigger.severity === 'error') {
    return decision('minimal', trigger.summary, ['bash', 'write_file', 'edit_file'])
  }

  if (trigger.severity === 'warn') {
    return decision('degraded', trigger.summary, ['bash_write', 'high_risk'])
  }

  return decision('degraded', trigger.summary, ['bash_write', 'high_risk'])
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

  // degraded: keep normal tools available, but block shell writes and direct file writes.
  if (toolName === 'write_file' || toolName === 'edit_file') return false
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
    decision.mode === 'minimal'
      ? 'Allowed tools: read_file, grep, glob, diff, inspect_project, repo_map, related_tests, recall, ask_user_question.'
      : 'Degraded mode blocks write_file, edit_file, and bash commands with write side effects.',
    'Suggested recovery: compact, reduce task scope, or start a fresh session if pressure persists.',
  ].join('\n')
}

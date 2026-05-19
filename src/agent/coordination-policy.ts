import type { WorkerProfile } from './work-order.js'

export type AgentRole = 'brain' | 'hands' | 'readonly'

/** Brain: thinks, plans, delegates. No concrete file/code tools. */
export const BRAIN_TOOLS = ['delegate_task', 'delegate_batch'] as const

/** Hands reads: all code-reading primitives for context gathering. */
export const HANDS_READ_TOOLS = [
  'read_file', 'grep', 'glob', 'diff',
  'inspect_project', 'repo_map', 'related_tests',
] as const

/** Hands writes: all code-writing/+modifying primitives. */
export const HANDS_WRITE_TOOLS = [
  'edit_file', 'write_file', 'bash', 'run_tests',
] as const

/** Full Hands tool set: read + write. No delegation. */
export const HANDS_ALL_TOOLS = [...HANDS_READ_TOOLS, ...HANDS_WRITE_TOOLS] as const

export function classifyProfile(profile: WorkerProfile): AgentRole {
  switch (profile) {
    case 'planner':
      return 'brain'
    case 'patcher':
    case 'verifier':
      return 'hands'
    default:
      return 'readonly'
  }
}

const BRAIN_TOOL_SET = new Set<string>(BRAIN_TOOLS)
const HANDS_TOOL_SET = new Set<string>(HANDS_ALL_TOOLS)

export function isBrainTool(name: string): boolean {
  return BRAIN_TOOL_SET.has(name)
}

export function isHandsTool(name: string): boolean {
  return HANDS_TOOL_SET.has(name)
}

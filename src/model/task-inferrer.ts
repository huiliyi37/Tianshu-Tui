import type { CapabilityTask } from './capability.js'

export interface TaskInference {
  task: CapabilityTask
  reason: string
}

export interface ToolCallRecord {
  name: string
  isError: boolean
}

export function inferTaskType(recentCalls: ToolCallRecord[]): TaskInference | null {
  if (recentCalls.length === 0) return null

  const names = recentCalls.map(c => c.name)
  const editCount = names.filter(n => n === 'edit_file' || n === 'write_file').length
  const testCount = names.filter(n => n === 'run_tests' || n === 'bash').length
  const searchCount = names.filter(n => n === 'grep' || n === 'glob' || n === 'read_file').length
  const hasTestFailure = recentCalls.some(c => (c.name === 'run_tests' || c.name === 'bash') && c.isError)

  // edit + test failure → test_failure_diagnosis
  if (testCount > 0 && hasTestFailure) {
    return { task: 'test_failure_diagnosis', reason: 'test failure detected, diagnosis mode recommended' }
  }

  // multi-file edit + test → risky_refactor
  if (editCount >= 2 && testCount > 0) {
    return { task: 'risky_refactor', reason: 'multi-file edit with verification, refactor-capable model recommended' }
  }

  // single edit/write → code_edit
  if (editCount > 0) {
    return { task: 'code_edit', reason: 'file modification, edit-capable model recommended' }
  }

  // search-heavy (≥3 search tools, no edits) → repo_summarization
  if (searchCount >= 3 && editCount === 0) {
    return { task: 'repo_summarization', reason: 'code exploration, context-capable model recommended' }
  }

  return null
}

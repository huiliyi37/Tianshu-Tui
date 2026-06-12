/**
 * Auto-delegation heuristics — after the main agent completes a code change,
 * automatically queue Flash workers for mechanical follow-up tasks.
 *
 * Opt-in via config flag `agent.autoDelegate: true`. Respects the circuit
 * breaker — if a Flash profile is tripped, auto-delegation for that profile
 * pauses gracefully.
 *
 * Trigger rules:
 * - After edit_file → queue lint_fixer + type_fixer for the edited file
 * - After write_file (test) → queue lint_fixer for the new test file
 * - After large refactor (5+ files edited in session) → queue import_organizer + doc_syncer
 */

import type { CircuitBreakerManager } from './worker-circuit-breaker.js'
import type { TaskDepthLayer } from '../context/task-contract.js'

export type AutoDelegateProfile = 'lint_fixer' | 'type_fixer' | 'import_organizer' | 'doc_syncer' | 'test_scaffolder' | 'format_checker'

export interface AutoDelegationItem {
  profile: AutoDelegateProfile
  files: string[]
  objective: string
}

export interface AutoDelegationPlan {
  items: AutoDelegationItem[]
  reason: string
}

export interface AutoDelegateContext {
  toolName: string
  /** Files affected by the tool call. */
  affectedFiles: string[]
  /** Total files modified in the current session so far. */
  sessionModifiedFileCount: number
  taskDepthLayer?: TaskDepthLayer
  circuitBreaker: CircuitBreakerManager
}

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$/

function isCircuitOpen(cb: CircuitBreakerManager, profile: string): boolean {
  return !cb.canDelegate(profile).allowed
}

/**
 * Determine which Flash workers should be auto-dispatched after a tool call.
 * Returns null if no delegation is warranted.
 */
export function shouldAutoDelegate(ctx: AutoDelegateContext): AutoDelegationPlan | null {
  const items: AutoDelegationItem[] = []

  if (ctx.toolName === 'edit_file' && ctx.affectedFiles.length > 0) {
    // After editing a file: lint + type check
    if (!isCircuitOpen(ctx.circuitBreaker, 'lint_fixer')) {
      items.push({
        profile: 'lint_fixer',
        files: ctx.affectedFiles,
        objective: `Run linter and fix violations in: ${ctx.affectedFiles.join(', ')}`,
      })
    }
    if (!isCircuitOpen(ctx.circuitBreaker, 'type_fixer')) {
      items.push({
        profile: 'type_fixer',
        files: ctx.affectedFiles,
        objective: `Run tsc and fix type errors in: ${ctx.affectedFiles.join(', ')}`,
      })
    }
  }

  if (ctx.toolName === 'write_file' && ctx.affectedFiles.length > 0) {
    const testFiles = ctx.affectedFiles.filter(f => TEST_FILE_PATTERN.test(f))
    const nonTestFiles = ctx.affectedFiles.filter(f => !TEST_FILE_PATTERN.test(f))

    // New test files: lint check
    if (testFiles.length > 0 && !isCircuitOpen(ctx.circuitBreaker, 'lint_fixer')) {
      items.push({
        profile: 'lint_fixer',
        files: testFiles,
        objective: `Run linter on new test files: ${testFiles.join(', ')}`,
      })
    }

    // New source files: type check
    if (nonTestFiles.length > 0 && !isCircuitOpen(ctx.circuitBreaker, 'type_fixer')) {
      items.push({
        profile: 'type_fixer',
        files: nonTestFiles,
        objective: `Run tsc and fix type errors in new files: ${nonTestFiles.join(', ')}`,
      })
    }
  }

  // Large refactor: import organization + doc sync
  if (ctx.sessionModifiedFileCount >= 5) {
    if (!isCircuitOpen(ctx.circuitBreaker, 'import_organizer')) {
      items.push({
        profile: 'import_organizer',
        files: ctx.affectedFiles,
        objective: `Sort and clean imports across ${ctx.sessionModifiedFileCount} modified files`,
      })
    }
    if (!isCircuitOpen(ctx.circuitBreaker, 'doc_syncer')) {
      items.push({
        profile: 'doc_syncer',
        files: ctx.affectedFiles,
        objective: `Update documentation to match code changes across ${ctx.sessionModifiedFileCount} modified files`,
      })
    }
  }

  if (items.length === 0) return null

  return {
    items,
    reason: `auto-delegate after ${ctx.toolName} on ${ctx.affectedFiles.length} file(s)`,
  }
}

/**
 * Filter a plan to only include items whose circuits are not open.
 * Called right before dispatch to handle race conditions where a circuit
 * opened between planning and execution.
 */
export function filterByCircuitState(
  plan: AutoDelegationPlan,
  circuitBreaker: CircuitBreakerManager,
): AutoDelegationPlan | null {
  const filtered = plan.items.filter(item => !isCircuitOpen(circuitBreaker, item.profile))
  if (filtered.length === 0) return null
  return { items: filtered, reason: plan.reason }
}

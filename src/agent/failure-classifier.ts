export type FailureClass =
  | 'type_error'
  | 'assertion'
  | 'missing_dep'
  | 'timeout'
  | 'snapshot'
  | 'module_resolution'
  | 'env_missing'
  | 'flaky'
  | 'unknown'

export interface ClassifiedFailure {
  class: FailureClass
  suggestion: string
  confidence: number  // 0-1
}

export function classifyFailure(errorText: string): ClassifiedFailure {
  // Priority order: most specific patterns first

  // 1. TypeScript type errors
  if (/error TS\d{4}:/.test(errorText) || /Type '.*' is not assignable/.test(errorText) || /Property '.*' does not exist/.test(errorText)) {
    return { class: 'type_error', suggestion: 'Fix type annotation or interface. Do not change business logic.', confidence: 0.9 }
  }

  // 2. Module resolution
  if (/Cannot find module/.test(errorText) || /Module not found/.test(errorText)) {
    return { class: 'module_resolution', suggestion: 'Check import path, file existence, and package.json exports.', confidence: 0.9 }
  }

  // 3. Missing dependency
  if (/command not found|sh: .*: command not found|Cannot find package/.test(errorText)) {
    return { class: 'missing_dep', suggestion: 'Report missing dependency. Do not silently change the test command.', confidence: 0.8 }
  }

  // 4. Timeout
  if (/timeout|timed out|Exceeded timeout/.test(errorText)) {
    return { class: 'timeout', suggestion: 'Check for infinite loops, unawaited async, or slow operations. Consider increasing timeout.', confidence: 0.8 }
  }

  // 5. Snapshot
  if (/snapshot/i.test(errorText) && (/diff/.test(errorText) || /mismatch/.test(errorText))) {
    return { class: 'snapshot', suggestion: 'Review snapshot diff. If change is intentional, update snapshots.', confidence: 0.85 }
  }

  // 6. Environment missing
  if (/environment variable|ENV|env:/i.test(errorText) || /API key|secret|credential/i.test(errorText)) {
    return { class: 'env_missing', suggestion: 'Mark as blocked. Required environment or credentials are missing.', confidence: 0.8 }
  }

  // 7. Assertion failure
  if (/assert|expect|AssertionError|Expected|expected.*but got/.test(errorText) || /not ok \d+/.test(errorText)) {
    return { class: 'assertion', suggestion: 'Compare expected vs actual. Determine if test expectation is wrong or implementation is buggy before changing code.', confidence: 0.7 }
  }

  // 8. Flaky
  if (/flaky|intermittent|sometimes|occasionally/.test(errorText)) {
    return { class: 'flaky', suggestion: 'Mark as potentially flaky. Run multiple times to confirm before treating as code bug.', confidence: 0.5 }
  }

  return { class: 'unknown', suggestion: 'Read the full error output carefully. Identify the exact failure before attempting a fix.', confidence: 0.3 }
}

/** Classify all failures found in a test run output */
export function classifyTestRun(output: string): ClassifiedFailure[] {
  // Split by test failure boundaries
  const failures: ClassifiedFailure[] = []

  // node:test format: "not ok N - test name\n  error details"
  const nodeFailures = output.matchAll(/not ok \d+ - (.+)\n((?:  .*\n?)*)/g)
  for (const m of nodeFailures) {
    const errorBlock = (m[2] ?? '') + '\n' + (m[1] ?? '')
    failures.push(classifyFailure(errorBlock))
  }

  // vitest/jest: FAIL section
  const vitestFailures = output.matchAll(/FAIL\s+(.+?)\n((?:  .*\n|\t.*\n)*)/g)
  for (const m of vitestFailures) {
    const errorBlock = (m[2] ?? '') + '\n' + (m[1] ?? '')
    failures.push(classifyFailure(errorBlock))
  }

  if (failures.length === 0) {
    // No structured failures found, try to classify the whole output
    failures.push(classifyFailure(output))
  }

  return failures
}

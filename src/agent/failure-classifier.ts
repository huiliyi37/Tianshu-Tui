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
  // NEW
  | 'permission_denied'
  | 'context_window_exceeded'
  | 'api_error'
  | 'syntax_error'
  | 'format_error'

export interface ClassifiedFailure {
  class: FailureClass
  suggestion: string
  confidence: number  // 0-1
  retryable: boolean
}

export function classifyFailure(errorText: string): ClassifiedFailure {
  // Priority order: most specific patterns first

  // 1. TypeScript type errors
  if (/error TS\d{4}:/.test(errorText) || /Type '.*' is not assignable/.test(errorText) || /Property '.*' does not exist/.test(errorText)) {
    return { class: 'type_error', suggestion: 'Fix type annotation or interface. Do not change business logic.', confidence: 0.9, retryable: false }
  }

  // 2. Module resolution
  if (/Cannot find module/.test(errorText) || /Module not found/.test(errorText)) {
    return { class: 'module_resolution', suggestion: 'Check import path, file existence, and package.json exports.', confidence: 0.9, retryable: false }
  }

  // 3. Permission denied (NEW)
  if (/EACCES|Permission denied|Operation not permitted/i.test(errorText)) {
    return { class: 'permission_denied', suggestion: 'Check file permissions or sandbox policy.', confidence: 0.9, retryable: false }
  }

  // 4. Missing dependency
  if (/command not found|sh: .*: command not found|Cannot find package/.test(errorText)) {
    return { class: 'missing_dep', suggestion: 'Report missing dependency. Do not silently change the test command.', confidence: 0.8, retryable: false }
  }

  // 5. Context window exceeded (NEW)
  if (/context length exceeded|maximum context length|token limit|too many tokens/i.test(errorText)) {
    return { class: 'context_window_exceeded', suggestion: 'Use /compact to reduce context, or start a new session.', confidence: 0.9, retryable: false }
  }

  // 6. Timeout
  if (/timeout|timed out|Exceeded timeout/.test(errorText)) {
    return { class: 'timeout', suggestion: 'Check for infinite loops, unawaited async, or slow operations. Consider increasing timeout.', confidence: 0.8, retryable: true }
  }

  // 6b. Network/transient errors
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(errorText)) {
    return { class: 'timeout', suggestion: 'Transient network error. Retry may succeed.', confidence: 0.85, retryable: true }
  }

  // 7. API error — HTTP status codes (NEW, after timeout to avoid double-match on network errors)
  if (/429|500|502|503|rate limit|Too Many Requests|Bad Gateway|Internal Server Error|Service Unavailable/i.test(errorText)) {
    return { class: 'api_error', suggestion: 'Transient API error. Retry after cooldown.', confidence: 0.85, retryable: true }
  }

  // 8. Syntax/compilation errors (NEW)
  if (/SyntaxError|ParseError|unexpected token|Unexpected end of input|compilation error|Cannot find name|is not defined/.test(errorText)) {
    return { class: 'syntax_error', suggestion: 'Fix the syntax or reference error in the code.', confidence: 0.8, retryable: false }
  }

  // 9. Snapshot
  if (/snapshot/i.test(errorText) && (/diff/.test(errorText) || /mismatch/.test(errorText))) {
    return { class: 'snapshot', suggestion: 'Review snapshot diff. If change is intentional, update snapshots.', confidence: 0.85, retryable: false }
  }

  // 10. Environment missing
  if (/environment variable|ENV|env:/i.test(errorText) || /API key|secret|credential/i.test(errorText)) {
    return { class: 'env_missing', suggestion: 'Mark as blocked. Required environment or credentials are missing.', confidence: 0.8, retryable: false }
  }

  // 11. Assertion failure
  if (/\bassert|\bexpect\b|AssertionError|\bExpected\b|expected.*but got/.test(errorText) || /not ok \d+/.test(errorText)) {
    return { class: 'assertion', suggestion: 'Compare expected vs actual. Determine if test expectation is wrong or implementation is buggy before changing code.', confidence: 0.7, retryable: false }
  }

  // 12. Format error (NEW, near bottom — broadest format catch)
  if (/JSON[.\s]parse|malformed|Unterminated string|Unexpected end of JSON|Invalid character in JSON/i.test(errorText)) {
    return { class: 'format_error', suggestion: 'Model output was malformed. Retry with clearer format instructions.', confidence: 0.75, retryable: true }
  }

  // 13. Flaky
  if (/flaky|intermittent|sometimes|occasionally/.test(errorText)) {
    return { class: 'flaky', suggestion: 'Mark as potentially flaky. Run multiple times to confirm before treating as code bug.', confidence: 0.5, retryable: true }
  }

  return { class: 'unknown', suggestion: 'Read the full error output carefully. Identify the exact failure before attempting a fix.', confidence: 0.3, retryable: false }
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

const TRANSIENT_CLASSES: ReadonlySet<FailureClass> = new Set(['timeout', 'flaky', 'api_error'])

export function isTransient(failureClass: FailureClass): boolean {
  return TRANSIENT_CLASSES.has(failureClass)
}

export type FailureClass =
  | 'type_error'
  | 'assertion'
  | 'missing_dep'
  /** Runtime lifecycle gate (shutdown/handoff), not a model or code failure. */
  | 'runtime_gate'
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
  /** TDD test-run failures (run_tests tool) — expected RED step, not a code error. */
  | 'test_red'
  /** 只读探测工具对不存在路径的 not-found（A5 信号互扰治理 M3）——
   *  反幻影探针证实"不存在"是有效信息收集，不是认知失败，vigor 减罚 0.3。 */
  | 'probe_miss'

export interface ClassifiedFailure {
  class: FailureClass
  suggestion: string
  confidence: number  // 0-1
  retryable: boolean
}

/** Test-runner invocation patterns for bash commands. Kept conservative:
 *  a match reroutes assertion failures to test_red (zero vigor penalty),
 *  so false positives would mute real failures. */
const TEST_COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:node|tsx)\b[^\n|;&]*\s--test\b|\b(?:vitest|jest|mocha|pytest)\b|\bgo\s+test\b|\bcargo\s+test\b|\bplaywright\s+test\b/

/**
 * Whether a tool invocation is a test run — for TDD RED detection.
 * run_tests always is; bash counts when the command invokes a known
 * test runner (`npm test`, `npx tsx --test`, `pytest`, …). Without the
 * bash branch, TDD via bash still gets full vigor penalty (1b509acc gap).
 */
export function isTestRunInvocation(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (toolName === 'run_tests') return true
  if (toolName !== 'bash') return false
  const cmd = typeof input?.command === 'string' ? input.command : ''
  return TEST_COMMAND_PATTERN.test(cmd)
}

/** 只读探测类工具——not-found 失败走 probe_miss 减罚（A5/M3）。
 *  刻意不含 bash：`cat` 缺文件可能是构建/脚本的真失败，保守全额罚。 */
const READ_PROBE_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'glob', 'grep', 'list_dir', 'file_info',
])

/** Whether a tool invocation is a read-only probe — for probe_miss classification. */
export function isReadProbeInvocation(toolName: string): boolean {
  return READ_PROBE_TOOLS.has(toolName)
}

const NOT_FOUND_PATTERN = /ENOENT|File not found|no such file or directory|does not exist|Path not found/i

/** 结构化短路的每类别规范建议——与 classifyFailure 各分支文案对齐。
 *  工具自报 errorKind 时置信度 1.0（工具比正则更知道自己为何失败）。 */
const CANONICAL: Record<FailureClass, { suggestion: string; retryable: boolean }> = {
  type_error: { suggestion: 'Fix type annotation or interface. Do not change business logic.', retryable: false },
  assertion: { suggestion: 'Compare expected vs actual. Determine if test expectation is wrong or implementation is buggy before changing code.', retryable: false },
  missing_dep: { suggestion: 'Report missing dependency. Do not silently change the test command.', retryable: false },
  runtime_gate: { suggestion: 'Runtime lifecycle gate is active. Wait for shutdown/handoff to settle, then retry manually; do not change code.', retryable: false },
  timeout: { suggestion: 'Check for infinite loops, unawaited async, or slow operations. Consider increasing timeout.', retryable: true },
  snapshot: { suggestion: 'Review snapshot diff. If change is intentional, update snapshots.', retryable: false },
  module_resolution: { suggestion: 'Check import path, file existence, and package.json exports.', retryable: false },
  env_missing: { suggestion: 'Mark as blocked. Required environment or credentials are missing.', retryable: false },
  flaky: { suggestion: 'Mark as potentially flaky. Run multiple times to confirm before treating as code bug.', retryable: true },
  unknown: { suggestion: 'Read the full error output carefully. Identify the exact failure before attempting a fix.', retryable: false },
  permission_denied: { suggestion: 'Check file permissions or sandbox policy.', retryable: false },
  context_window_exceeded: { suggestion: 'Use /compact to reduce context, or start a new session.', retryable: false },
  api_error: { suggestion: 'Transient API error. Retry after cooldown.', retryable: true },
  syntax_error: { suggestion: 'Fix the syntax or reference error in the code.', retryable: false },
  format_error: { suggestion: 'Model output was malformed. Retry with clearer format instructions.', retryable: true },
  test_red: { suggestion: 'TDD RED — 这是预期中的测试红灯，实现代码后应转绿。', retryable: false },
  probe_miss: { suggestion: '探测确认路径不存在——这本身是有效信息，记录结论即可，不要重试同一路径。', retryable: false },
}

/** 从 ToolResult 的结构字段解析失败类别：errorKind 直读；
 *  bash 的 errorClass 三态桥接（timeout→timeout、environment→missing_dep）。
 *  exec-failure 不桥接——语义太宽，留给文本正则细分。 */
export function resolveErrorKind(
  result: { errorKind?: FailureClass; errorClass?: 'environment' | 'exec-failure' | 'timeout' } | undefined,
): FailureClass | undefined {
  if (!result) return undefined
  if (result.errorKind) return result.errorKind
  if (result.errorClass === 'timeout') return 'timeout'
  if (result.errorClass === 'environment') return 'missing_dep'
  return undefined
}

/**
 * 结构优先的工具失败分类（中文化第二波解耦层）。
 * 工具自报的 errorKind/errorClass 短路文本正则——消息文案中文化后
 * classifyFailure 的英文模式会失灵，结构字段是失效防线。
 * 无结构信号时回退 classifyFailure(content) 文本匹配，行为不变。
 */
export function classifyToolFailure(
  result: { errorKind?: FailureClass; errorClass?: 'environment' | 'exec-failure' | 'timeout' } | undefined,
  content: string,
  opts?: { isTestRun?: boolean; isReadProbe?: boolean },
): ClassifiedFailure {
  const kind = resolveErrorKind(result)
  if (kind) {
    const c = CANONICAL[kind]
    return { class: kind, suggestion: c.suggestion, confidence: 1, retryable: c.retryable }
  }
  return classifyFailure(content, opts)
}

export function classifyFailure(
  errorText: string,
  opts?: { isTestRun?: boolean; isReadProbe?: boolean },
): ClassifiedFailure {
  // Priority order: most specific patterns first

  // 0. 反幻影探针脱靶（A5/M3）：只读探测对不存在路径的 not-found 是信息收集
  //（证实"不存在"），不是认知失败——此前落 unknown 全额罚 vigor，
  // 系统一边教"读前探测"一边罚探测行为。
  if (opts?.isReadProbe && NOT_FOUND_PATTERN.test(errorText)) {
    return { class: 'probe_miss', suggestion: '探测确认路径不存在——这本身是有效信息，记录结论即可，不要重试同一路径。', confidence: 0.85, retryable: false }
  }

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

  // 11. Assertion failure — run_tests 来源走 test_red（TDD RED 是预期中的，不扣分）
  if (/\bassert|\bexpect\b|AssertionError|\bExpected\b|expected.*but got/.test(errorText) || /not ok \d+/.test(errorText)) {
    if (opts?.isTestRun) {
      return { class: 'test_red', suggestion: 'TDD RED — 这是预期中的测试红灯，实现代码后应转绿。', confidence: 0.9, retryable: false }
    }
    return { class: 'assertion', suggestion: 'Compare expected vs actual. Determine if test expectation is wrong or implementation is buggy before changing code.', confidence: 0.7, retryable: false }
  }

  // 12. Format error (near bottom — broadest format catch)
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

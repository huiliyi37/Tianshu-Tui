/**
 * Command-aware output filters for common tools.
 * Compresses verbose tool output to preserve context budget.
 *
 * Design: docs/superpowers/plans/2026-05-24-token-optimization-scout-findings.md
 */

interface CommandFilter {
  match: RegExp
  filter: (raw: string, exitCode: number) => string | null
}

const ERROR_LINE_RE = /error|error TS\d+|FAIL|failed|✖|✗|AssertionError/i
const PASS_LINE_RE = /✓|✔|pass|ok\s/i

/**
 * Filter tsc output: keep only error lines.
 * tsc outputs all files then errors; we just need the error summary.
 */
function filterTsc(raw: string, exitCode: number): string | null {
  if (exitCode === 0) {
    // No errors — extract just the "Found X errors" line or return empty
    const match = raw.match(/Found \d+ errors?\b/)
    return match ? match[0] : 'tsc: no errors'
  }
  const lines = raw.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (ERROR_LINE_RE.test(line) || line.includes('error TS')) {
      kept.push(line)
    }
  }
  // Add summary line if present
  const summary = raw.match(/Found \d+ errors?/)
  if (summary) kept.push(summary[0])
  return kept.length > 0 ? kept.join('\n') : null
}

/**
 * Filter node:test output: keep only failed test lines and summary.
 * Passing tests are noise; failures are what the agent needs to fix.
 */
function filterNodeTest(raw: string, exitCode: number): string | null {
  if (exitCode === 0) {
    // Extract just the summary line
    const match = raw.match(/\d+ passed.*\d+ failed/)
    return match ? match[0] : 'tests: all passed'
  }
  const lines = raw.split('\n')
  const kept: string[] = []
  let inFailBlock = false
  for (const line of lines) {
    if (ERROR_LINE_RE.test(line) || /not ok \d+/.test(line)) {
      inFailBlock = true
      kept.push(line)
    } else if (inFailBlock && (line.startsWith('  ') || line.startsWith('\t'))) {
      // Keep indented details after failure line
      kept.push(line)
    } else if (PASS_LINE_RE.test(line)) {
      inFailBlock = false
      // skip passing tests
    } else {
      inFailBlock = false
    }
  }
  return kept.length > 0 ? kept.join('\n') : null
}

const GIT_HINT_RE = /^\s+\(use "/

/**
 * Filter git status: remove hint lines (redundant for agent).
 */
function filterGitStatus(raw: string, _exitCode: number): string | null {
  const lines = raw.split('\n')
  const kept = lines.filter(l => !GIT_HINT_RE.test(l) && l.trim() !== '')
  return kept.length > 0 ? kept.join('\n') : null
}

const FILTERS: CommandFilter[] = [
  { match: /\btsc\b/, filter: filterTsc },
  { match: /\bnpm\s+test\b|node\s+--test|npx\s+tsx\s+--test/, filter: filterNodeTest },
  { match: /\bgit\s+status\b/, filter: filterGitStatus },
]

/**
 * Apply command-aware filter to tool output.
 * Returns compressed output if a filter matches, or null if no filter applies.
 */
export function applyCommandFilter(command: string, raw: string, exitCode: number): string | null {
  for (const f of FILTERS) {
    if (f.match.test(command)) {
      return f.filter(raw, exitCode)
    }
  }
  return null
}

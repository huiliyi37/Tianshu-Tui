/**
 * Command-aware output filter. Returns filtered output, or null when no filter
 * matches the given command (caller falls back to original raw output).
 *
 * P1: Command-Aware filtering — applied in buildModelOutput and directly in
 * bash.ts for commands whose raw output is noisy but semantically simple.
 */
export function applyCommandFilter(
  command: string,
  stdout: string,
  exitCode: number,
): string | null {
  const cmd = command.trim()

  // tsc --noEmit
  if (/\btsc\b/.test(cmd) && cmd.includes('--noEmit')) {
    return filterTsc(stdout, exitCode)
  }

  // node:test / tsx --test
  if (/\b(node|tsx|npx\s+tsx)\b/.test(cmd) && cmd.includes('--test')) {
    return filterNodeTest(stdout, exitCode)
  }

  // git status
  if (/^git\s+status\b/.test(cmd)) {
    return filterGitStatus(stdout)
  }

  return null
}

// ── tsc --noEmit ────────────────────────────────────────────────────────────

function filterTsc(stdout: string, exitCode: number): string {
  if (exitCode === 0) {
    // Keep the "Found 0 errors" summary line if present; otherwise synthesize
    const summary = stdout.match(/Found\s+0\s+errors?\.?/i)
    return summary ? summary[0] : '✓ typecheck passed'
  }

  const lines = stdout.split('\n')
  const kept: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    // Keep lines that contain "error TS" (the actual diagnostics)
    if (/\berror\s+TS\d+:/i.test(trimmed)) {
      // Strip path prefix: everything before "error TS"
      const errStart = trimmed.search(/\berror\s+TS\d+:/i)
      kept.push(errStart > 0 ? trimmed.slice(errStart) : trimmed)
    }
    // Keep the summary footer: "Found N error(s)."
    if (/^Found\s+\d+\s+error/i.test(trimmed)) {
      kept.push(trimmed)
    }
  }

  return kept.length > 0 ? kept.join('\n') : stdout.trim()
}

// ── node:test (tsx --test / node --test) ────────────────────────────────────

function filterNodeTest(stdout: string, exitCode: number): string {
  const lines = stdout.split('\n')

  if (exitCode === 0) {
    // Keep summary line(s) with passed/failed counts
    const summary = lines.filter(l => /\d+\s+passed/.test(l))
    return summary.length > 0 ? summary.join('\n') : stdout.trim()
  }

  // Failure: keep only failing test details + summary
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (
      /^not ok\b/.test(trimmed) ||
      /\bAssertionError\b/.test(trimmed) ||
      /\d+\s+passed/.test(trimmed) ||
      /\d+\s+failed/.test(trimmed)
    ) {
      kept.push(trimmed)
    }
  }

  return kept.length > 0 ? kept.join('\n') : stdout.trim()
}

// ── git status ──────────────────────────────────────────────────────────────

function filterGitStatus(stdout: string): string {
  const lines = stdout.split('\n')
  const filtered = lines.filter(line => {
    const trimmed = line.trim()
    // Remove git hint lines: "(use \"git ...\")" or "(git ...)"
    if (/^\(use\s+"git\s/.test(trimmed)) return false
    if (/^\(git\s/.test(trimmed)) return false
    return true
  })
  return filtered.join('\n')
}

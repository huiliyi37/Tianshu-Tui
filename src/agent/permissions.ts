export interface PermissionAllowRule {
  tool: string
  params?: Record<string, string>
}

export interface BashAllowlistConfig {
  /** Command prefixes that bypass bash-write approval.
   *  "git status" matches "git status", "git status --porcelain", etc. */
  allowlist: string[]
}

export interface PermissionConfig {
  allow: PermissionAllowRule[]
  /** Optional bash command allowlist — commands starting with any of these prefixes
   *  bypass bash-write approval in all modes (including auto-safe/manual). */
  bash?: BashAllowlistConfig
}

/** Characters that are NOT matched by the `*` wildcard in permission patterns.
 *  Prevents cross-token matching: `git status*` must NOT match
 *  `git status&&curl evil` — the wildcard must not cross shell operators.
 *  Mirrors SHELL_OPERATOR_RE character set (whitespace excluded so normal
 *  args like `--short` still match). */
const WILDCARD_EXCLUDE = `[^&|;<>()$\\x60\\\\!"']`

function patternMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, `${WILDCARD_EXCLUDE}*`)
  return new RegExp(`^${escaped}$`).test(value)
}

function paramsMatch(expected: Record<string, string> | undefined, actual: Record<string, unknown>): boolean {
  if (!expected) return true

  return Object.entries(expected).every(([key, pattern]) => {
    const value = actual[key]
    return typeof value === 'string' && patternMatches(pattern, value)
  })
}

export function isToolAllowed(toolName: string, input: Record<string, unknown>, rules: readonly PermissionAllowRule[] | undefined): boolean {
  if (!rules?.length) return false

  return rules.some(rule => patternMatches(rule.tool, toolName) && paramsMatch(rule.params, input))
}

/** Extract the first token (command binary) from a bash command for allowlist learning.
 *  "git add ." → "git", "npx tsx --test" → "npx" */
export function extractBashPrefix(command: string): string {
  const trimmed = command.trimStart()
  if (!trimmed) return ''
  const spaceIdx = trimmed.indexOf(' ')
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
}

/** Learn a bash command prefix into the session allowlist after user approval.
 *  Creates the bash config if needed; deduplicates to avoid unbounded growth. */
export function learnBashPrefix(command: string, permissions: PermissionConfig | undefined): void {
  if (!permissions || typeof command !== 'string') return
  const prefix = extractBashPrefix(command)
  if (!prefix) return
  if (!permissions.bash) permissions.bash = { allowlist: [] }
  if (!permissions.bash.allowlist.includes(prefix)) {
    permissions.bash.allowlist.push(prefix)
  }
}

/** Characters that terminate a shell token or start a shell operator.
 *  Used to verify the command contains no shell metacharacters after the
 *  allowlisted prefix. */
const SHELL_OPERATOR_RE = /[&|;<>()$\x60\\!"']/

/** Check if a bash command matches an allowlisted command safely.
 *  For single-word entries ("npx"): the entire command must consist of only
 *  the command name followed by plain arguments — no shell operators/metacharacters.
 *  For multi-word entries ("git status"): the command must start with the entry
 *  followed by a space/tab or end of string — no shell operators.
 *
 *  This prevents bypass via shell chaining: "npx && rm -rf /" is rejected
 *  even when "npx" is allowlisted, because "&&" is a shell operator. */
export function isBashCommandAllowlisted(command: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist?.length) return false
  const trimmed = command.trimStart()
  if (!trimmed) return false
  return allowlist.some(entry => {
    if (!trimmed.startsWith(entry)) return false
    if (entry.includes(' ')) {
      // Multi-word: "git status" matches "git status --porcelain" but NOT "git status&&rm"
      if (trimmed.length === entry.length) return true
      const nextChar = trimmed[entry.length]
      if (nextChar !== ' ' && nextChar !== '\t') return false
      // Check remainder for shell operators — same guard as single-word path
      const remainder = trimmed.slice(entry.length)
      return !SHELL_OPERATOR_RE.test(remainder)
    }
    // Single-word: match the first token exactly AND verify the rest
    // of the command contains no shell operators.
    const nextChar = trimmed[entry.length]
    if (nextChar === undefined) return true   // exact match
    if (nextChar !== ' ' && nextChar !== '\t') return false  // "npxfoo" must not match "npx"
    // Check that the remainder after the first token has no shell operators
    const remainder = trimmed.slice(entry.length)
    return !SHELL_OPERATOR_RE.test(remainder)
  })
}

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

function patternMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
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
      return trimmed.length === entry.length ||
        trimmed[entry.length] === ' ' ||
        trimmed[entry.length] === '\t'
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

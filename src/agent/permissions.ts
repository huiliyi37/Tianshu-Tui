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

/** Check if a bash command starts with any allowlisted prefix. */
export function isBashCommandAllowlisted(command: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist?.length) return false
  const trimmed = command.trimStart()
  return allowlist.some(prefix => trimmed.startsWith(prefix))
}

export interface PermissionAllowRule {
  tool: string
  params?: Record<string, string>
}

export interface PermissionConfig {
  allow: PermissionAllowRule[]
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

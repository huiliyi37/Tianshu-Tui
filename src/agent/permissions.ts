export interface PermissionAllowRule {
  tool: string
  params?: Record<string, string>
}

export interface PermissionConfig {
  allow: PermissionAllowRule[]
  /** Deny rules override allow rules and approval mode. */
  deny: PermissionAllowRule[]
  /** Optional bash command allowlist/denylist. */
  bash?: BashPermissionsConfig
}

export interface BashPermissionsConfig {
  /** Command prefixes that bypass bash-write approval. */
  allowlist: string[]
  /** Command prefixes that are always blocked. */
  denylist: string[]
}

/** Runtime permission overrides that apply only to the current session. */
export interface PermissionOverlay {
  allow: PermissionAllowRule[]
  deny: PermissionAllowRule[]
  bashAllow: string[]
  bashDeny: string[]
}

export function createPermissionOverlay(): PermissionOverlay {
  return { allow: [], deny: [], bashAllow: [], bashDeny: [] }
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

/** Check whether a tool call matches any deny rule. */
export function isToolDenied(toolName: string, input: Record<string, unknown>, rules: readonly PermissionAllowRule[] | undefined): boolean {
  return isToolAllowed(toolName, input, rules)
}

/** Check whether a bash command matches any denylist prefix. */
export function isBashCommandDenied(command: string, denylist: readonly string[] | undefined): boolean {
  return isBashCommandAllowlisted(command, denylist)
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
  if (!permissions.bash) permissions.bash = { allowlist: [], denylist: [] }
  if (!permissions.bash.allowlist.includes(prefix)) {
    permissions.bash.allowlist.push(prefix)
  }
}

/** Learn a file-scoped allow rule into the session overlay after user approval,
 *  so subsequent identical edits to the SAME file don't re-prompt within the
 *  session. Mirrors learnBashPrefix for write tools; dedupes to bound growth.
 *  The path is stored verbatim — permission patterns treat non-`*` characters
 *  as literals (see patternMatches), so an exact path matches only itself. */
export function learnFileApproval(
  toolName: string,
  filePath: string,
  overlay: PermissionOverlay | undefined,
): void {
  if (!overlay || !filePath) return
  const exists = overlay.allow.some(r => r.tool === toolName && r.params?.file_path === filePath)
  if (!exists) overlay.allow.push({ tool: toolName, params: { file_path: filePath } })
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

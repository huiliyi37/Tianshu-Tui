/**
 * Shared static guard for computer-use script execution (macOS JXA eval,
 * Windows PowerShell Invoke-Expression). Blocks known destructive /
 * exfiltration primitives before a script reaches the interpreter.
 *
 * Defense in depth — scripts are template-generated with escaped params
 * today, but a future template bug must not be able to run `rm`, `curl`,
 * `Remove-Item`, etc.
 *
 * Limitation: cannot distinguish a string literal ("rm -rf" typed into a
 * terminal) from executable code, so keystroke/type paths share this check.
 *
 * Start-Process is deliberately NOT in the table: the Windows launchApp
 * template relies on it to start applications.
 */

const BASE_PATTERNS = [
  /\b(?:rm|unlink|mv|cp|curl|wget|nc|telnet|ssh|scp)\b/,
  /\bNSWorkspace\b/,
  /\bdoShellScript\b/,
  /\bapp\.open\b/,
]

/** PowerShell equivalents of the destructive primitives (windows-driver). */
const PS_PATTERNS = [
  /\bInvoke-Expression\b/,
  /\bInvoke-WebRequest\b/,
  /\bRemove-Item\b/,
  /\bMove-Item\b/,
  /\bCopy-Item\b/,
  /\bSet-Content\b/,
]

const DANGEROUS_PATTERNS = [...BASE_PATTERNS, ...PS_PATTERNS]

export function hasDangerousPatterns(code: string): string | null {
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(code)) return `blocked dangerous pattern: ${re.source}`
  }
  return null
}

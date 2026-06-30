import { buildNotFoundHint, extractMissingCommand } from './env-check.js'

/**
 * Windows shell (PowerShell / cmd.exe) error-output denoiser.
 *
 * PowerShell renders errors as multi-line blocks: the human message, then
 * `At line:N char:N` with caret/tilde underlines, then `+ CategoryInfo : ...`
 * and `+ FullyQualifiedErrorId : ...`, all wrapped in ANSI color. Dumping the
 * whole block into the tool result both pollutes the model's context and
 * amplifies the "this failed catastrophically" feeling — which on Windows tanks
 * confidence and triggers intent-approval (低信念 → 不敢做事).
 *
 * This keeps the core human-readable message, drops the structured noise, and
 * for command-not-found prepends a concise recovery hint so the model switches
 * tools instead of blindly retrying the same command.
 *
 * Host-gated by the caller (bash.ts) to win32 only; never touches POSIX output.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

const NOISE_LINE_PATTERNS = [
  /^\s*\+\s*CategoryInfo\s*:/i,
  /^\s*\+\s*FullyQualifiedErrorId\s*:/i,
  /^\s*At line:\d+ char:\d+/i,
  /^\s*\+?\s*[~^]+\s*$/, // caret/tilde underline rows (PowerShell prefixes them with "+ ")
  /^\s*\+\s*$/, // lone "+" continuation marker
]

export interface WindowsErrorContext {
  exitCode: number
  errorClass?: 'environment' | 'exec-failure'
  command: string
}

function recoveryHint(body: string, command: string): string {
  const name = extractMissingCommand(body, command)
  const lower = name.toLowerCase()
  if (lower === 'python' || lower === 'python3') {
    return `命令未找到：'${name}' → Windows 上用 'py'（Python launcher），不要重试同一条命令`
  }
  const installHint = buildNotFoundHint(name, 'win32')
  if (installHint) {
    return `命令未找到：'${name}'${installHint}`
  }
  return `命令未找到：'${name}' → 此环境不可识别该命令，换用可用工具/跨平台命令，不要重试同一条`
}

/**
 * Denoise a failing Windows shell result. Success output (exit 0) is returned
 * byte-for-byte. Returns the original output if denoising would empty it.
 */
export function denoiseWindowsError(output: string, ctx: WindowsErrorContext): string {
  if (ctx.exitCode === 0) return output

  const stripped = output.replace(ANSI_RE, '')
  const lines = stripped.split('\n')
  const kept = lines.filter(l => !NOISE_LINE_PATTERNS.some(p => p.test(l)))
  const removedNoise = kept.length < lines.length

  // Nothing to do: not command-not-found and no noise removed → leave as-is
  // (only the harmless ANSI strip applies).
  if (!removedNoise && ctx.errorClass !== 'environment') {
    return stripped === output ? output : stripped
  }

  // Collapse blank-line runs left behind by noise removal.
  const compact: string[] = []
  for (const l of kept) {
    if (l.trim() === '' && (compact[compact.length - 1]?.trim() ?? '') === '') continue
    compact.push(l)
  }
  let body = compact.join('\n').trim()

  if (ctx.errorClass === 'environment') {
    const hint = recoveryHint(body, ctx.command)
    body = body ? `${hint}\n${body}` : hint
  }

  return body || output
}

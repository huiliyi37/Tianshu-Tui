import { existsSync, readFileSync } from 'node:fs'
import { findProjectConfig } from './manager.js'
import { verifySchema, type VerifyConfig } from './schema.js'

/**
 * Load the project-declared verify commands (A1) directly from the nearest
 * `.rivet-config.json`, without pulling in the full layered config.
 *
 * Why a standalone loader: consumers are tool-layer modules (run_tests,
 * deliver review gate, bash verification annotation) that only receive `cwd`
 * — threading the full Config through 5 layers of deps for one field is not
 * worth it, and worker sessions get correct behavior for free. The `verify`
 * block is inherently project-scoped, so the project layer alone is
 * authoritative (no user-global fallback on purpose).
 *
 * Memoized per project-config path; call {@link invalidateVerifyConfig} after
 * writing the file (e.g. /init) so the same session picks up new declarations.
 */
const memo = new Map<string, VerifyConfig>()

export function loadDeclaredVerify(cwd: string): VerifyConfig {
  const path = findProjectConfig(cwd)
  if (!path || !existsSync(path)) return {}
  const cached = memo.get(path)
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { verify?: unknown }
    const parsed = verifySchema.parse(raw.verify ?? {})
    memo.set(path, parsed)
    return parsed
  } catch {
    return {}
  }
}

/** Drop the memo so freshly written declarations take effect mid-session. */
export function invalidateVerifyConfig(): void {
  memo.clear()
}

/** Classify a bash command against the declared verify commands.
 *  Returns the matching kind when the command starts with a declared command
 *  string (trimmed) — used to annotate verification evidence with structured
 *  semantics instead of regex guesses. */
export function classifyDeclaredCommand(
  cmd: string,
  verify: VerifyConfig,
): 'test' | 'build' | 'typecheck' | 'lint' | undefined {
  const c = cmd.trim()
  for (const kind of ['test', 'build', 'typecheck', 'lint'] as const) {
    const declared = verify[kind]?.trim()
    if (declared && (c === declared || c.startsWith(declared + ' '))) return kind
  }
  return undefined
}

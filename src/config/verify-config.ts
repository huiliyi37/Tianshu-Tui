import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import { findProjectConfig } from './manager.js'
import { verifySchema, type VerifyConfig } from './schema.js'
import { isProjectTrusted, notifyUntrustedOnce } from './project-trust.js'

/** A path-routed verify route after schema parsing. */
export type VerifyRoute = NonNullable<VerifyConfig['routes']>[number]

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
  // 信任门：声明命令是仓库内容驱动的执行通道（runDeclaredCheck 会真实 spawn）。
  // 未授信项目返回空声明——与 loadConfig Layer 3 的 verify 剥离同一语义。
  // 不缓存未授信结果：/trust 授信后无需 invalidate 即刻生效。
  const projectDir = dirname(path)
  if (!isProjectTrusted(projectDir)) {
    notifyUntrustedOnce('config', projectDir)
    return {}
  }
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

/** Convert a route glob to a RegExp anchored on the full POSIX path:
 *  `**` spans segments; `**` immediately before a `/` additionally matches
 *  zero segments (minimatch semantics — `**.css`-style patterns hit files at
 *  the root too); `*` stays within one segment; `?` matches one char.
 *  Dependency-free on purpose — no glob lib in the dependency tree.
 *  (Comment wording avoids the literal double-star-slash sequence, which
 *  would terminate this block comment early.) */
function routeGlobToRegex(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '__DSTARSL__')
    .replace(/\*\*/g, '__DSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__DSTARSL__/g, '(?:.*/)?')
    .replace(/__DSTAR__/g, '.*')
  return new RegExp(`^${re}$`)
}

/** Return the deduped routes whose `match` glob hits at least one changed
 *  file. Paths are compared as repo-relative POSIX; absolute paths are
 *  skipped (same convention as the typecheck gate). */
export function matchVerifyRoutes(
  changedFiles: readonly string[],
  routes: readonly VerifyRoute[] | undefined,
): VerifyRoute[] {
  if (!routes || routes.length === 0) return []
  const files = changedFiles.filter(f => !isAbsolute(f)).map(f => f.split('\\').join('/'))
  if (files.length === 0) return []
  const seen = new Set<string>()
  const out: VerifyRoute[] = []
  for (const route of routes) {
    const key = `${route.match}${route.run}`
    if (seen.has(key)) continue
    let re: RegExp
    try {
      re = routeGlobToRegex(route.match)
    } catch {
      continue // malformed glob — skip the route, never throw into the gate
    }
    if (files.some(f => re.test(f))) {
      seen.add(key)
      out.push(route)
    }
  }
  return out
}

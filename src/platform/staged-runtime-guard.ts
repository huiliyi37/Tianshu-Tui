/**
 * staged-runtime-guard — refuse to start on a `dist/` whose staged native/wasm
 * payload was wiped, and self-heal the case where healing is safe.
 *
 * Why this exists (2026-08-04 留痕):
 *   `tsup` runs with `clean: true`, which empties `dist/` but leaves the
 *   `dist/node_modules` directory skeleton behind. `npm run build` is only the
 *   first link of the packaging chain — `pack-native.js` and
 *   `stage-runtime-deps.js` re-populate that tree — so a bare build leaves
 *   65 directories holding zero files.
 *
 *   That shape is worse than having no directory at all. Node resolves a bare
 *   specifier against the first `node_modules` containing a matching directory
 *   and does NOT continue upward when the directory turns out to be unusable,
 *   so an empty `dist/node_modules/web-tree-sitter` *shadows* the perfectly good
 *   `<repo>/node_modules/web-tree-sitter`. Measured directly:
 *     - staged payload present  → resolves
 *     - no dist/node_modules    → resolves via the parent node_modules
 *     - empty skeleton          → ERR_MODULE_NOT_FOUND
 *
 *   The consequence was silent: meridian-index failed 303 times across
 *   2026-08-03/04 and the runtime hook pipeline's error isolation swallowed
 *   every one of them, so tree-sitter parsing, ast-grep, the typescript LSP
 *   fallback and better-sqlite3 were all degraded with no user-visible signal.
 *
 * Policy: heal when a parent `node_modules` can cover every empty package
 * (the in-repo development shape), otherwise fail closed (the packaged shape,
 * where deleting the skeleton would not make anything resolvable).
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type StagedRuntimeInspection =
  | { action: 'ok'; emptyPackages: [] }
  | { action: 'heal'; emptyPackages: string[]; healableFrom: string }
  | { action: 'fatal'; emptyPackages: string[] }

/** True when `dir` holds at least one file at any depth. */
function hasAnyFile(dir: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  const subdirs: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) subdirs.push(full)
      else return true
    } catch {
      /* races with a concurrent staging run are not our problem */
    }
  }
  return subdirs.some(hasAnyFile)
}

/** Package dirs directly under `modulesDir`, expanding `@scope/` one level. */
function packageDirs(modulesDir: string): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = []
  let entries: string[]
  try {
    entries = readdirSync(modulesDir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const full = join(modulesDir, entry)
    try {
      if (!statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    if (entry.startsWith('@')) {
      let scoped: string[]
      try {
        scoped = readdirSync(full)
      } catch {
        continue
      }
      for (const sub of scoped) {
        const subFull = join(full, sub)
        try {
          if (statSync(subFull).isDirectory()) out.push({ name: `${entry}/${sub}`, dir: subFull })
        } catch {
          /* ignore */
        }
      }
      continue
    }
    out.push({ name: entry, dir: full })
  }
  return out
}

/** Nearest ancestor `node_modules` above `distDir` that holds real packages. */
function findParentModules(distDir: string): string | null {
  let cur = dirname(distDir)
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, 'node_modules')
    if (existsSync(candidate)) return candidate
    const next = dirname(cur)
    if (next === cur) break
    cur = next
  }
  return null
}

/**
 * Classify the staged runtime tree under `distDir` without touching disk state.
 * Pure and total — any fs error degrades to `ok` rather than blocking startup.
 */
export function inspectStagedRuntime(distDir: string): StagedRuntimeInspection {
  const modulesDir = join(distDir, 'node_modules')
  if (!existsSync(modulesDir)) return { action: 'ok', emptyPackages: [] }

  const empty = packageDirs(modulesDir)
    .filter(p => !hasAnyFile(p.dir))
    .map(p => p.name)
  if (empty.length === 0) return { action: 'ok', emptyPackages: [] }

  // Healing only helps when resolution can actually succeed after the skeleton
  // is gone, i.e. every shadowed package exists (with payload) further up.
  const parent = findParentModules(distDir)
  if (parent) {
    const coveredByParent = empty.every(name => {
      const candidate = join(parent, name)
      return existsSync(candidate) && hasAnyFile(candidate)
    })
    if (coveredByParent) return { action: 'heal', emptyPackages: empty, healableFrom: parent }
  }
  return { action: 'fatal', emptyPackages: empty }
}

const RECOVERY = 'node scripts/pack-native.js && node scripts/stage-runtime-deps.js'

/**
 * Enforce the policy at startup. Heals in place when safe; exits non-zero when
 * the bundle cannot resolve its native dependencies at all.
 *
 * @param distDir directory holding the running bundle
 * @param exit process exit hook (injectable for tests)
 */
export function assertStagedRuntimeIntact(
  distDir: string,
  exit: (code: number) => never = process.exit as (code: number) => never,
): void {
  if (process.env.RIVET_SKIP_STAGED_RUNTIME_CHECK === '1') return

  let result: StagedRuntimeInspection
  try {
    result = inspectStagedRuntime(distDir)
  } catch {
    return // never let the guard itself block startup
  }
  if (result.action === 'ok') return

  if (result.action === 'heal') {
    try {
      for (const name of result.emptyPackages) {
        rmSync(join(distDir, 'node_modules', name), { recursive: true, force: true })
      }
      console.warn(
        `[rivet] dist/node_modules 有 ${result.emptyPackages.length} 个空包目录（tsup clean 残留），`
          + `已移除以恢复上层 node_modules 解析。完整随包依赖请跑：${RECOVERY}`,
      )
      return
    } catch {
      // fall through to the fatal path — an unremovable skeleton still shadows
    }
  }

  console.error('[rivet] 启动中止：dist 的原生/wasm 依赖未随包分发，继续运行会静默降级。')
  console.error(`  空包目录（${result.emptyPackages.length}）：${result.emptyPackages.slice(0, 8).join(', ')}`)
  console.error(`  受影响：meridian(tree-sitter) / ast-grep / typescript LSP / better-sqlite3`)
  console.error(`  修复：${RECOVERY}`)
  console.error('  跳过此检查（不推荐）：RIVET_SKIP_STAGED_RUNTIME_CHECK=1')
  exit(1)
}

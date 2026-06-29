#!/usr/bin/env node
/**
 * stage-runtime-deps.js — copy the unbundlable runtime packages into
 * `dist/node_modules/` so the packaged sidecar can resolve them.
 *
 * Why this exists:
 *   tsup inlines pure-JS deps, but a handful of packages can't be inlined —
 *   native addons (.node), wasm loaders/grammars, and esbuild's Go binary —
 *   so the sidecar loads them at runtime via `import()` / `createRequire()`.
 *   Without a shipped `node_modules` those lookups fail once the .app is
 *   installed outside the repo. We stage the dependency *closure* of each
 *   root package (flat layout) next to the bundle.
 *
 * Platform note: esbuild / @ast-grep list every platform binary as an
 *   optionalDependency, but npm only installs the host one. We copy "what's
 *   actually installed", so the staged tree is naturally host-arch-specific —
 *   matching the bundled Node runtime fetched for the same target.
 *
 * better-sqlite3: we stage ONLY the pure-JS wrapper (lib/ + package.json), NOT
 * the full ~27MB package. The native binary is shipped separately by
 * pack-native.js into dist/native/, and native-resolver loads the wrapper with
 * `{ nativeBinding: <dist/native/better_sqlite3.node> }` — so `bindings`,
 * `prebuild-install` and build/Release are unnecessary. This is the zero-degrade
 * path: the bundled sidecar gets the REAL Database API (prepare/pragma/
 * transaction), never a NullDatabase no-op. A load assertion at the end fails
 * the build if the wrapper + packed .node don't round-trip.
 *
 * Idempotent. Run after `npm run build` (tsup `clean` wipes dist) and after
 * pack-native.js.
 */
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const srcModules = join(repoRoot, 'node_modules')
const destModules = join(repoRoot, 'dist', 'node_modules')

// Root packages that must be resolvable at runtime in the packaged sidecar.
const ROOTS = [
  'esbuild', // syntax-check JS/TS parser (native Go binary)
  'typescript', // in-process tsc LSP fallback
  '@ast-grep/napi', // structural search / ast-edit (native addon)
  '@ast-grep/lang-json',
  '@ast-grep/lang-python',
  'web-tree-sitter', // tree-sitter chunker (wasm loader)
  'tree-sitter-wasms', // grammar .wasm files (loaded by path)
]

function pkgDir(name) {
  // Flat (hoisted) layout: node_modules/<name>. Scoped names keep the slash.
  const dir = join(srcModules, name)
  return existsSync(join(dir, 'package.json')) ? dir : null
}

function readDeps(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]
  } catch {
    return []
  }
}

if (existsSync(destModules)) rmSync(destModules, { recursive: true, force: true })
mkdirSync(destModules, { recursive: true })

const visited = new Set()
const queue = [...ROOTS]
const missing = []
let copied = 0

while (queue.length > 0) {
  const name = queue.shift()
  if (visited.has(name)) continue
  visited.add(name)

  const src = pkgDir(name)
  if (!src) {
    // Optional/platform packages for other hosts are not installed — skip quietly
    // unless it's a declared root (then surface it).
    if (ROOTS.includes(name)) missing.push(name)
    continue
  }

  const dest = join(destModules, name)
  mkdirSync(dirname(dest), { recursive: true })
  // dereference symlinks so the staged tree is self-contained.
  cpSync(src, dest, { recursive: true, dereference: true })
  copied++

  for (const dep of readDeps(src)) queue.push(dep)
}

function dirSizeMb(dir) {
  let bytes = 0
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else bytes += st.size
    }
  }
  if (existsSync(dir)) walk(dir)
  return Math.round(bytes / 1024 / 1024)
}

if (missing.length > 0) {
  console.error('⚠ stage-runtime-deps: missing root packages (features will degrade): %s', missing.join(', '))
}
console.log('✅ Staged %d runtime packages (%dMB) → dist/node_modules', copied, dirSizeMb(destModules))

// ── better-sqlite3: lean JS wrapper + zero-degrade load assertion ──
stageBetterSqlite3Wrapper()

function stageBetterSqlite3Wrapper() {
  const src = pkgDir('better-sqlite3')
  if (!src) {
    console.error('✗ stage-runtime-deps: better-sqlite3 not found in node_modules — cannot stage wrapper')
    process.exit(1)
  }
  const dest = join(destModules, 'better-sqlite3')
  mkdirSync(dest, { recursive: true })
  // Only the pure-JS wrapper: lib/ + package.json (main → lib/index.js).
  // Deliberately NOT copying build/Release, bindings, prebuild-install — the
  // native binary is loaded via nativeBinding from dist/native/.
  cpSync(join(src, 'lib'), join(dest, 'lib'), { recursive: true, dereference: true })
  cpSync(join(src, 'package.json'), join(dest, 'package.json'))
  console.log('✅ Staged better-sqlite3 JS wrapper (lib + package.json, %dKB) → dist/node_modules/better-sqlite3', Math.round(dirSizeMb(dest) * 1024) || 1)

  if (process.env.STAGE_SKIP_SQLITE_CHECK === '1') {
    console.warn('⚠ STAGE_SKIP_SQLITE_CHECK=1 — skipping better-sqlite3 zero-degrade assertion')
    return
  }
  const nodeBin = join(repoRoot, 'dist', 'native', 'better_sqlite3.node')
  if (!existsSync(nodeBin)) {
    console.error('✗ stage-runtime-deps: %s missing — run pack-native.js before stage-runtime-deps', nodeBin)
    process.exit(1)
  }
  // The staged wrapper + packed .node MUST load and round-trip. A failure means
  // the bundle would silently fall back to NullDatabase at runtime — refuse to
  // ship a silently-degrading product (escape hatch: STAGE_SKIP_SQLITE_CHECK=1).
  try {
    const require = createRequire(import.meta.url)
    const Database = require(dest)
    const db = new Database(':memory:', { nativeBinding: nodeBin })
    db.exec('CREATE TABLE __probe (x)')
    db.prepare('INSERT INTO __probe VALUES (?)').run(1)
    const n = db.prepare('SELECT COUNT(*) AS c FROM __probe').get().c
    db.close()
    if (n !== 1) throw new Error(`roundtrip mismatch: expected 1, got ${n}`)
    console.log('✅ stage-runtime-deps: better-sqlite3 wrapper + native load assertion passed (zero-degrade)')
  } catch (e) {
    console.error('✗ stage-runtime-deps: better-sqlite3 wrapper failed to load with packed .node — refusing to ship a silently-degrading bundle.')
    console.error('  Reason:', e && e.message ? e.message : e)
    console.error('  Escape hatch (NOT for release): STAGE_SKIP_SQLITE_CHECK=1')
    process.exit(1)
  }
}

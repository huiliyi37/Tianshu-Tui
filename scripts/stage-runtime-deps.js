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
 * better-sqlite3 is intentionally NOT staged here: pack-native.js already
 * ships its .node into dist/native/ (leaner than the full 27MB package).
 *
 * Idempotent. Run after `npm run build` (tsup `clean` wipes dist) and after
 * pack-native.js.
 */
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

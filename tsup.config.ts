import { defineConfig, type Options } from 'tsup'
import { builtinModules } from 'node:module'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { SCAN_ALLOWED, RUNTIME_BUNDLED, verifyConsistency } from './scripts/external-deps.js'

const require = createRequire(import.meta.url)
const pkgJson = require('./package.json') as { version: string; scripts?: Record<string, string> }
const pkgVersion = pkgJson.version
// Used by onSuccess to tell "tsup ran standalone" from "tsup is step 1 of a
// chain that stages the runtime payload next".
const pkgScripts = pkgJson.scripts ?? {}

// 强制内联的纯 JS 依赖（不进 dist/node_modules）。与 RUNTIME_BUNDLED 互斥——
// 单一数据源不变量 3（exceljs 曾同时出现在 noExternal 与 ROOTS，2026-08-10 收敛）。
const FORCE_BUNDLED = [
  'string-width',
  'get-east-asian-width',
  'chalk',
  'ink',
  'react',
  'diff',
  'undici',
  'zod',
  '@modelcontextprotocol/sdk',
  'turndown',
  'pixelmatch',
  'pngjs',
]

// 构建期自检：外部依赖清单漂移在构建时 fail loud，而不是发布后缺包。
verifyConsistency()
{
  const overlap = FORCE_BUNDLED.filter((n) => RUNTIME_BUNDLED.includes(n))
  if (overlap.length > 0) {
    throw new Error(`tsup: noExternal 与 RUNTIME_BUNDLED 重叠: ${overlap.join(', ')} — 见 scripts/external-deps.js 不变量 3`)
  }
}

// src/pro/index.ts 作为独立 entry：闭源模块产物 dist/pro/index.js，供
// loadProModule 的 dist 形态候选路径加载（桌面 sidecar 运行时）。
// 条件存在：公开仓经 sync 同步后没有 src/pro/（--exclude 'pro/'），
// 硬编码 entry 会让开源构建报 entry not found——存在才加入。
const proEntry = existsSync('src/pro/index.ts') ? ['src/pro/index.ts'] : []
// pro computer-use 同理：产物 dist/pro/computer-use/index.js，供
// tools/computer-use/bridge.ts 的 dist 形态候选路径加载。
const proComputerUseEntry = existsSync('src/pro/computer-use/index.ts') ? ['src/pro/computer-use/index.ts'] : []

// better-sqlite3 is kept `external` (below) and never imported as a bare
// specifier at runtime — the live consumers (session-registry, meridian-db) load
// it through `src/repo/native-resolver.ts`, which in the packaged sidecar binds
// the staged JS wrapper (dist/node_modules/better-sqlite3) to the packed native
// binary (dist/native/better_sqlite3.node) via better-sqlite3's `nativeBinding`
// option. No esbuild plugin / NullDatabase shim is needed.

export default defineConfig({
  // src/pro/index.ts 作为独立 entry：闭源模块产物 dist/pro/index.js，
  // 供 loadProModule 的 dist 形态候选路径加载（桌面 sidecar 运行时）。
  entry: ['src/main.ts', 'src/workers/cpu-worker.ts', ...proEntry, ...proComputerUseEntry],
  format: ['esm'],
  target: 'node24',
  // Inject the package version as a build-time constant so the packaged sidecar
  // (spawned by Rust as `node main.js serve`, no npm env) reports the real
  // version in /health instead of a hardcoded fallback.
  define: {
    'process.env.RIVET_VERSION': JSON.stringify(pkgVersion),
  },
  // dts:false — 声明文件对 CLI 运行毫无用处，且 Windows 上对 100+ 文件生成 .d.ts
  // 会静默崩溃（exit=1 无任何报错）。若将来需要发布 npm 包，改为 true。
  dts: false,
  clean: true,
  shims: true,
  treeshake: false,
  // Ship runtime-assets/ alongside the bundle: contents are copied into dist/ so
  // dist/bundled-skills/ sits next to main.js. skill-loader.bundledSkillsDir()
  // resolves it relative to the emitted module and seeds it into each project's
  // .rivet/skills on load. Keep this in sync with that resolver.
  publicDir: 'runtime-assets',
  // Ship seed capsules with the bundle: copy docs/seed-capsule-*.md into
  // dist/seed-capsules/ so npm / desktop users (whose install dir has no docs/)
  // get the star-lore capsules out of the box. seed-capsule-store.bundledCapsulesDir()
  // resolves this relative to the emitted module. docs/ stays the single source of
  // truth (also synced to the public repo); this is a build-time copy, not a duplicate.
  async onSuccess() {
    const { readdirSync, mkdirSync, copyFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')

    // Hard gate: the bundled skills MUST reach dist/ or the packaged desktop app
    // ships with only the 2 hardcoded built-ins. publicDir copies
    // runtime-assets/bundled-skills → dist/bundled-skills; if that silently no-ops
    // (renamed/missing source, publicDir change) we refuse to ship. Mirrors the
    // better-sqlite3 zero-degrade assertion in stage-runtime-deps.js.
    {
      const bundledSrc = join('runtime-assets', 'bundled-skills')
      const bundledDest = join('dist', 'bundled-skills')
      const srcCount = existsSync(bundledSrc)
        ? readdirSync(bundledSrc).filter(f => !f.startsWith('_')).length
        : 0
      const destCount = existsSync(bundledDest)
        ? readdirSync(bundledDest).filter(f => !f.startsWith('_')).length
        : 0
      if (srcCount === 0) {
        console.error('[tsup] ✗ runtime-assets/bundled-skills is missing or empty — the app would ship with no default skills.')
        process.exit(1)
      }
      if (destCount < srcCount) {
        console.error(`[tsup] ✗ dist/bundled-skills has ${destCount} entries but source has ${srcCount} — publicDir copy did not complete. Refusing to ship a skill-less bundle.`)
        process.exit(1)
      }
      console.log(`[tsup] ✅ bundled ${destCount} default skill(s) → dist/bundled-skills/`)
    }

    try {
      const files = readdirSync('docs').filter(f => /^seed-capsule-.+\.md$/.test(f))
      if (files.length === 0) return
      const dest = join('dist', 'seed-capsules')
      mkdirSync(dest, { recursive: true })
      for (const f of files) copyFileSync(join('docs', f), join(dest, f))
      console.log(`[tsup] bundled ${files.length} seed-capsule(s) → dist/seed-capsules/`)
    } catch (err) {
      console.warn('[tsup] seed-capsule bundling skipped:', (err as Error).message)
    }

    // `clean: true` wipes the staged native/wasm payload but leaves the directory
    // skeleton, so `node dist/main.js` still starts and then silently degrades:
    // meridian (tree-sitter), ast-grep, the typescript LSP fallback and
    // better-sqlite3 all fail to resolve. That shape ran unnoticed for two days
    // (2026-08-03/04, 303 meridian-index failures swallowed by hook isolation).
    //
    // onSuccess runs at the end of the *tsup* step, so under `npm run build` the
    // payload is legitimately still missing — pack-native and stage-runtime-deps
    // are the next two links in that chain. Ask npm which script invoked us and
    // read its command: if the caller re-stages, staying quiet is correct, and
    // warning would send someone chasing a problem that fixes itself one line
    // later. Reaching the warning means tsup ran on its own — `npm run dev`
    // (watch), `build:bundle`, or a bare `npx tsup` — and that dist is fine to
    // *bundle-test*, unfit to *run*.
    //
    // Deriving this from the script body rather than a name list keeps it honest
    // when the chain is renamed. Restaging here is deliberately not an option:
    // under a cross-arch packaging run (`TAURI_ENV_TARGET_TRIPLE` set)
    // pack-native downloads a foreign-arch prebuild, and no watch rebuild should
    // trigger a download.
    try {
      const { verifyStagedRuntime } = await import('./scripts/staged-runtime-verify.js')
      const staged = verifyStagedRuntime('dist')
      const caller = process.env.npm_lifecycle_event
      const callerScript = caller ? (pkgScripts[caller] ?? '') : ''
      const callerRestages = callerScript.includes('stage-runtime-deps')
      if (!staged.ok && !callerRestages) {
        console.warn('[tsup] ⚠ dist/node_modules 载荷为空 — 原生/wasm 依赖不可解析')
        console.warn('[tsup]   直接 node dist/main.js 会静默降级：meridian(tree-sitter)/ast-grep/typescript LSP/better-sqlite3')
        console.warn('[tsup]   要可运行的产物请跑 `npm run build`（tsup + pack-native + stage-runtime-deps）')
      }
    } catch (err) {
      console.warn('[tsup] staged-runtime check skipped:', (err as Error).message)
    }
  },
  // tsup externalizes every package.json dependency by default. For a packaged
  // sidecar (no node_modules shipped) that's fatal: pure-JS deps left as bare
  // imports crash with ERR_MODULE_NOT_FOUND at startup. Force-bundle them here.
  // Only genuinely unbundlable modules stay external: node: builtins, esbuild
  // (native, lazily required in syntax-check), and the native/wasm packages that
  // are dynamically imported behind feature gates (better-sqlite3 via
  // native-resolver, @ast-grep/*, web-tree-sitter, tree-sitter-wasms, typescript).
  // 单一数据源：scripts/external-deps.js 的 SCAN_ALLOWED（随包分发 + 惰性
  // 解析全集）+ node builtins。Bare-specifier builtins（assert/fs 等）也
  // externalize，避免 esbuild 把 CJS 依赖内部 require('assert') 路由到抛错的
  // __require shim（undici 曾命中）。node: 形式由 /^node:/ 覆盖。
  external: [...SCAN_ALLOWED, /^node:/, ...builtinModules],
  noExternal: FORCE_BUNDLED,
  esbuildPlugins: [],
  // platform:node makes esbuild externalize bare node builtin requires (e.g.
  // undici's internal `require('assert')`) instead of emitting a throwing
  // __require shim — required to bundle CJS node libs into the ESM output.
  esbuildOptions(options) {
    options.platform = 'node'
    // Per-file banner (applies to every chunk, not just the entry). Bundled CJS
    // deps (undici, turndown, …) call `require()` internally; in ESM output
    // esbuild routes those through a __require shim that throws unless a real
    // `require` is in scope. createRequire gives each chunk one. The shebang
    // stays on the entry for direct CLI exec (node strips it from imported
    // modules) and carries the GC/heap flags.
    options.banner = {
      js: "#!/usr/bin/env -S node --expose-gc --max-old-space-size=4096\nimport { createRequire as __rivetCreateRequire } from 'node:module'; const require = __rivetCreateRequire(import.meta.url);",
    }
  },
} satisfies Options)

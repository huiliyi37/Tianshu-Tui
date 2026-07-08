import { defineConfig, type Options } from 'tsup'
import { builtinModules } from 'node:module'

// better-sqlite3 is kept `external` (below) and never imported as a bare
// specifier at runtime — the live consumers (session-registry, meridian-db) load
// it through `src/repo/native-resolver.ts`, which in the packaged sidecar binds
// the staged JS wrapper (dist/node_modules/better-sqlite3) to the packed native
// binary (dist/native/better_sqlite3.node) via better-sqlite3's `nativeBinding`
// option. No esbuild plugin / NullDatabase shim is needed.

export default defineConfig({
  entry: ['src/main.ts', 'src/workers/cpu-worker.ts'],
  format: ['esm'],
  target: 'node24',
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
  },
  // tsup externalizes every package.json dependency by default. For a packaged
  // sidecar (no node_modules shipped) that's fatal: pure-JS deps left as bare
  // imports crash with ERR_MODULE_NOT_FOUND at startup. Force-bundle them here.
  // Only genuinely unbundlable modules stay external: node: builtins, esbuild
  // (native, lazily required in syntax-check), and the native/wasm packages that
  // are dynamically imported behind feature gates (better-sqlite3 via
  // native-resolver, @ast-grep/*, web-tree-sitter, tree-sitter-wasms, typescript).
  external: [
    'esbuild',
    /^node:/,
    // Bare-specifier node builtins (e.g. `assert`, `fs`) so esbuild externalizes
    // them instead of routing CJS deps' internal `require('assert')` through a
    // throwing __require shim (undici hit exactly this). node: forms covered above.
    ...builtinModules,
    'better-sqlite3',
    '@ast-grep/napi',
    '@ast-grep/lang-json',
    '@ast-grep/lang-python',
    'web-tree-sitter',
    'tree-sitter-wasms',
    'typescript',
    // Optional dev-only devtools dependency of ink; not installed and only
    // reached when DEV devtools are enabled. Keep it external so bundling ink
    // doesn't fail on the missing module.
    'react-devtools-core',
    // Optional Office docx reader (npm i mammoth for .docx support without LibreOffice)
    'mammoth',
  ],
  noExternal: [
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
  ],
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

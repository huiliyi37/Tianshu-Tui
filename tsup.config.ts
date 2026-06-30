import { defineConfig, type Options } from 'tsup'
import { builtinModules } from 'node:module'

// better-sqlite3 is kept `external` (below) and never imported as a bare
// specifier at runtime — the live consumers (session-registry, meridian-db) load
// it through `src/repo/native-resolver.ts`, which in the packaged sidecar binds
// the staged JS wrapper (dist/node_modules/better-sqlite3) to the packed native
// binary (dist/native/better_sqlite3.node) via better-sqlite3's `nativeBinding`
// option. No esbuild plugin / NullDatabase shim is needed.

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
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
  ],
  noExternal: [
    'string-width',
    'get-east-asian-width',
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
      js: "#!/usr/bin/env -S node --expose-gc --max-old-space-size=1536\nimport { createRequire as __rivetCreateRequire } from 'node:module'; const require = __rivetCreateRequire(import.meta.url);",
    }
  },
} satisfies Options)

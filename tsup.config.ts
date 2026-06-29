import { defineConfig, type Options } from 'tsup'
import { builtinModules } from 'node:module'

/**
 * esbuild plugin: makes better-sqlite3 a runtime-optional dependency.
 *
 * The virtual module does a runtime require('better-sqlite3') inside try/catch.
 * If the native module is not installed, it returns a NullDatabase class that
 * implements the same interface (prepare, exec, pragma, close, transaction)
 * as no-ops. This way `new Database(path)` never throws, regardless of whether
 * better-sqlite3 is installed.
 *
 * Why a class proxy instead of null? Because esbuild tree-shakes null checks
 * on static imports. The source code's `if (!Database)` and `try/catch` get
 * stripped in the bundle. By always providing a valid constructor, we avoid
 * "Database is not a constructor" at runtime.
 */
const optionalNativeModulePlugin = {
  name: 'optional-native-module',
  setup(build: any) {
    build.onResolve({ filter: /^better-sqlite3$/ }, (args: any) => ({
      path: args.path,
      namespace: 'optional-native',
    }))
    build.onLoad({ filter: /.*/, namespace: 'optional-native' }, () => ({
      contents: [
        '// Runtime loader for optional native module better-sqlite3',
        '// Resolution order: native/ dir → node_modules → NullDatabase',
        'var NativeDB = null;',
        'try {',
        '  var { createRequire } = require("node:module");',
        '  var { fileURLToPath } = require("node:url");',
        '  var { dirname, join } = require("node:path");',
        '  var { existsSync } = require("node:fs");',
        '',
        '  // 1. Try native/ directory adjacent to this module (production bundle)',
        '  var selfPath = fileURLToPath(import.meta.url);',
        '  var selfDir = dirname(selfPath);',
        '  var nativePath = join(selfDir, "native", "better_sqlite3.node");',
        '  if (existsSync(nativePath)) {',
        '    var nativeRequire = createRequire(nativePath + "/");',
        '    NativeDB = nativeRequire("./better_sqlite3.node");',
        '  }',
        '',
        '  // 2. Fallback: try node_modules',
        '  if (!NativeDB) {',
        '    NativeDB = createRequire(import.meta.url)("better-sqlite3");',
        '  }',
        '} catch (e) {',
        '  // better-sqlite3 not installed — NullDatabase will be used',
        '}',
        '',
        '// No-op statement that mimics better-sqlite3 Statement API',
        'var noopStmt = {',
        '  run: function() { return { changes: 0, lastInsertRowid: 0 }; },',
        '  all: function() { return []; },',
        '  get: function() { return undefined; },',
        '};',
        '',
        '// NullDatabase: drop-in replacement when better-sqlite3 is unavailable.',
        '// All DB operations silently succeed — features degrade gracefully.',
        'function NullDatabase() {}',
        'NullDatabase.prototype.prepare = function() { return noopStmt; };',
        'NullDatabase.prototype.exec = function() {};',
        'NullDatabase.prototype.pragma = function() {};',
        'NullDatabase.prototype.close = function() {};',
        'NullDatabase.prototype.transaction = function(fn) { return fn; };',
        '',
        '// Export the real constructor if available, otherwise the null proxy',
        'var Database = NativeDB || NullDatabase;',
        'export default Database;',
      ].join('\n'),
    }))
  },
}

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
  // tsup externalizes every package.json dependency by default. For a packaged
  // sidecar (no node_modules shipped) that's fatal: pure-JS deps left as bare
  // imports crash with ERR_MODULE_NOT_FOUND at startup. Force-bundle them here.
  // Only genuinely unbundlable modules stay external: node: builtins, esbuild
  // (native, lazily required in syntax-check), and the native/wasm packages that
  // are dynamically imported behind feature gates (better-sqlite3 via the plugin,
  // @ast-grep/*, web-tree-sitter, tree-sitter-wasms, typescript).
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
  esbuildPlugins: [optionalNativeModulePlugin],
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

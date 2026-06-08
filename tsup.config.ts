import { defineConfig, type Options } from 'tsup'

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
        'var NativeDB = null;',
        'try {',
        '  var { createRequire } = require("node:module");',
        '  NativeDB = createRequire(import.meta.url)("better-sqlite3");',
        '} catch (e) {',
        '  // better-sqlite3 not installed — NullDatabase will be used',
        '}',
        '',
        '// No-op statement that mimics better-sqlite3 Statement API',
        'var noopStmt = {',
        '  run: function() {},',
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
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node22',
  // dts:false — 声明文件对 CLI 运行毫无用处，且 Windows 上对 100+ 文件生成 .d.ts
  // 会静默崩溃（exit=1 无任何报错）。若将来需要发布 npm 包，改为 true。
  dts: false,
  clean: true,
  shims: true,
  treeshake: true,
  external: ['esbuild', /^node:/],
  esbuildPlugins: [optionalNativeModulePlugin],
  banner: {
    js: '#!/usr/bin/env -S node --expose-gc --max-old-space-size=1536',
  },
} satisfies Options)

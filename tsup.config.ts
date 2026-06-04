import { defineConfig, type Options } from 'tsup'

/**
 * esbuild plugin: makes better-sqlite3 a runtime-optional dependency.
 *
 * Problem: esbuild detects createRequire()('better-sqlite3') and hoists it
 * to a static ESM import at the top of the bundle. If the module isn't
 * installed (e.g. Windows without C++ build tools), the static import
 * crashes the process immediately on startup — before any try/catch can fire.
 *
 * Solution: this plugin intercepts the resolution of 'better-sqlite3' and
 * provides a virtual module that does a safe runtime require inside try/catch.
 * The default export is the Database constructor, or null if unavailable.
 *
 * Source code (tsx dev mode): createRequire + try/catch works natively.
 * Bundled mode (dist/main.js): the plugin replaces the static import with
 * a runtime-safe virtual module that returns null instead of crashing.
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
        '// Returns Database constructor or null if unavailable',
        'var Database = null;',
        'try {',
        '  var { createRequire } = require("node:module");',
        '  Database = createRequire(import.meta.url)("better-sqlite3");',
        '} catch (e) {',
        '  // better-sqlite3 not installed — callers should use fallback',
        '}',
        'export default Database;',
      ].join('\n'),
    }))
  },
}

export default defineConfig({
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  shims: true,
  treeshake: true,
  // better-sqlite3 is handled by the plugin above (not external).
  // The plugin provides a virtual module that does runtime require with
  // try/catch, so the bundle doesn't crash if the module is missing.
  external: ['esbuild', /^node:/],
  esbuildPlugins: [optionalNativeModulePlugin],
  banner: {
    js: '#!/usr/bin/env -S node --expose-gc --max-old-space-size=1536',
  },
} satisfies Options)

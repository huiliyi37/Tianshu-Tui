import { defineConfig, type Options } from 'tsup'

export default defineConfig({
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  shims: true,
  treeshake: true,
  external: ['better-sqlite3', 'esbuild', /^node:/],
  banner: {
    js: '#!/usr/bin/env -S node --expose-gc --max-old-space-size=1536',
  },
} satisfies Options)

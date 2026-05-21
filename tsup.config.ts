import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  shims: true,
  treeshake: true,
  banner: {
    js: '#!/usr/bin/env -S node --expose-gc --max-old-space-size=1536',
  },
})
